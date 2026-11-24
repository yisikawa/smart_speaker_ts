# RVC（声質変換）対応案

最終更新: 2026-11-24 / 状態: **提案**（実装前）/ 前提: B 案（GPT-SoVITS）は成立済み

このドキュメントは `docs/TODO.md` の **1-6** を具体化した実装提案です。
`docs/TTS_MULTILINGUAL.md` §5 の「RVC の検証」を、実測にもとづいて実行可能な計画に落としました。

---

## 0. 結論（推奨案）

1. **自前の常駐ワーカー** `scripts/rvc_worker.py`（FastAPI）を作る
   - 起動時にモデルをロードし、**ウォームアップまで済ませる**
   - `POST /convert` で **base64 WAV を受けて base64 WAV を返す**（同期・直列）
   - 出力は **16kHz / 16bit / モノラル** に整える（口パク・VAD の前提）
2. **変換は文単位**（`TtsRouter.synthesize()` の後段）。理由は §3.1 の比較を参照
3. **RVC を既定 ON**（`tts.voice_conversion.enabled = true`）。B 案（GPT-SoVITS）の声を
   RVC で寄せる構成を標準にする（モデル未設定・ワーカー未起動なら自動でスキップして素の声で読む）
4. **画面から RVC モデルを切り替えるトグル**を追加する（§4 の `GET /api/models` の `rvc` +
   `PUT /api/models/rvc`）。切替時はワーカーに再ロードを指示する（2.6 秒 + 再ウォームアップ）
5. 失敗時は**元の WAV を返す**（無音にしない）＋ warn ログ
6. テストは **`imadaMio.pth` + `imadaMio_v2.index`**（`D:\LLMProjects\RVCMultilingual\models`）

---

## 1. 実測（2026-11-24 / RTX 3060 12GB / 赤丸のモデル）

変換元: GPT-SoVITS の日本語音声 5.06 秒（`logs/tts-spike/gsv-ja-2.wav`）

| 項目 | 結果 | 意味 |
|---|---|---|
| `load_model`（**index 付き**） | **2.59 秒** | 起動時に 1 回だけ払う |
| **1 回目の infer** | **22.7 秒** | HuBERT / RMVPE の遅延ロード。**ウォームアップ必須** |
| **2 回目以降** | **553〜572ms / RTF 0.11** | 変換自体は軽い |
| 出力 | **40kHz**（16kHz 入力） | 16kHz/16bit モノラルへ変換が必要 |
| VRAM（プロセス内ピーク） | **733MiB** | GPT-SoVITS 3.9GB と合わせて 4.6GB（12GB で余裕） |

**合計 RTF の見込み**: GPT-SoVITS 0.45 + RVC 0.11 ≈ **0.56**（先読み 2 文で隠せる範囲）。

---

## 2. なぜ既存の `RVCMultilingual`（`POST /rvc`）を使わないか

`RVCMultilingual/backend/routes/rvc.py` は要件に合いません。

| 既存実装 | 問題 |
|---|---|
| `job_id` を返して**非同期ジョブ**（結果はポーリング） | 会話の 1 文ごとに使えない |
| `rvc_input.wav` / `rvc_result.wav` の**固定ファイル名** | 同時発話・複数タブで競合する |
| **毎回** `AudioPipeline` → `RVCInference` を生成 | `load_model` 2.6 秒 + 初回 22.7 秒を**毎回**払う |
| `index_file` を設定に持つのに **`load_model` へ渡していない** | `index_rate` が効かない（index なしで変換される） |

→ **常駐 + バッファ入出力 + index 指定**を満たす小さなワーカーを新設します。

---

## 3. 全体設計

```
[TurnRunner] 文ごとに
   └─ TtsRouter.synthesize(text)
        ├─ impl.synthesize()            … GPT-SoVITS / VOICEVOX / OpenAI 互換
        ├─ normalizeWav()               … 16bit PCM モノラルへ（既存）
        └─ VoiceConversionService       … tts.voice_conversion.enabled のとき
              └─ POST /convert（base64 WAV）
                    └─ rvc_worker.py（常駐・直列・ウォームアップ済み）
                          └─ rvc-python（RVCInference）
```

