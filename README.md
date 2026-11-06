# Sumika TypeScript

ローカル完結型 AI 音声アシスタント（バックエンド・フロントエンドともに TypeScript）。

- 音声認識: whisper.cpp
- 応答生成: Ollama
- 音声合成: VOICEVOX
- 音声・テキストは**外部クラウドへ送信しません**（すべて localhost で完結）

設計書:

- [docs/DESIGN.md](docs/DESIGN.md) — 再設計前の現状設計書（As-Is）
- [docs/REDESIGN.md](docs/REDESIGN.md) — 再設計書（To-Be / アーキテクチャ・プロトコル・VAD・移行手順）
- [docs/REFACTORING_PLAN.md](docs/REFACTORING_PLAN.md) — リファクタリング計画（フェーズ・優先度・完了条件）
- [AGENTS.md](AGENTS.md) — 作業メモリー（コマンド・規約・ハマりどころ・現状の TODO）

## 必要なもの

| 項目 | 説明 |
|------|------|
| Node.js | v18 以上（開発は v22 で確認） |
| Ollama | LLM 推論サーバー（既定 `http://127.0.0.1:11434`） |
| VOICEVOX ENGINE | 音声合成サーバー（既定 `http://127.0.0.1:50021`） |
| whisper.cpp + ggml モデル | `whisper.cpp/main.exe`（CUDA 版推奨）と `models/ggml-large-v3-turbo*.bin` |
| ffmpeg / ffplay | `audio.input_mode = "server"` のときの録音・再生（既定はブラウザ入力なので ffmpeg 不要） |
| マイク | ブラウザから利用（`getUserMedia`。localhost または https で開くこと） |
| NVIDIA GPU（任意） | CUDA 版 whisper.cpp を使う場合のみ（VRAM 4GB 以上推奨） |

## セットアップ

```powershell
npm install
npm run build          # clean → tsc → フロントエンド静的ファイルのコピー
```

Windows では `scripts\setup.bat` でも可。

Ollama のモデルを取得しておきます（設定の `llm.model` と一致させる）:

```powershell
ollama pull <model-name>
```

### whisper.cpp を CUDA 版にする（NVIDIA GPU がある場合・推奨）

```powershell
# CUDA 版（cuBLAS 同梱ビルド）を取得して差し替え。既存の CPU 版は whisper.cpp\_cpu-backup に退避されます
powershell -ExecutionPolicy Bypass -File scripts\setup-whisper-cuda.ps1

# 元の CPU 版へ戻す
powershell -ExecutionPolicy Bypass -File scripts\setup-whisper-cuda.ps1 -Restore
```

- 取得元: `whisper.cpp` の GitHub Releases（b5130 / `whisper-cublas-12.4.0-bin-x64.zip`）。CUDA ランタイム DLL も同梱されるため、CUDA Toolkit は不要（NVIDIA ドライバのみ必要）。
- 1.9 系では `main.exe` が廃止され `whisper-cli.exe` に統合されています。スクリプトは既存の設定（`stt.binary_path = whisper.cpp/main.exe`）を壊さないよう、`whisper-cli.exe` を `main.exe` としても配置します。
- 動作確認:

  ```powershell
  .\whisper.cpp\main.exe --version        # ggml_cuda_init: found 1 CUDA devices ... と表示されれば OK
  # 認識の動作確認（任意の WAV を 16kHz 相当で渡す）
  .\whisper.cpp\main.exe -m models\ggml-large-v3-turbo-q5_0.bin -f <WAVファイル> -l ja -otxt -of logs\gpu-test -fa
  ```

#### 速度の実測値（GTX 1650 Max-Q 4GB / large-v3-turbo / 3 秒の音声）

| 構成 | 1 発話あたり | 備考 |
|------|--------------|------|
| CPU 版 + f16 | 約 25 秒 | 差し替え前 |
| CUDA 版 + f16 | 約 8.4 秒 | VRAM 約 1.6GB |
| CUDA 版 + q5_0 | **約 3.5 秒** | VRAM 約 0.55GB・認識結果は f16 と同一 |

- 初回の 1 回だけ CUDA カーネルの JIT で 10〜20 秒余分にかかります（2 回目以降はキャッシュされ高速になります）。
- VRAM が 4GB クラスの場合、f16（1.6GB）は他のアプリと競合しやすいため **q5_0 を推奨**します。

  ```powershell
  .\whisper.cpp\whisper-quantize.exe models\ggml-large-v3-turbo.bin models\ggml-large-v3-turbo-q5_0.bin q5_0
  ```

  生成後、`config/settings.toml` の `stt.model_path` を `models/ggml-large-v3-turbo-q5_0.bin` に変更します（本リポジトリの設定は q5_0 を指しています）。
