# Sumika TypeScript

ローカル完結型 AI 音声アシスタント（バックエンド・フロントエンドともに TypeScript）。

- 音声認識: whisper.cpp
- 応答生成: Ollama
- 音声合成: VOICEVOX
- 音声・テキストは**外部クラウドへ送信しません**（すべて localhost で完結）

設計書:

- [docs/DESIGN.md](docs/DESIGN.md) — 再設計前の現状設計書（As-Is）
- [docs/REDESIGN.md](docs/REDESIGN.md) — 再設計書（To-Be / アーキテクチャ・プロトコル・VAD・移行手順）

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
- バージイン（発話で再生を停止し、その発話を次のターンとして処理）
- フォローアップ（連続会話）
- キャラクター定義（`config/characters/*.toml`）の人格・応答ルール・口癖をプロンプトへ反映
- Web GUI（レベルメーター、履歴同期、自動再接続）
- REST API（設定の参照・部分更新・保存、履歴、ヘルスチェック、デバイス一覧）
- レベル付きロガー（コンソール + `logs/app.log`）

## 設定

`config/settings.toml` に**変更したい項目だけ**を書きます。未指定は `config/settings.default.toml`
（および `src/backend/config/schema.ts` の `DEFAULT_CONFIG`）で補完されます。

主な項目:

| テーブル | 主なキー |
|----------|----------|
| `[audio]` | `sample_rate`, `frame_ms`, `silence_threshold`, `silence_duration`, `no_speech_timeout`, `max_record_seconds`, `input_device`, `output_volume`, `player`, `input_mode`, `device_settle_ms` |
| `[conversation]` | `auto_start`, `followup_enabled`, `max_followup_turns`, `followup_timeout_seconds`, `followup_guard_ms`, `keep_listening`, `barge_in_enabled`, `barge_in_min_score` |
| `[stt]` | `model_path`, `binary_path`, `language`, `use_gpu`, `flash_attn`, `beam_size`, `threads` |
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
npm run typecheck      # 型チェック
npm test               # ユニット/結合テスト（node:test, 63 ケース）
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
| LLM が 404 | `llm.model` が未取得（起動時に警告が出ます） |
| 音が出ない | VOICEVOX の起動、`audio.output_volume`、`audio.player` |
| バージインしない | `conversation.barge_in_enabled`, `barge_in_min_score`（既定 0.08） |
| 設定が効かない | `POST /api/config/reload` または再起動 |

## 未実装（設定のみ）

`[rag]` `[recipe_db]` `[music]` `[apps.proactive_speech]` `[apps.home_assistant]` は
設定スキーマと既定値のみ定義しています（拡張ポイント）。詳細は
[docs/REDESIGN.md](docs/REDESIGN.md) のロードマップを参照してください。

## ライセンス

MIT License