- 変換は**文単位**（`SpeechQueue` が 1 文ずつ呼ぶ）。`prefetch_depth=2` で先読み中に変換も進む
- ワーカーは **`RVCMultilingual/venv`** を使う（`fastapi` / `uvicorn` / `rvc-python` / `torch 2.5.1` 導入済み）
- Node 側は既存の `NormalizeWavOptions` と同じ流儀（失敗時は元を返す）

### 3.1 文単位 vs ターン単位（どちらで変換するか）

| 観点 | **文単位（採用）** | ターン単位 |
|---|---|---|
| **初声** | **約 1.85 秒**（24 字の合成 1.3s + 変換 0.55s） | **約 5〜12 秒**（全文合成 + 全文変換） |
| 変換回数 | 文の数（3 文なら 3 回） | 1 回 |
| 固定オーバーヘッド | 3 回 × 約 50ms = 150ms（HTTP + tempfile） | 50ms |
| 文間の待ち | **`prefetch_depth=2` で隠せる**（再生中に次を合成＋変換） | 発生しない（全部先に変換） |
| 声質の一貫性 | 文ごとに F0 推定（短い文は揺れやすい） | **完全に一貫**（長い音声で F0 が安定） |
| 中断（停止・バージイン） | **即座に止まる**（残りは変換しない） | 全文変換が終わるまで始められない |
| 実装 | `TtsRouter` の後段に足すだけ | 全文を連結して変換し、再分割する必要がある |

**数字の根拠**（実測）: GPT-SoVITS 24 字 = 1.3 秒 / 45 字 = 3.36 秒、RVC は 5.06 秒の音声で 0.55 秒（RTF 0.11）。
`max_sentence_chars = 24` は**約 5 秒の音声**になるため、RVC の F0 推定にも十分な長さ（品質面でも有利）。

**結論**: **文単位**。初声の差（1.85 秒 vs 5〜12 秒）が決定的で、会話では 5 秒の無音は成立しない。
ターン単位が有利なのは「録音・配信で品質最優先」「中断しない」場合なので、必要になったら
`tts.voice_conversion.mode = "turn"` を追加する（今回のスコープ外）。


---

## 4. 変更ファイル

| 種別 | パス | 内容 |
|---|---|---|
| 新規 | `scripts/rvc_worker.py` | 常駐ワーカー（FastAPI）。起動時に `load_model` + ウォームアップ |
| 新規 | `src/backend/services/VoiceConversionService.ts` | `POST /convert` を呼ぶ独立サービス |
| 変更 | `src/backend/services/TtsRouter.ts` | 正規化の**後段**で変換（`enabled` のときだけ） |
| 新規 | `tests/voice-conversion.test.ts` | スタブサーバーで成功・失敗・無効を検証 |
| 変更 | `config/settings.default.toml` | `[tts.voice_conversion]` のコメントにモデル例を追記 |
| 変更 | `scripts/spike-tts.js` | `--rvc` で変換込みの RTF を測れるようにする（任意） |
| 変更 | `docs/TTS_MULTILINGUAL.md` §5 | 手順と実測を追記 |
| 変更 | `src/backend/config/schema.ts` | `voice_conversion.enabled` の既定を **true** に。`models_dir` を追加 |
| 変更 | `src/shared/protocol.ts` | `ModelCatalog` に `rvc`（`current` / `models[]`）を追加 |
| 変更 | `src/backend/services/modelCatalog.ts` | `.pth` と `.index` の**ペア列挙**（純粋関数 + テスト） |
| 変更 | `src/backend/server/ApiRouter.ts` | `PUT /api/models/rvc`（設定保存 + ワーカーへ再ロード指示） |
| 変更 | `src/frontend/SettingsPanel.ts` | 「RVC モデル」セレクトと ON/OFF トグル |
| 新規 | `tests/rvc-model-catalog.test.ts` | ペアリング（`imadaMio.pth` ↔ `imadaMio_v2.index`）のテスト |

### 4.1 モデル切替の仕様

**既定**: `tts.voice_conversion.enabled = true`（RVC を標準構成にする）。
モデル未設定・ワーカー未起動なら**自動でスキップ**し、素の TTS の声で読む（警告 1 回）。

`GET /api/models` に追加する `rvc`:

```json
{
  "rvc": {
    "enabled": true,
    "current": { "modelPath": "D:\\LLMProjects\\RVCMultilingual\\models\\imadaMio.pth",
                 "indexPath": "D:\\LLMProjects\\RVCMultilingual\\models\\imadaMio_v2.index" },
    "models": [
      { "path": "...\\imadaMio.pth", "indexPath": "...\\imadaMio_v2.index", "label": "imadaMio", "sizeBytes": 55224320 }
    ]
  }
}
```

**ペアリング規則**（`modelCatalog.ts` の純粋関数）: `<name>.pth` に対して
`<name>.index` → `<name>_v2.index` → `<name>*.index` の順に探す（`imadaMio` は `_v2` のみ存在）。

**切替**: `PUT /api/models/rvc` `{ "modelPath": "...", "enabled": true }`
→ `tts.voice_conversion.model_path` / `enabled` を保存し、ワーカーへ `POST /model` で再ロードを指示する。
再ロードは 2.6 秒 + 再ウォームアップ（22.7 秒）なので、**画面は「読み込み中」を出して `/health` の
`warm=true` を待つ**（次の発話から新しい声）。


## 5. API 仕様（ワーカー）

`POST /convert`

```json
{ "wav_base64": "<16bit PCM モノラルの WAV>", "pitch": 0, "f0_method": "rmvpe", "index_rate": 0.75 }
```

→ `200 { "ok": true, "wav_base64": "...", "sampleRate": 16000, "durationMs": 5040 }`

`GET /health`

```json
{ "ok": true, "model": "imadaMio.pth", "index": "imadaMio_v2.index", "warm": true, "device": "cuda" }
```

- 変換は**直列**（`ThreadPoolExecutor(max_workers=1)`）。GPU を 1 タスクで占有する
- 一時ファイルは `tempfile.NamedTemporaryFile(suffix=".wav")`（**固定名を使わない**）
- 出力（40kHz）は librosa で 16kHz へリサンプルし、16bit PCM モノラルで返す
- 起動時に **1 回ダミー変換**して `warm=true` にする（22.7 秒を起動時に吸収）

`POST /model`（モデル切替）

```json
{ "model": "...\\imadaMio.pth", "index": "...\\imadaMio_v2.index" }
```

→ `200 { "ok": true, "warm": false }`（バックグラウンドで再ロード + 再ウォームアップし、
`/health` が `warm=true` になったら使える）。切替中は `503` を返し、Node 側は素の声へフォールバックする。


## 6. 実装ステップ（TDD）

1. **`VoiceConversionService` のテストを先に書く**（スタブサーバー）
   - 200 + base64 → Buffer が返る
   - 500 / タイムアウト / 非 WAV → **元の WAV を返す**（`onError` 通知）
   - `enabled=false` では呼ばれない（`TtsRouter` 側）
2. `VoiceConversionService.ts` を実装（`fetch` + `AbortSignal.timeout`）
3. `TtsRouter.synthesize()` に組み込む（`normalizeWav` の後）
4. `scripts/rvc_worker.py` を実装（起動時ロード + ウォームアップ + `/health`）
5. `scripts/spike-tts.js --rvc` で**変換込みの RTF** を測る
6. `docs/TTS_MULTILINGUAL.md` §5 に手順と実測を追記、`AGENTS.md` に 12-17 を追加

---

## 7. テスト計画（赤丸のモデル: `imadaMio.pth` + `imadaMio_v2.index`）

```powershell
# 1) ワーカー起動（ウォームアップ込みで 30〜40 秒かかる）
D:\LLMProjects\RVCMultilingual\venv\Scripts\python.exe scripts\rvc_worker.py `
  --model D:\LLMProjects\RVCMultilingual\models\imadaMio.pth `
  --index D:\LLMProjects\RVCMultilingual\models\imadaMio_v2.index `
  --port 9890

# 2) 状態確認（warm=true になるまで待つ）
curl http://127.0.0.1:9890/health

# 3) 変換込みの実測（GPT-SoVITS → RVC）
npm run spike:tts -- --rvc

