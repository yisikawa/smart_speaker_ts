# Sumika TypeScript — 現状設計書（As-Is）

> 対象: `smart_speaker_ts` v0.1.0（再設計前のコードベース）
> 本書は「フォルダの内容を設計書にまとめたもの」であり、再設計版は [REDESIGN.md](./REDESIGN.md) を参照。
> 記載内容は実際のソース（`src/backend/*.ts`, `src/frontend/*`, `config/*.toml`, `scripts/*.bat`）を読んで整理した。

---

## 1. 目的とスコープ

ローカル PC 上で完結する音声アシスタント（スマートスピーカー）。
音声認識（Whisper）→ 応答生成（Ollama）→ 音声合成（VOICEVOX）のパイプラインを、
バックエンド・フロントエンドともに TypeScript で実装したプロトタイプ。

| 項目 | 内容 |
|------|------|
| 想定利用 | 1 台の Windows PC、ローカルマイク／スピーカー |
| 外部送信 | なし（すべて localhost の常駐プロセスと通信） |
| 実行形態 | Node.js 常駐プロセス + ブラウザ GUI（`http://localhost:3000`） |
| 想定言語 | 日本語（`stt.language = "ja"`） |

### 非機能要件（コードから読み取れる実質的な前提）

- Node.js v18 以上（実際の開発環境は v22）
- Ollama（`:11434`）と VOICEVOX ENGINE（`:50021`）が別途起動していること
- `ffmpeg`（録音）と `ffplay` or PowerShell（再生）が利用可能なこと
- `whisper.cpp/main.exe` と `models/ggml-*.bin` が配置済みであること
- 単一ユーザー・認証なし・CORS 全許可（localhost 前提の割り切り）

---

## 2. 技術スタック

| 層 | 技術 | 用途 |
|----|------|------|
| ランタイム | Node.js + TypeScript 5.3（`commonjs`, `strict`） | バックエンド／フロントエンドビルド |
| HTTP | Express 4 + `cors` | 静的配信・REST API |
| リアルタイム | `ws` (WebSocket) | 会話イベントの双方向通信 |
| 設定 | `toml` v3（`parse` のみ） | `config/settings.toml` |
| 音声入力 | `ffmpeg -f dshow`（`execSync`） | マイク録音（WAV ファイル） |
| 音声認識 | `whisper.cpp/main.exe`（`spawn`） | 日本語 STT |
| LLM | Ollama `/api/chat`（`http` モジュール） | 応答生成（ストリーミング） |
| 音声合成 | VOICEVOX `/audio_query` + `/synthesis` | WAV 生成 |
| 再生 | PowerShell `Media.SoundPlayer` / `aplay` | スピーカー出力 |
| 開発 | `ts-node`, `tsc` | 実行・ビルド |

---

## 3. ディレクトリ構成（As-Is）

```text
smart_speaker_ts/
├── package.json               # npm スクリプト（build/start/dev）
├── tsconfig.json              # target ES2022, module commonjs, outDir ./dist
├── README.md
├── config/
│   ├── settings.toml          # ユーザー設定（.gitignore 対象）
│   ├── settings.default.toml  # 既定設定（未使用の項目も含む）
│   └── characters/sakura.toml # キャラクター定義
├── scripts/
│   ├── setup.bat              # npm install + tsc
│   └── run.bat                # Ollama/VOICEVOX 起動確認 → node dist/...
├── src/backend/
│   ├── index.ts               # エントリーポイント（配線 + SIGINT 処理）
│   ├── config.ts              # TOML ローダー + 型 + DEFAULT_CONFIG
│   ├── ollama.ts              # Ollama クライアント
│   ├── voicevox.ts            # VOICEVOX クライアント
│   ├── whisper.ts             # whisper.cpp ラッパー
│   ├── audio.ts               # 録音（ffmpeg）・再生（SoundPlayer）
│   ├── pipeline.ts            # 会話パイプライン（STT→LLM→TTS）
│   ├── server.ts              # Express + WebSocket
│   └── declarations.d.ts      # node-record-lpcm16 の型宣言（未使用）
├── src/frontend/
│   ├── index.html             # 画面構造
│   ├── app.ts                 # WebSocket クライアント + DOM 更新
│   └── style.css
├── models/ggml-large-v3-turbo.bin
├── whisper.cpp/               # main.exe + DLL 群
├── data/{knowledge,recipedb,calendar}/  # 空ディレクトリ（未使用）
├── logs/                      # TTS 生成 WAV の出力先
└── music/                     # ローカル音楽（未使用）
```