- GPU を使わない場合は `stt.use_gpu = false`（アプリが `-ng` を付与）にすると CPU 版 DLL で動作します。

## 起動

Windows では `start.bat` をダブルクリックするのが簡単です（依存パッケージ・ビルド・Ollama/VOICEVOX・モデルの有無を確認してから起動し、ブラウザを開きます）。

> ブラウザのマイクは **`http://localhost:3000`（または `http://127.0.0.1:3000`）** で開けば使えます（localhost は「安全なコンテキスト」扱いのため **https は不要**）。
> LAN の IP・PC 名（例 `http://192.168.0.5:3000`）で開いた場合のみ、ブラウザがマイクを許可しません。

```powershell
.\start.bat              # 起動（3 秒後にブラウザを開く）
.\start.bat /nobrowser   # ブラウザを自動で開かない
```

コマンドラインから直接起動する場合:

```powershell
npm start              # node dist/backend/index.js
# または scripts\run.bat（start.bat へ委譲）
```

ブラウザで <http://localhost:3000> を開きます。

- 「聞き取り開始」で発話待ちに入ります（`conversation.auto_start = true` なら起動直後から待機）
- テキスト欄からも会話できます（STT をスキップ）
- 発話が終わると自動で区切られ、認識 → 応答生成 → 読み上げまで進みます
- 応答中に話しかけると再生を止めて割り込みます（バージイン）
- 応答後しばらくは連続会話（フォローアップ）の待機に入ります

## 主な機能

- VAD（無音検出）による発話区間の自動切り出し（`execSync` を使わないストリーム録音）
- **ブラウザのマイク入力**（既定）: `getUserMedia` で録音し、発話単位の WAV を WebSocket で送信。
  VAD はサーバーと同一実装を共有。ffmpeg は `input_mode = "server"` のフォールバックとして残置
- マイク選択（ブラウザのデバイス一覧）とレベルメーター表示
- **「マイク確認」ボタン**: 5 秒間だけ録音して入力レベル（peak / dBFS / フレーム数）を表示（送信はしない）
- **聞き取りを継続**（`conversation.keep_listening = true`）: フォローアップ回数の上限後も「停止」を押すまで待機を続ける
- ストリーミング応答（差分を逐次表示）と `AbortController` による中断
- **応答言語ガード**: ハングル（韓国語）が混入した応答は 1 回だけ日本語で再生成（小規模モデルの言語混入対策）
- **幻聴（hallucination）対策**: whisper.cpp の非音声トークン抑制・文脈抑制・信頼度フィルタで、
  無音や雑音に対する「ご視聴ありがとうございました。」等の誤認識を破棄（[docs/ASR_OPTIONS.md](docs/ASR_OPTIONS.md)）
- **自分の声のエコー対策**: 直前の読み上げ内容と一致する認識結果・意味のない短い断片は会話に載せない（1 人で会話し続けるループ防止）。
  バージインは既定で無効（ブラウザのエコーキャンセルは ffplay の再生音には効かないため。有効化はヘッドホン推奨）
- バージイン（発話で再生を停止し、その発話を次のターンとして処理）
- フォローアップ（連続会話）
- キャラクター定義（`config/characters/*.toml`）の人格・応答ルール・口癖をプロンプトへ反映
- Web GUI（レベルメーター、履歴同期、自動再接続）
- REST API（設定の参照・部分更新・保存、履歴、ヘルスチェック、デバイス一覧）
- レベル付きロガー（コンソール + `logs/app.log`）

## 設定

`config/settings.toml` に**変更したい項目だけ**を書きます。未指定は `config/settings.default.toml`
（および `src/backend/config/schema.ts` の `DEFAULT_CONFIG`）で補完されます。

> `config/settings.toml` は **`.gitignore` 対象（各自のローカル設定）** です。
> ファイルが無い場合は `config/settings.default.toml` の値だけで起動するため、変更したい項目があるときだけ作成してください
> （`config/settings.default.toml` をコピーして必要な行だけ残すのが簡単です）。

### 認識エンジンの切り替え（whisper / sherpa-onnx）

既定は whisper.cpp です。**幻聴が構造的に起きない CTC 系モデル**を使いたい場合は sherpa-onnx に切り替えられます
（CPU のみで動作し、GPU を LLM に空けられます）。

```powershell
npm install sherpa-onnx-node                              # Windows x64 は DLL 同梱（追加設定不要）
powershell -ExecutionPolicy Bypass -File scripts\setup-sherpa.ps1   # 日本語 Parakeet 0.6B int8（約 467MB）
```

`config/settings.toml`:

```toml
[stt]
engine = "sherpa"
sherpa_model_dir = "models/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8"
sherpa_model_type = "nemo_ctc"      # 単一 model.onnx 構成
sherpa_provider = "cpu"
```

実測（この PC / VOICEVOX の日本語音声）: sherpa-onnx は **222〜420ms / 発話**（whisper.cpp + CUDA q5_0 は約 1.5〜3.5 秒）。
詳細と他エンジンの比較は [docs/ASR_OPTIONS.md](docs/ASR_OPTIONS.md) を参照してください。

主な項目:

| テーブル | 主なキー |
|----------|----------|
| `[audio]` | `sample_rate`, `frame_ms`, `silence_threshold`, `silence_threshold_max`, `silence_duration`, `no_speech_timeout`, `max_record_seconds`, `relative_threshold_multiplier`, `calibration_duration`, `debounce_frames`, `input_device`, `output_volume`, `player`, `input_mode`, `device_settle_ms` |
| `[conversation]` | `auto_start`, `followup_enabled`, `max_followup_turns`, `followup_timeout_seconds`, `followup_guard_ms`, `keep_listening`, `barge_in_enabled`, `barge_in_min_score` |
| `[stt]` | `model_path`, `binary_path`, `language`, `use_gpu`, `flash_attn`, `beam_size`, `threads`, `suppress_non_speech`, `max_context`, `no_speech_thold`, `drop_no_speech_prob`, `drop_avg_logprob`, `filter_hallucinations`, `min_input_rms`, `engine`, `sherpa_model_dir`, `sherpa_model_type`, `sherpa_provider`, `sherpa_language` |
| `[llm]` | `endpoint`, `model`, `character_file`, `temperature`, `max_tokens`, `history_turns` |
| `[tts]` | `endpoint`, `speaker_id`, `speed`, `pitch`, `volume` |

設定の反映:

```powershell
# 再読み込み（キャラクター定義も再読込）
curl -X POST http://localhost:3000/api/config/reload

# 部分更新（settings.toml へ保存される）
curl -X PATCH http://localhost:3000/api/config -H "Content-Type: application/json" -d "{\"tts\":{\"speaker_id\":8}}"
```

> `PATCH /api/config` は `settings.toml` を正規化して書き出すため、手書きコメントは失われます。

## 開発

```powershell
npm run verify         # typecheck → test → build をまとめて実行（作業後はこれ 1 本）
npm run typecheck      # 型チェック（backend）
npm test               # ユニット/結合テスト（node:test, 111 ケース）
npm run clean:tests    # dist-test の削除（pretest から自動実行）
npm run smoke          # 起動中サーバーの疎通確認
npm run check-audio    # マイク入力の診断（3 秒録音してピーク/dBFS を表示）
npm run dev            # ts-node で直接起動
npm run clean          # dist / dist-test の削除
```

テスト構成（`tests/`）:

| ファイル | 内容 |
|----------|------|
| `wav.test.ts` | WAV ヘッダ・二重ヘッダ防止・RMS・長さ |
| `vad.test.ts` | 発話検出・無音終了・タイムアウト・キャリブレーション・中断 |
| `config.test.ts` | 深いマージ・検証（範囲補正）・TOML 往復・保存と再読込・マスク |
| `history.test.ts` | ターン上限・プロンプト用メッセージ整形 |
| `character-prompt.test.ts` | キャラクター TOML の読み込み・システムプロンプト生成 |
| `ollama-stream.test.ts` | NDJSON のチャンク境界処理・モデル一覧 |
| `voicevox-binary.test.ts` | 音声バイナリの非破損・パラメータ反映 |
| `pipeline.test.ts` | 無音 / 1 ターン / テキスト入力 / フォローアップ / バージイン / 中断 / ブラウザ音声 1 ターン |
| `shared-pcm.test.ts` | WAV 生成・Base64・リサンプル・ゲイン（ブラウザと共通） |
| `audio-payload.test.ts` | `submit_audio` の検証（Base64/WAV/サイズ/形式） |
| `frontend-script.test.ts` | ビルド済み `app.js` を擬似 DOM で実行（WS 接続・hello 描画・ボタン送信） |

## 構成

```text
src/
├── shared/protocol.ts          # フロント・バックエンド共有の型（イベント/コマンド）
├── shared/audio/               # PCM/WAV/Base64/VAD（ブラウザとサーバーで共有）
├── backend/
│   ├── index.ts               # コンポジションルート（DI 配線・起動・終了処理）
│   ├── config/                # 設定スキーマ・読込・検証・保存
│   ├── core/                  # ポート定義・ロガー・パス・子プロセス実行
│   ├── services/              # Audio / VAD / STT / LLM / TTS / Character
│   ├── conversation/          # パイプライン・履歴・プロンプト生成
│   └── server/                # Express + WebSocket
└── frontend/                  # index.html / style.css / app.ts
config/                        # settings.toml, settings.default.toml, characters/
scripts/                       # setup.bat, run.bat, build.js, clean.js, smoke.js, setup-whisper-cuda.ps1
start.bat                      # Windows 用ランチャー（依存/ビルド/外部サービス確認 → 起動）
docs/                          # DESIGN.md（As-Is）, REDESIGN.md（To-Be）
models/, whisper.cpp/          # Whisper 本体とモデル
logs/                          # app.log（実行ログ）
```