# 4) アプリで確認（tts.voice_conversion.enabled = true にして再起動）
```

確認すること:

- [ ] `warm=true` まで 30〜40 秒（初回 22.7 秒を起動時に吸収）
- [ ] 変換込み RTF < 0.7（ja / en）
- [ ] 出力 WAV が 16kHz / 16bit / モノラル（`isPcm16MonoWav` が true）
- [ ] `volumes` が空でない（口パク）
- [ ] 声が imadaMio になっている（聴いて確認）
- [ ] 画面の「RVC モデル」で切り替えると、再ロード後に声が変わる
- [ ] `enabled=false` にすると素の TTS の声に戻る
- [ ] ワーカーを止めても**無音にならず**、素の声で読む

## 8. リスクと対策

| リスク | 対策 |
|---|---|
| **声の権利** | `imadaMio` は**実在の人物の声**を学習したモデル。**ローカル検証に限定**し、録音・動画・配信で**公開しない**。README と docs に明記し、公開用途は自分の声か許諾済みの音声に差し替える |
| 初回 22.7 秒 | 起動時ウォームアップ。`/health` が `warm=true` を返すまでアプリを使わない |
| 40kHz 出力 | ワーカーで 16kHz/16bit モノラルへ変換（`buildVolumeEnvelope` の前提） |
| VRAM +0.7GB | 合計 4.6GB（Ollama + whisper + GPT-SoVITS + RVC）。12GB で余裕。厳しければ `stt.engine=sherpa` |
| 固定ファイル名 | `tempfile` を使う（同時発話・複数タブで競合させない） |
| 変換失敗 | 元の WAV を返す + warn（`normalizeWav` と同じ方針。無音にしない） |
| RTF +0.11 | 合計 0.56。`prefetch_depth=2` と `max_sentence_chars=24` で隠す |
| `weights_only` 制限 | ワーカー起動時に `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1`（実測で確認済み） |
| venv の分離 | RVC は `RVCMultilingual/venv`（numpy 1.23 / torch 2.5.1）。**GPT-SoVITS の venv とは別プロセス**にする |

## 9. 受け入れ条件

- [ ] `tts.voice_conversion.enabled = true` で**読み上げの声が変わる**
- [ ] **既定で RVC が有効**（`enabled = true`）。ワーカー未起動でも素の声で動く（無音にしない）
- [ ] 画面のトグルで**モデルを切り替えられ**、再ロード後に声が変わる
- [ ] 変換込みの **RTF < 0.7**（ja / en）
- [ ] 出力が 16bit PCM モノラルで `volumes` が空でない
- [ ] 変換失敗時も**無音にならない**（元の WAV にフォールバック）
- [ ] `npm run verify` が緑（スタブを使ったテストで担保）
- [ ] 権利の注意が `README.md` と `docs/TTS_MULTILINGUAL.md` にある

## 10. 見積りと分割

| ステップ | 内容 | 見積 |
|---|---|---|
| 1 | `VoiceConversionService` + テスト | 0.5 日 |
| 2 | `TtsRouter` 統合 + 回帰 | 0.25 日 |
| 3 | `rvc_worker.py`（常駐・ウォームアップ・16kHz 化・`POST /model`） | 0.75 日 |
| 4 | **モデル列挙（ペアリング）+ `GET /api/models` の `rvc` + `PUT /api/models/rvc`** | 0.5 日 |
| 5 | **設定 UI（「RVC モデル」セレクト + ON/OFF トグル）** | 0.5 日 |
| 6 | `spike:tts --rvc` と実測・docs | 0.5 日 |
| 7 | 権利の注意・README 更新 | 0.25 日 |
| **合計** | | **3.25 日** |

## 11. 代替案（採用しない）

| 案 | 不採用の理由 |
|---|---|
| `RVCMultilingual` の `POST /rvc` をそのまま使う | ジョブベース・固定ファイル名・毎回モデルロード・index 未指定（§2） |
| `venv-gsv` に `rvc-python` を入れて 1 プロセスに統合 | `rvc-python` は `numpy<=1.25.3` / torch 2.5 系前提。GPT-SoVITS（numpy<2 / torch 2.7）と衝突しやすい。**実績のある venv を分ける方が安全** |
| ワーカーを Node で書く | RVC は Python 実装のみ（`rvc-python`）。Node から直接呼べない |
| 変換を `TtsRouter` ではなく `TurnRunner` に置く | 文単位の変換は TTS の責務。`TurnRunner` は「どの順で何をするか」だけを持つ方針（AGENTS 12-4） |