---

## 4. モジュール構成と責務（As-Is）

### 4.1 `src/backend/index.ts`（エントリーポイント）

1. `ConfigManager` を生成
2. `ConversationPipeline` を生成して `initialize()`（Ollama / VOICEVOX / Whisper の疎通確認ログ）
3. `SmartSpeakerServer`（port 3000）を起動
4. 1 秒後に `pipeline.startWakeWordListening()` を**自動実行**（実質いきなり録音開始）
5. `SIGINT` で `stopListening()` / `server.stop()` → `process.exit(0)`

### 4.2 `src/backend/config.ts`

- `AudioConfig` / `WakewordConfig` / `ConversationConfig` / `STTConfig` / `LLMConfig` / `TTSConfig` /
  `RAGConfig` / `RecipeDBConfig` / `MusicConfig` / `GUIConfig` / `ProactiveSpeechConfig` /
  `HomeAssistantConfig` の型定義
- `DEFAULT_CONFIG: Partial<AppConfig>`（型は部分型 → キャストで `AppConfig` として保持）
- `ConfigManager.load()`: `settings.toml` → 無ければ `settings.default.toml` を読み、`mergeDefaults()` で深いマージ
- セクション単位の getter（`getAudio()` など）。**保存・更新・検証の仕組みは無い**

### 4.3 `src/backend/ollama.ts`

- `POST /api/chat`（`stream: false` の `generate()` と `stream: true` の `generateStream()`）
- `GET /api/tags` による疎通確認とモデル一覧
- タイムアウトは `llm.response_timeout_seconds`
- 生 `http.request` を使用（`fetch` 非依存）。トークン逐次通知は `onChunk` コールバック

### 4.4 `src/backend/voicevox.ts`

- `POST /audio_query?text=..&speaker=..` → `POST /synthesis?speaker=..`
- `speed` / `pitch` / `volume` を `audioQuery` に上書き
- `saveAudio(text, path)` で WAV をファイル保存

### 4.5 `src/backend/whisper.ts`

- `whisper.cpp/main.exe` を `spawn` し、`-otxt -of <base>` でテキストファイル出力を読む
- `transcribe(wavPath)` / `transcribeBuffer(buffer)`
- 引数: `-m model -f wav -l ja -otxt -of base`、`use_gpu` のとき `-ng` を付与

### 4.6 `src/backend/audio.ts`

- `startRecording()`: `ffmpeg -f dshow -i audio="<device>" -t <max_record_seconds> ...` を **`execSync`** 実行
- `stopRecording()`: 生成された WAV を読み込んで Buffer を返す
- `playWav(buffer)`: `encodeWav()` でヘッダを付与してから PowerShell `SoundPlayer` で同期再生
- `getDevices()`: 常に空配列

### 4.7 `src/backend/pipeline.ts`

- `EventEmitter` ベース。`PipelineEvent`（11 種）を発火
- `startWakeWordListening()` → 500ms 後に `runConversationTurn()`
- `runConversationTurn()`:
  1. 録音開始（`max_record_seconds` 秒）
  2. **固定で `max_record_seconds × 1000 ms` 待機**
  3. 録音停止 → `whisper.transcribeBuffer()`
  4. 履歴 + system プロンプトで `ollama.generateStream()`
  5. `voicevox.saveAudio()` → `fs.readFileSync` → `audio.playWav()`
  6. `followup` 設定は**ログ出力のみ**（待機・継続しない）
- `buildSystemPrompt()`: キャラクター TOML を**正規表現**で `name` と `personality` のみ抽出

### 4.8 `src/backend/server.ts`

- `express.static` で `src/frontend` と `dist/frontend` を二重配信
- REST: `GET /api/config`, `POST /api/tts`, `GET /api/history`, `POST /api/history/clear`, `GET /api/audio-devices`
- WebSocket `/ws`: `start_listening` / `stop_listening` / `speak` / `wake_word` を受信
- パイプラインイベントを `{type:"pipeline", event}` で全クライアントへブロードキャスト
- `GET /api/audio-devices` は `pipeline["audio"].getDevices()` と**私有フィールドへ文字列アクセス**

### 4.9 `src/frontend/app.ts`

