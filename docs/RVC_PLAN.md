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
2. Node 側は `VoiceConversionService` を追加し、**`TtsRouter.synthesize()` の後段**に挟む
   （`tts.voice_conversion.enabled = true` のときだけ）
3. 失敗時は**元の WAV を返す**（無音にしない）＋ warn ログ
4. テストは **`imadaMio.pth` + `imadaMio_v2.index`**（`D:\LLMProjects\RVCMultilingual\models`）

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
| 3 | `rvc_worker.py`（常駐・ウォームアップ・16kHz 化） | 0.5 日 |
| 4 | `spike:tts --rvc` と実測・docs | 0.5 日 |
| 5 | 権利の注意・README 更新 | 0.25 日 |
| **合計** | | **2 日** |

## 11. 代替案（採用しない）

| 案 | 不採用の理由 |
|---|---|
| `RVCMultilingual` の `POST /rvc` をそのまま使う | ジョブベース・固定ファイル名・毎回モデルロード・index 未指定（§2） |
| `venv-gsv` に `rvc-python` を入れて 1 プロセスに統合 | `rvc-python` は `numpy<=1.25.3` / torch 2.5 系前提。GPT-SoVITS（numpy<2 / torch 2.7）と衝突しやすい。**実績のある venv を分ける方が安全** |
| ワーカーを Node で書く | RVC は Python 実装のみ（`rvc-python`）。Node から直接呼べない |
| 変換を `TtsRouter` ではなく `TurnRunner` に置く | 文単位の変換は TTS の責務。`TurnRunner` は「どの順で何をするか」だけを持つ方針（AGENTS 12-4） |