## トラブルシュート

| 症状 | 確認ポイント |
|------|--------------|
| マイクが使えない／許可が出ない | `http://localhost` か `http://127.0.0.1`（または https）で開く。LAN の IP では使えません |
| 「マイクの使用が許可されていません」 | ブラウザのアドレスバー横のマイク許可。`http://localhost`（または https）で開く |
| 「音声データが届きません（ctx=suspended …）」 | 自動再生ポリシーで音声処理が停止しています。**画面をもう一度クリック**して再試行（「マイク確認」は自動で再初期化も試します） |
| マイクが一覧に出ない | 画面の「マイク」で「既定のマイク」以外を選択。Windows のサウンド設定も確認 |
| マイクが開かない（ffmpeg モード） | `audio.input_mode = "server"` の場合。`ffmpeg` の PATH、`audio.input_device`、`GET /api/audio-devices` |
| 入力レベルが動かない（マイクが拾っていない） | 「マイク確認」を押して 5 秒話す。peak が 0.02 未満なら「マイク」セレクトで別デバイスを選択 |
| 発話を検出しない | `audio.silence_threshold`（RMS 0..1）を上げる、`audio.input_gain` を上げる。UI のレベルメーターを確認 |
| 話している途中で切れる | ① `audio.max_record_seconds`（既定 30 秒）に達していないか ② `audio.silence_duration`（既定 1.5 秒）より長く黙っていないか ③ `audio.silence_threshold_max`（既定 0.06）でしきい値が上がりすぎていないか。`logs/app.log` の「ブラウザから音声を受信: 1234ms」で実際に送られた長さを確認できる |
| タイピング音や物音で聞き取りが始まる | `audio.debounce_frames`（既定 3 = 60ms 連続）を増やす、`audio.silence_threshold` を上げる、`audio.silence_threshold_max` を下げる |
| 言っていない発話が勝手に入力される（「ご視聴ありがとうございました。」等） | Whisper の幻聴。`stt.suppress_non_speech` / `stt.drop_no_speech_prob` / `stt.filter_hallucinations`（既定で有効）と `audio.silence_threshold`（0.03〜0.05 に上げる）を確認。詳細は [docs/ASR_OPTIONS.md](docs/ASR_OPTIONS.md) |
| 自分で会話が続いてしまう（エコー） | スピーカーの音をマイクが拾っています。ヘッドホンを使う、`conversation.barge_in_enabled = false`（既定）、`audio.output_volume` を下げる。直近の応答と一致する断片・2 文字以下の断片は自動で破棄されます（`logs/app.log` に「エコーと判定」「短すぎる認識結果」） |
| LLM が 404（`model 'xxx' not found`） | `llm.model` が Ollama に無い。`ollama list` で確認し `ollama pull <model>` を実行。**`settings.toml` を書き換えただけでは反映されない**ので `POST /api/config/reload` か再起動も行う（起動時にも警告が出ます） |
| 反応しない／固まったように見える | 「聞き取り開始」を押し直すか、ページを再読み込み。サーバーが幻聴・エコーを破棄した場合は `turn_skipped` を通知して聞き取りを続けます（従来は待機したまま固まる不具合がありました）。`logs/app.log` に「破棄します」が出ていないか確認 |
| 返答が返ってこない | `logs/app.log` に `ERROR [LLM]` が出ていないか確認。接続断は「Ollama との接続が中断されました（モデルの読み込み失敗・VRAM 不足など）」として通知されます。タイムアウトは `llm.response_timeout_seconds` |
| 音が出ない | VOICEVOX の起動、`audio.output_volume`、`audio.player` |
| バージインしない | `conversation.barge_in_enabled`, `barge_in_min_score`（既定 0.08） |
| 設定が効かない | `POST /api/config/reload` または再起動 |

## 未実装（設定のみ）

`[rag]` `[recipe_db]` `[music]` `[apps.proactive_speech]` `[apps.home_assistant]` は
設定スキーマと既定値のみ定義しています（拡張ポイント）。詳細は
[docs/REDESIGN.md](docs/REDESIGN.md) のロードマップを参照してください。

## ライセンス

MIT License