- `WebSocket` で `/ws` に接続、再接続は 3 秒固定
- イベントに応じてステータス・顔文字・吹き出しを更新
- 「聞き取り開始」「停止」「履歴クリア」ボタン
- `loadConfig()` は取得結果を `console.log` するだけ

### 4.10 `scripts/*.bat`

- `setup.bat`: Node.js 確認 → `npm install` → `npx tsc`
- `run.bat`: `curl` で Ollama / VOICEVOX の起動確認（Ollama のみ自動起動を試行）→ `node dist/backend/index.js`

---

## 5. データフロー（As-Is）

```text
[ブラウザ] --(WS: start_listening)--> [server.ts]
                                        |
                                        v
                              [pipeline.startWakeWordListening]
                                        | 500ms
                                        v
                       +-------------------------------------+
                       | runConversationTurn()               |
                       |                                     |
                       | 1) audio.startRecording()           |  ffmpeg dshow
                       |    execSync で max_record_seconds 秒 |  （ブロッキング）
                       | 2) setTimeout で同じ秒数だけ待機      |
                       | 3) audio.stopRecording() -> Buffer  |
                       | 4) whisper.transcribeBuffer()       |  main.exe
                       | 5) ollama.generateStream()          |  /api/chat (NDJSON)
                       | 6) voicevox.saveAudio()             |  /audio_query + /synthesis
                       | 7) audio.playWav(readFileSync(wav)) |  SoundPlayer
                       +-------------------------------------+
                                        |
                       PipelineEvent を EventEmitter で発火
                                        |
                     server.ts: {type:"pipeline", event} で全 WS へ配信
                                        |
                                [ブラウザ: 吹き出し更新]
```

設定は起動時に一度だけ読み込まれ、実行中の変更（`/api/config`）はできない。

---

## 6. 設定仕様（As-Is）

| テーブル | 主なキー | 実際にコードが参照しているか |
|----------|----------|------------------------------|
| `[audio]` | sample_rate, max_record_seconds, silence_threshold, silence_threshold_max, silence_duration, no_speech_timeout, input_gain, output_device, input_device, smoothing_alpha, relative_threshold_multiplier, calibration_duration, debounce_frames | `sample_rate`, `max_record_seconds`, `input_device` のみ |
| `[wakeword]` | wakeword_path, threshold, avg_threshold, min_scores | 未参照（ウェイクワードエンジン未実装） |
| `[conversation]` | followup_enabled, max_followup_turns, followup_timeout_seconds, followup_guard_ms, barge_in_enabled, barge_in_min_score | `followup_*` をログに使用するのみ。`barge_in_*`, `followup_guard_ms` は未使用 |
| `[stt]` | model_path, language, use_gpu, flash_attn, beam_size | `model_path`, `language`, `use_gpu` のみ（`-ng` の意味が逆） |
| `[llm]` | endpoint, model, character_file, temperature, max_tokens, response_timeout_seconds | すべて使用 |
| `[tts]` | engine, endpoint, speaker_id, speed, pitch, volume | すべて使用（`engine` は分岐なし） |
| `[rag]` `[recipe_db]` `[music]` `[apps.*]` | — | **未実装**（型と既定値のみ） |
| `[gui]` | user_name, debug_mode, trace_turns, outfit | `user_name` のみ |

キャラクター定義（`config/characters/sakura.toml`）は `name` / `personality` のみ利用。
`label` / `response_rules` / `catchphrases` は読み捨てられている。

---

## 7. 外部インターフェース（As-Is）

### 7.1 REST API

| メソッド | パス | 内容 |
|----------|------|------|
| GET | `/api/config` | 設定の全セクションを返す（秘匿情報のマスクなし） |
| POST | `/api/tts` | `{text}` を読み上げ（完了までブロック） |
| GET | `/api/history` | 会話履歴（`{role, content}` の配列） |
| POST | `/api/history/clear` | 履歴クリア |
| GET | `/api/audio-devices` | 常に `{"devices":[]}` |

### 7.2 WebSocket `/ws`

- サーバー → クライアント: `{ type: "pipeline", event: PipelineEvent }`
- クライアント → サーバー: `start_listening` / `stop_listening` / `speak` / `wake_word`
- 接続時の初期同期（hello / 履歴送信）は無し。ハートビートも無し。

### 7.3 PipelineEvent 一覧

`wakeword_detected` / `recording_started` / `recording_stopped` / `stt_started` / `stt_complete` /
`llm_started` / `llm_stream` / `llm_complete` / `tts_started` / `tts_complete` / `turn_complete` / `error`

---

## 8. 課題一覧（重大度順）

| # | 重大度 | 箇所 | 内容 | 影響 |
|---|--------|------|------|------|
| 1 | **致命的** | `voicevox.ts:125-135` | `/synthesis` のバイナリ応答を `JSON.parse` 失敗後の**文字列**として受け、`Buffer.from(string)` で再構築 | 生成音声が破損（ノイズ／再生不可） |
| 2 | **致命的** | `audio.ts:124-141` | 既に WAV ヘッダ付きの音声へ `encodeWav()` で**二重ヘッダ**を付与。さらに 24kHz 音声を 16kHz として扱う | 再生速度・ピッチ異常／再生失敗 |
| 3 | **致命的** | `whisper.ts:44-46` | `use_gpu = true` で `-ng`（= `--no-gpu`）を渡している（意味が逆） | GPU が使われず認識が極端に遅い |
| 4 | 重大 | `audio.ts:50` | `execSync` で `max_record_seconds`（既定 10 秒）**イベントループをブロック** | 録音中は HTTP/WS が応答しない |
| 5 | 重大 | `audio.ts:37-47` | デバイス名を**コマンド文字列連結**で渡し、既定値もハードコード | デバイス名に空白・記号・日本語があると失敗／シェルインジェクション余地 |
| 6 | 重大 | `pipeline.ts:106-115` | 固定 10 秒録音。`silence_threshold` 等の VAD 設定が**未使用** | 発話の尻切れ／長時間の無音待ち |
| 7 | 重大 | `pipeline.ts:190-195` | フォローアップがログ出力のみ。`barge_in_*` も未使用 | 連続会話・割り込みができない |
| 8 | 重大 | `ollama.ts:198-215` | NDJSON の受信バッファに**残り行を保持しない** | チャンク境界で `JSON.parse` に失敗し応答が欠落 |
| 9 | 重大 | `app.ts:172-184` | `llm_stream` ごとに `textContent` を**上書き** | 最後のチャンクしか表示されない |
| 10 | 重大 | `server.ts:74` | `pipeline["audio"]` と私有フィールドへ文字列アクセス | カプセル化破壊・実装変更で即壊れる |
| 11 | 中 | `config.ts:264` | `DEFAULT_CONFIG as AppConfig` は `Partial` のキャスト | 既定値の欠落をコンパイラが検出できない |
| 12 | 中 | 全体 | 設定の保存・更新・検証 API が無い。相対パスが CWD 依存 | 起動ディレクトリを変えると設定が見つからない |
| 13 | 中 | 全体 | キャンセル機構が無い（`AbortController` 未使用）。リトライ無し | 停止操作が効かない／二重起動 |
| 14 | 中 | `index.ts:24-26` | 起動 1 秒後に**勝手に録音開始** | 意図しない録音・プライバシー懸念 |
| 15 | 中 | `server.ts:24` | `cors()` 全許可・認証なし・`express.json({limit:"10mb"})` | 同一 PC 上の任意ページから操作可能 |
| 16 | 中 | `index.ts:28-33` | 終了時も子プロセス（ffmpeg / whisper）が残り得る | ゾンビプロセス・マイク解放漏れ |
| 17 | 低 | `pipeline.ts:203-212` | キャラクター TOML を正規表現で部分抽出 | 応答ルール・口癖が反映されない |
| 18 | 低 | 全体 | ロガーが無く `console.log` 直書き。`logs/` は WAV 置き場のみ | 障害調査が困難・ディスク圧迫 |
| 19 | 低 | — | ディレクトリ `data/`, `music/` は空。`rag`/`recipe_db`/`music`/`apps.*` は未実装 | 設定と実装の乖離 |
| 20 | 低 | — | テスト・Lint・型チェックの自動化が無い（`npm test` 不在） | 回帰検知できない |

---

## 9. 品質・運用手順（As-Is）

- ビルド: `npx tsc`（`dist/` へ出力）。フロントは `dist/frontend/app.js` のみ生成され、
  HTML/CSS は `src/frontend` から直接配信される（`dist/frontend` には存在しない）。
- 起動: `node dist/backend/index.js`（または `scripts/run.bat`）
- 設定変更: `config/settings.toml` を編集して**再起動**
- ログ: 標準出力のみ。`logs/` には `tts_*.wav` / `response_*.wav` が溜まる
- テスト: なし。手動で GUI から動作確認するのみ

