# Sumika TypeScript — 再設計書（To-Be）

> 現状設計書 [DESIGN.md](./DESIGN.md) の課題分析に基づく再設計。
> 実装は `src/shared` / `src/backend/{config,core,services,conversation,server}` / `src/frontend` に再編済み（v0.3.0）。

---

## 1. 設計方針

現状の最大の問題は「1 つの関数が録音・変換・破棄を抱え込み、設定と実装が乖離している」こと。
再設計では次の 5 点を柱とする。

| # | 方針 | 具体的な対応 |
|---|------|--------------|
| 1 | **レイヤ分離と依存方向の一方向化** | `shared`（型）← `core`（ポート/ユーティリティ）← `services` / `conversation` ← `server` ← `index`（配線） |
| 2 | **ポート＆アダプタ（DI）** | パイプラインは `AudioIO` / `SpeechToText` / `LanguageModel` / `TextToSpeech` の**インターフェースのみ**に依存。実装は `index.ts` で注入 |
| 3 | **純粋ロジックの抽出** | VAD・WAV 変換・設定マージ・TOML 直列化を I/O 非依存の関数/クラスに分離 → 単体テスト可能 |
| 4 | **ストリーム指向 + 中断可能** | `execSync` 廃止、`spawn` + `AbortController`。録音・STT・LLM・再生すべてキャンセル可能 |
| 5 | **設定の単一真実源 + 実行時更新** | `schema.ts` に型と既定値を集約し、検証（範囲補正）と保存（TOML 生成）を提供 |

### 非目標（今回のスコープ外）

- 認証・マルチユーザー・リモート公開（localhost 前提を維持）
- ウェイクワードエンジン（Porcupine 等）の実装 → トリガーは UI / API
- RAG / レシピ DB / 音楽再生 / Home Assistant / プロアクティブ発話 → 設定と拡張点のみ維持

### 音声入力の方式（A 案：ブラウザ録音）

既定は **ブラウザのマイク**（`audio.input_mode = "browser"`）で録音し、発話単位の WAV を
WebSocket（`submit_audio`）で送る。VAD は `src/shared/audio/vad.ts` に置き、
サーバー（ffmpeg モード）とブラウザで**同一実装を共有**する。

- 長所: OS のマイク許可 UI・デバイス選択・入力レベルの可視化が得られ、dshow 名の設定が不要。
  ffmpeg を開かないため、複数プロセスによるデバイス競合も起きない。
- 短所: 録音できるのは画面を開いている間だけ（常駐・ウェイクワードは不可）。
- フォールバック: `audio.input_mode = "server"` で従来の ffmpeg 録音（`AudioService`）に切り替え可能。

---

## 2. アーキテクチャ

```text
                       ┌──────────────────────────────┐
                       │  src/shared/protocol.ts      │  イベント・コマンド・DTO（型のみ）
                       └──────────────┬───────────────┘
                                      │ import type
        ┌─────────────────────────────┼─────────────────────────────┐
        │                             │                             │
┌───────▼────────┐          ┌─────────▼─────────┐         ┌─────────▼────────┐
│  src/frontend  │  WS/HTTP │  src/backend/     │         │  src/backend/    │
│  app.ts        │◄────────►│  server/          │         │  index.ts        │
│  (UI 状態機械) │          │  AppServer        │         │  (Composition    │
└────────────────┘          │  ApiRouter        │         │   Root)          │
                            │  WsHub            │         └────────┬─────────┘
                            └─────────┬─────────┘                  │ 実装を注入
                                      │                            │
                            ┌─────────▼─────────┐                  │
                            │ conversation/     │◄─────────────────┘
                            │ ConversationPipe  │   ports (core/ports.ts)
                            │ ConversationHist  │
                            │ PromptBuilder     │
                            └─────────┬─────────┘
                                      │ インターフェース経由
        ┌──────────────┬──────────────┼───────────────┬──────────────┐
        ▼              ▼              ▼               ▼              ▼
  AudioService  WhisperStt      OllamaLlm      VoicevoxTts    CharacterService
  (ffmpeg/VAD)  (main.exe)      (/api/chat)    (/synthesis)    (TOML)
        │
        ├── services/vad.ts    （純粋ロジック: 発話区間検出）
        └── services/wav.ts    （純粋関数: WAV/PCM/RMS）
```

- **依存方向は常に内向き**。`services` は `server` を知らず、`conversation` は具体実装を知らない。
- 追加の共通部品は `core/` に集約（`logger`, `paths`, `childProcess`, `messages`, `ports`）。

---

## 3. ディレクトリ構成（To-Be）

```text
src/
├── shared/
│   ├── protocol.ts            # PipelineEvent / ClientCommand / ServerMessage / HealthReport
│   └── audio/
│       ├── pcm.ts             # Int16 PCM / WAV / Base64 / リサンプル（ブラウザ・Node 共通）
│       └── vad.ts             # VadEngine（ブラウザの録音とサーバーの録音で共有）
├── backend/
│   ├── index.ts               # コンポジションルート（DI 配線・起動・終了処理）
│   ├── config/
│   │   ├── schema.ts          # 設定型 + DEFAULT_CONFIG（型は非 Partial）
│   │   ├── ConfigManager.ts   # 読込・マージ・検証・保存・パス解決
│   │   ├── merge.ts           # deepMerge / deepClone（純粋関数）
│   │   ├── sanitize.ts        # 範囲検証と補正（純粋関数）
│   │   └── tomlSerializer.ts  # toml v3 に stringify が無いため自前実装
│   ├── core/
│   │   ├── ports.ts           # AudioIO / SpeechToText / LanguageModel / TextToSpeech
│   │   ├── logger.ts          # レベル付きロガー（コンソール + logs/app.log）
│   │   ├── paths.ts           # プロジェクトルート探索
│   │   ├── childProcess.ts    # タイムアウト/中断対応の runProcess
│   │   └── messages.ts        # LLM メッセージ型
│   ├── services/
│   │   ├── AudioService.ts    # ffmpeg 録音（VAD）+ ffplay/SoundPlayer 再生
│   │   ├── vad.ts             # VadEngine（フレーム入力 → 判定）
│   │   ├── wav.ts             # encodeWav / ensureWav / rmsLevel / wavDurationMs
│   │   ├── WhisperSttService.ts
│   │   ├── OllamaLlmService.ts
│   │   ├── VoicevoxTtsService.ts
│   │   └── CharacterService.ts
│   ├── conversation/
│   │   ├── ConversationPipeline.ts  # 状態機械 + ターンループ
│   │   ├── ConversationHistory.ts   # ターン上限付き履歴
│   │   └── PromptBuilder.ts         # system プロンプト生成
│   └── server/
│       ├── AppServer.ts       # Express + HTTP + 静的配信 + ライフサイクル
│       ├── ApiRouter.ts       # REST（health/config/history/tts/devices）
│       ├── audioPayload.ts    # ブラウザ音声（Base64 WAV）の検証
│       └── WsHub.ts           # WebSocket（hello/heartbeat/コマンド振り分け）
└── frontend/
    ├── index.html
    ├── style.css
    ├── mic.ts                 # getUserMedia + AudioWorklet + 共有 VAD（ブラウザ録音）
    └── app.ts                 # UI・WS・ブラウザ録音ループ（esbuild でバンドル）
```

### ビルド成果物

```text
dist/
├── backend/**            # tsc 出力（CommonJS）
├── shared/**             # バックエンドが参照する共有モジュール（CommonJS）
└── frontend/
    ├── app.js            # esbuild でバンドルした IIFE（app.ts + mic.ts + shared/audio）
    ├── app.js.map
    ├── index.html        # scripts/build.js がコピー
    └── style.css         # scripts/build.js がコピー
```

`npm run build` = `clean` → `tsc -p tsconfig.json`（バックエンド） →
`tsc -p tsconfig.frontend.json`（型チェックのみ） → `node scripts/build.js`（HTML/CSS コピー + esbuild バンドル）。

- フロントは **esbuild で 1 ファイルにバンドル（IIFE）**する。tsc の CommonJS 出力は `exports`、
  ES2020 出力は `export {}` や拡張子なし import がブラウザで問題になるため。
- サーバーは `dist/frontend` を優先配信し、未ビルド時は `src/frontend` にフォールバックする（開発時の利便性）。


---

## 4. 主要インターフェース（`core/ports.ts`）

```ts
export interface AudioIO {
  listInputDevices(): Promise<AudioDevice[]>;
  capture(options: CaptureOptions): CaptureHandle;   // 発話区間を自動で切り出す
  play(wav: Buffer): PlaybackHandle;                 // stop() 可能な再生
  dispose(): Promise<void>;
}

export interface CaptureHandle {
  result: Promise<CaptureResult>;   // { pcm, wav, durationMs, hasSpeech, reason }
  stop(reason?: CaptureEndReason): void;
}

export interface SpeechToText {
  isAvailable(): Promise<boolean>;
  transcribe(wav: Buffer, options?: { signal?: AbortSignal }): Promise<Transcript>;
}

export interface LanguageModel {
  isAvailable(): Promise<boolean>;
  listModels(): Promise<string[]>;
  chatStream(
    messages: LlmMessage[],
    onDelta: (chunk: string) => void,
    options?: ChatOptions          // { signal, temperature, tools }
  ): Promise<string>;
}

export interface TextToSpeech {
  isAvailable(): Promise<boolean>;
  listSpeakers(): Promise<TtsSpeaker[]>;
  synthesize(text: string, options?: TtsOptions): Promise<Buffer>;  // 常にバイナリ
}
```

設計上のポイント:

- **`synthesize` は Buffer を返す**（ファイル I/O を持たない）→ 再生・保存・テストが自由自在。
- **`capture` は「発話 1 つ」を返す**。録音時間の管理は VAD 側の責務で、呼び出し側は待つだけ。
- **`chatStream` は差分コールバック + 最終全文**。呼び出し側は「表示」と「TTS」を分けて扱える。
- すべて `AbortSignal` を受け取り、`ConversationPipeline.stop()` が 1 本で全体を止められる。

---

## 5. 会話パイプラインの状態機械

```text
                    (UI: 聞き取り開始 / テキスト入力 / auto_start)
                                   │
                                   ▼
   ┌──────────┐  発話検出   ┌────────────┐  STT  ┌──────────────┐
   │ recording│───────────►│transcribing│──────►│   thinking   │
   └────┬─────┘            └────────────┘       └──────┬───────┘
        │ 無音タイムアウト / 発話なし                     │ LLM 完了
        ▼                                              ▼
   ┌──────────┐                                  ┌────────────┐
   │   idle   │◄────────── ターン終了 ───────────│  speaking  │
   └──────────┘                                  └─────┬──────┘
        ▲                                              │ バージイン検出
        │                                              ▼
        │                                   既取得の発話を次ターンへ
        │                                    （recording をスキップ）
        └─────────── フォローアップ待機（followup_wait）──┘
```

- 状態は `AssistantState`（`idle` / `waiting_wakeword` / `recording` / `transcribing` /
  `thinking` / `speaking` / `error`）として `{type:"state"}` イベントで通知し、UI と 1:1 対応。
- `busy` フラグで多重起動を防ぎ、実行中の要求にはエラーイベントを返す。
- `stop()` は `active=false` → `AbortController.abort()` → `capture.stop()` → `playback.stop()` を一括実行し、
  ターンループの `finally` で必ず `idle` に戻す。

### 5.1 1 ターンのシーケンス

```text
Pipeline            AudioIO            STT            LLM            TTS          WS/UI
   │ capture(opts) ──► │
   │                   │ ffmpeg dshow → PCM ストリーム → VAD
   │ ◄─ level(10Hz) ───┤                                                  level ──►│
   │ ◄─ speech_start ──┤
   │ ◄─ result(wav) ───┤  （無音 1.0s で自動終了）
   │ state=transcribing, stt_started ────────────────────────────────────────────►│
   │ transcribe(wav) ─────────────────► │
   │ ◄────── transcript ────────────────┤                        stt_complete ───►│
   │ state=thinking, llm_started ─────────────────────────────────────────────────►│
   │ chatStream(msgs, onDelta) ──────────────────────► │
   │ ◄────────────── delta×N ──────────────────────────┤            llm_delta ───►│
   │ ◄────────────── 全文 ─────────────────────────────┤        llm_complete ───►│
   │ synthesize(reply) ──────────────────────────────────────────► │
   │ ◄────────────────────────── wav ──────────────────────────────┤  tts_complete ►│
   │ play(wav) ──► │  （同時にバージイン監視の capture）        speaking_* ────►│
   │ ◄─ finished ──┤
   │ turn_complete / followup_wait ───────────────────────────────────────────────►│
```

### 5.2 フォローアップ（連続会話）

- `conversation.followup_enabled = true` のとき、応答後に `followup_timeout_seconds` だけ
  「発話待ち」の録音を行う（`startTimeoutMs = followup_timeout_seconds × 1000`）。
- 応答直後のエコーを避けるため、待機前に `followup_guard_ms` だけスリープする。
- `max_followup_turns` に達するか、無音タイムアウトで `idle` に戻る。

### 5.3 バージイン（発話による割り込み）

1. TTS 音声の再生を開始（`speaking_started`）
2. 同時に `AudioIO.capture()` をバージイン監視として開始
   - しきい値 = `max(audio.silence_threshold, conversation.barge_in_min_score)`
   - `onSpeechStart` で `playback.stop()` → `{type:"barge_in"}`
3. 再生が自然終了した場合は監視 capture を `stop("aborted")` して破棄
4. バージインが成立した場合は、その capture の結果（WAV）を**次ターンの入力**としてループに戻す

---

## 6. 音声処理の設計（`AudioService` + `VadEngine`）

### 6.1 録音（As-Is の `execSync` を廃止）

```text
ffmpeg -hide_banner -loglevel error \
  -f dshow -audio_buffer_size 50 -i audio=<デバイス名> \
  -ac 1 -ar 16000 -f s16le -
```

- `spawn` + 引数配列で起動するため、デバイス名の空白・日本語・記号をそのまま渡せる（シェル非経由）。
- WAV ファイルを作らず、stdout の PCM を 20ms フレームに分割して VAD に流す（イベントループを止めない）。
- デバイス名が未設定なら `ffmpeg -list_devices` の出力から最初の `(audio)` デバイスを自動選択。
- **録音セッションは直列化**する（`AudioService.deviceLock`）。前の ffmpeg が終了して
  `audio.device_settle_ms` 待ってから次を開くため、バージイン監視とフォローアップが競合しない。
  停止要求と同時に spawn された場合は即 kill し、孤児プロセスを残さない。
- 終了時は必ず `proc.kill()`。`dispose()` で全子プロセスを掃除。
- 録音終了時は `frames` / `peak` をログ出力し、`frames=0` や `peak` が極端に小さい場合は
  UI にエラー（マイクのミュート・入力レベル・他アプリの使用）を通知する。

### 6.2 VAD アルゴリズム（`VadEngine`）

| ステップ | 処理 |
|----------|------|
| フレーム化 | `sample_rate × 2 × frame_ms / 1000` バイト（既定 640B = 20ms） |
| レベル | RMS を 0..1 に正規化し `input_gain` を乗算 |
| 平滑化 | 指数移動平均 `smoothed = α·level + (1-α)·smoothed`（`smoothing_alpha`） |
| キャリブレーション | 開始 `calibration_duration` 秒は暗騒音の最大値を測定（この間は発話判定しない） |
| しきい値 | `max(silence_threshold, noiseFloor × relative_threshold_multiplier)` |
| 発話開始 | しきい値超えが `debounce_frames` 連続 → `speech_start` |
| プリロール | 発話検出時に `pre_roll_ms` 分を遡って取り込む（語頭の欠落防止） |
| 発話終了 | しきい値未満が `silence_duration` 秒継続 → `silence` |
| タイムアウト | 発話開始前の `startTimeoutMs` 超過 → `no_speech` / 全体 `maxDurationMs` → `max_duration` |
| 中断 | `AbortSignal` / `stop()` → `aborted`、デバイス異常 → `device_error` |

純粋ロジックのため、`tests/vad.test.ts` で擬似フレームを流して全分岐を検証している。

### 6.3 再生

- VOICEVOX の出力は WAV なので `ensureWav()` は**ヘッダ付与しない**（As-Is の二重ヘッダを修正）。
- 再生は `ffplay -nodisp -autoexit` を優先し、無ければ PowerShell `Media.SoundPlayer`。
- 音量は `audio.output_volume`（`ffplay -volume`）。`stop()` で即座に停止可能。

### 6.4 STT / LLM / TTS

| サービス | 実装ポイント |
|----------|--------------|
| `WhisperSttService` | `-ng` は **GPU 無効化**フラグ。`use_gpu = false` のときだけ付与。`-fa` / `-nfa` は設定に従う。`-bs`, `-t`, `--prompt` も反映。タイムアウト・中断・一時ディレクトリの後始末あり。**CUDA 版 whisper.cpp は `scripts/setup-whisper-cuda.ps1` で導入**でき、1.9 系では `main.exe` が廃止（`whisper-cli.exe`）のためスクリプトが互換エイリアスを配置する |
| `OllamaLlmService` | NDJSON の**残りバッファ保持**（チャンク境界対策）、非 200 応答の本文をエラーに含める、`AbortSignal` とアプリ独自タイムアウトの二重防御、`think:false` |
| `VoicevoxTtsService` | 応答は常に `Buffer`。`/audio_query` の `speedScale` / `pitchScale` / `volumeScale` を設定値で上書き。ステータス異常は本文付きで throw |

### 6.5 ブラウザ録音（既定モード）

`src/frontend/mic.ts` の `BrowserMic` が担当する。

| 項目 | 実装 |
|------|------|
| マイク取得 | `navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })` |
| 取り込み | `AudioContext` + `AudioWorklet`（Blob URL でプロセッサを登録、追加ファイル不要）。未対応環境は `ScriptProcessor` にフォールバック |
| 自動再生ポリシー | クリック操作中に `AudioContext` を生成して `resume()`。許可ダイアログ待ちで suspend に戻った場合は再度 `resume()` し、それでも駄目なら次のクリックで再開（`pointerdown` を 1 回だけ購読） |
| 診断 | `diagnostics()` が `ctx` / `rate` / `device` / `muted` / `samples` / `secure` を返し、失敗時のトーストに表示 |
| リサンプル | `AudioContext({ sampleRate: 16000 })` を要求。実際のレートが異なる場合は `resample()` で 16kHz に変換 |
| VAD | **サーバーと同一の `VadEngine`**（`src/shared/audio/vad.ts`）。20ms フレームで判定 |
| 送信 | 発話確定時に WAV を生成 → Base64 → `submit_audio`（`format: "wav"`, `sampleRate: 16000`） |
| フォローアップ | 応答後に `followup.timeoutMs` だけ待機して再録音（`turn_complete` 後にクライアントがループ）。`keepListening` が true の間は上限後も「停止」まで継続 |
| マイク確認 | 画面の「マイク確認」で 5 秒だけ録音し、`frames` / `peakLevel` / dBFS を表示（送信しない）。無音・無データ時の切り分けに使う |
| バージイン | 再生中（`speaking_started`）に監視録音を開始し、`onSpeechStart` で `stop_speaking` を送信。取得した発話は次ターンとして送信 |
| 無音・失敗時 | `frames === 0` / `peakLevel` が極小ならトーストで原因（許可・ミュート・入力レベル）を案内 |
| デバイス選択 | 画面の「マイク」セレクト（`enumerateDevices`）。切替時は `stopStream()` → 再オープン |

サーバーは受け取った WAV を `src/backend/server/audioPayload.ts` で検証する
（Base64・サイズ上限 8MB・RIFF/WAVE・16bit モノラル）→ `ConversationPipeline.submitAudio()` で
「STT → LLM → TTS → 再生 → `turn_complete`」を 1 ターン実行する。サーバー側の録音・フォローアップは行わない。

---

## 7. プロトコル仕様

### 7.1 REST API

| メソッド | パス | 内容 |
|----------|------|------|
| GET | `/api/health` | 稼働時間・LLM/TTS/STT の疎通・音声デバイス数・設定警告（`HealthReport`） |
| GET | `/api/state` | `{ state, busy }` |
| GET | `/api/character` | キャラクター定義（name/label/personality/responseRules/catchphrases） |
| GET | `/api/config` | 設定（`home_assistant.token` などはマスク） |
| PATCH | `/api/config` | 設定の部分更新（マージ → 検証 → `settings.toml` 保存） |
| POST | `/api/config/reload` | 設定とキャラクターを再読み込み |
| GET | `/api/history` | `{ messages: ChatMessage[] }` |
| DELETE / POST | `/api/history`, `/api/history/clear` | 履歴クリア |
| GET | `/api/audio-devices` | 入力デバイス一覧（`ffmpeg -list_devices` 由来） |
| POST | `/api/tts` | `{text}` を読み上げ（会話履歴には残さない） |

### 7.2 WebSocket `/ws`

接続直後にサーバーから `hello` を送る（状態・履歴・キャラクター名・バージョン・サービス疎通）。
30 秒間隔の ping/pong で死活監視し、無応答クライアントは `terminate()`。

```ts
type ClientCommand =
  | { type: "start_listening" }                   // 聞き取り開始（server モードのみ）
  | { type: "stop_listening" }                    // 中断
  | { type: "submit_text"; text: string }          // テキスト入力（STT スキップ）
  | { type: "submit_audio"; format: "wav"; sampleRate: number; data: string } // ブラウザ録音の発話（Base64 WAV）
  | { type: "speak"; text: string }                // 読み上げのみ
  | { type: "stop_speaking" }                      // 再生停止（ブラウザ側のバージイン）
  | { type: "simulate_wakeword"; phrase?: string } // 疑似ウェイクワード
  | { type: "clear_history" }
  | { type: "get_state" }
  | { type: "ping" };

type ServerMessage =
  | HelloPayload
  | { type: "event"; event: PipelineEvent }
  | { type: "state"; state: AssistantState }
  | { type: "history"; messages: ChatMessage[] }
  | { type: "error"; message: string }
  | { type: "pong" };
```

### 7.3 PipelineEvent

| イベント | 用途 |
|----------|------|
| `state` | 状態機械の遷移（UI のステータス表示） |
| `wakeword_detected` | 起動トリガー（句） |
| `recording_started` / `level` / `recording_stopped` | 録音開始・レベルメーター（10Hz）・終了理由 |
| `stt_started` / `stt_complete` | 認識開始・結果（本文・言語・所要時間） |
| `llm_started` / `llm_delta` / `llm_complete` | 生成開始・差分・全文 |
| `tts_started` / `tts_complete` | 音声合成の開始・所要時間 |
| `speaking_started` / `speaking_finished` / `barge_in` | 再生ライフサイクルと割り込み |
| `followup_wait` | 連続会話の待機（残りターン・タイムアウト） |
| `turn_complete` | 1 ターン完了（ターン番号） |
| `history_updated` | 履歴の権威あるスナップショット（UI はこれで再描画） |
| `error` | `scope`（audio/stt/llm/tts/pipeline）付きのエラー |

---

## 8. 設定スキーマの変更点

### 8.1 追加したキー

| テーブル | キー | 既定値 | 意味 |
|----------|------|--------|------|
| `audio` | `frame_ms` | 20 | VAD のフレーム長 |
| `audio` | `pre_roll_ms` | 300 | 発話検出時に遡る長さ |
| `audio` | `output_volume` | 1.0 | 再生音量（0..1） |
| `audio` | `ffmpeg_path` | `""` | ffmpeg の明示パス |
| `audio` | `player` | `"auto"` | `auto` / `ffplay` / `soundplayer` |
| `conversation` | `auto_start` | `false` | 起動直後に録音を始めるか（As-Is は実質 true 固定） |
| `conversation` | `keep_listening` | `true` | フォローアップ上限後も「停止」まで聞き取りを続ける |
| `audio` | `input_mode` | `"browser"` | `browser`（getUserMedia）/ `server`（ffmpeg） |
| `audio` | `device_settle_ms` | 250 | 録音セッション間の待機（server モードのデバイス競合対策） |
| `stt` | `binary_path` | `whisper.cpp/main.exe` | whisper.cpp の実行ファイル |
| `stt` | `threads` | 4 | 推論スレッド数（`-t`） |
| `stt` | `timeout_seconds` | 60 | 認識タイムアウト |
| `stt` | `initial_prompt` | `""` | 認識ヒント（`--prompt`） |
| `llm` | `history_turns` | 6 | プロンプトに含める直近ターン数 |
| `tts` | `timeout_seconds` | 30 | 音声合成タイムアウト |

### 8.2 既定値・意味の変更

| キー | As-Is | To-Be | 理由 |
|------|-------|-------|------|
| `audio.max_record_seconds` | 10 | 12 | 「固定録音時間」から「1 発話の上限」へ意味変更 |
| `audio.silence_threshold` | 0.03 | 0.02 | 相対しきい値（暗騒音×倍率）との併用を前提に調整 |
| `audio.no_speech_timeout` | 3.0 | 3.0 | 参考実装（Sumika v0.3.x）に合わせて維持（ブラウザ録音でも同じ待機時間） |
| `conversation.max_followup_turns` | 2 | 3 | 参考実装（Sumika v0.3.x）に合わせて 3 に戻した |
| `conversation.followup_guard_ms` | 400 | 250 | 参考実装と同じ待機時間 |
| `audio.input_gain` | レベル計算のみ | 実サンプルにも適用 | 小さいマイク入力を実際に増幅できるようにした |
| `conversation.barge_in_min_score` | 0.5 | 0.08 | **RMS（0..1）しきい値**として定義し直した |
| `llm.response_timeout_seconds` | 30 | 60 | 長文応答の打ち切り防止 |
| `stt.use_gpu` | 意味が逆 | `true` = GPU 使用 | `-ng` の付与条件を修正 |

### 8.3 既存 `settings.toml` からの移行

1. 未指定キーは既定値で補完されるため、**追記なしでも起動可能**。
2. ただし以下は値の見直しを推奨:
   - `conversation.barge_in_min_score = 0.08`（旧 0.5 のままだとバージインしない）
   - `conversation.auto_start`（旧挙動に戻したい場合のみ `true`）
   - `stt.use_gpu`（GPU を使わない環境では `false`）
3. `PATCH /api/config` で更新すると `settings.toml` は
   **コメント無しの正規化された TOML** として再生成される（手書きコメントは失われる）。

---

## 9. As-Is 課題への対応表

| As-Is 課題 | 対応 | 実装箇所 | 検証 |
|------------|------|----------|------|
| 1. VOICEVOX バイナリ破損 | 応答を常に `Buffer` で受ける | `VoicevoxTtsService.request()` | `tests/voicevox-binary.test.ts` |
| 2. WAV 二重ヘッダ | `ensureWav()` で RIFF を判定 | `services/wav.ts` / `AudioService.play()` | `tests/wav.test.ts` |
| 3. `-ng` の意味が逆 | `use_gpu=false` のときだけ付与 | `WhisperSttService.buildArgs()` | コードレビュー（実機依存） |
| 4. `execSync` ブロッキング | `spawn` + ストリーム + VAD | `AudioService.capture()` | スモークテスト（HTTP 応答維持） |
| 5. デバイス名の文字列連結 | `spawn` の引数配列 + 自動検出 | `AudioService.runCapture()` | スモークテスト（日本語デバイス名で成功） |
| 6. 固定 10 秒録音 | VAD による自動区切り | `services/vad.ts` | `tests/vad.test.ts` |
| 7. フォローアップ未実装 | ターンループで継続 | `ConversationPipeline.runLoop()` | `tests/pipeline.test.ts` |
| 8. NDJSON の欠落 | 受信バッファに残りを保持 | `OllamaLlmService.chatStream()` | `tests/ollama-stream.test.ts` |
| 9. ストリーム表示の上書き | 差分を追記して保持 | `frontend/app.ts appendStreamChunk()` | 手動確認 |
| 10. 私有フィールドへの文字列アクセス | DI で `AudioIO` を注入 | `index.ts` → `AppServer` → `ApiRouter` | 型チェック |
| 11. `Partial` のキャスト | `DEFAULT_CONFIG: AppConfig` | `config/schema.ts` | 型チェック |
| 12. 設定 API・CWD 依存 | `getMasked/update/save` + `rootDir` 解決 | `config/ConfigManager.ts` | `tests/config.test.ts` |
| 13. キャンセル不可 | `AbortController` を全経路に | `ConversationPipeline` / services | `tests/pipeline.test.ts` |
| 14. 勝手に録音開始 | `conversation.auto_start`（既定 false） | `ConversationPipeline.start()` | 手動確認 |
| 15. CORS/認証/巨大ボディ | `express.json({limit:"1mb"})`、認証は非目標として明記 | `server/AppServer.ts` | — |
| 16. 子プロセス残留 | `dispose()` + グレースフルシャットダウン | `AudioService.dispose()` / `index.ts` | 手動確認 |
| 17. キャラクター部分抽出 | TOML パーサで全項目読み込み | `services/CharacterService.ts` | `tests/character-prompt.test.ts` |
| 18. ロガー不在 | レベル付きロガー + `logs/app.log` | `core/logger.ts` | スモークテスト |
| 19. 未実装機能の乖離 | 設定ファイルに「未実装」と明記し、ロードマップ化 | 本書 §11 | — |
| 20. テスト不在 | `node:test` による 37 ケース + `typecheck` + `smoke` | `tests/`, `package.json` | `npm test` |

---

## 10. テスト戦略

| 種別 | 対象 | 実行 |
|------|------|------|
| 単体（純粋ロジック） | `wav.ts`（WAV / RMS / 長さ / ゲイン）、`vad.ts`（終了理由・キャリブレーション・中断）、`merge` / `sanitize` / `tomlSerializer`、`ConversationHistory` | `npm test` |
| 結合（ローカル HTTP） | `OllamaLlmService`（NDJSON の分割受信）、`VoicevoxTtsService`（バイナリ透過・パラメータ反映） | `npm test` |
| 結合（DI フェイク） | `ConversationPipeline`（無音 / 1 ターン / テキスト入力 / フォローアップ / バージイン / 中断 / ブラウザ音声 1 ターン / ブラウザモードの録音拒否） | `npm test` |
| ブラウザ実行 | ビルド済み `app.js`（IIFE）を擬似 DOM で実行し、WS 接続・hello 描画・ボタン送信・`file://` 案内を検証 | `npm test` |
| プロトコル | `submit_audio` の Base64/WAV/サイズ/形式の検証 | `npm test` |
| 型 | 全ソース | `npm run typecheck` |
| スモーク（実プロセス） | 起動 → `/api/health` → `/api/config` → `/api/audio-devices` → WS `hello/get_state/ping` | `npm start` した状態で `npm run smoke` |

補足:

- テストは `tsconfig.test.json` で `dist-test/` に出力し、`node --test "dist-test/tests/*.test.js"` で実行する。
- 設定を扱うテストは**一時ディレクトリに `config/` をコピー**して実行し、実設定を書き換えない。
- 実マイク・実 VOICEVOX に依存する部分はフェイクで代替（自動テスト対象外）。

---

## 11. 未実装・拡張ポイント（ロードマップ）

| 項目 | 現状 | 拡張の指針 |
|------|------|------------|
| ウェイクワード | UI / API トリガーのみ（`wakeword.*` は予約） | 常時監視ループを追加し、`WakeWordDetector` 実装から `handleWakeWord()` を呼ぶ |
| STT の常駐化 | 発話ごとに `main.exe` を起動（毎回モデルロード + 初回 JIT） | 同梱の `whisper-server.exe` を常駐させ HTTP で推論する `SpeechToText` 実装を追加（レイテンシ削減） |
| RAG（`[rag]`） | 未実装 | `LanguageModel` の前段に `Retriever` を挟み、`PromptBuilder` にコンテキスト注入 |
| レシピ DB（`[recipe_db]`） | 未実装 | LLM のツール呼び出し（`ChatOptions.tools` は実装済み）で SQLite を検索 |
| 音楽再生（`[music]`） | 未実装 | `AudioIO.play()` を一般化（WAV 以外は ffplay にパスを渡す）。ダッキングは再生音量の動的制御 |
| Home Assistant（`[apps.home_assistant]`） | 未実装 | ツール経由で REST 呼び出し |
| プロアクティブ発話（`[apps.proactive_speech]`） | 未実装 | スケジューラから `ConversationPipeline.speak()` を呼ぶ（`voice` / `ui` フラグで分岐） |
| 認証・公開 | localhost 前提 | リバースプロキシ + トークン認証、CORS のオリジン限定 |
| 音声出力デバイス指定 | 既定デバイスのみ | `ffplay -audio_device` 等で `audio.output_device` を反映 |

---

## 12. 運用手順

### 12.1 セットアップ

```powershell
npm install
npm run build          # clean → tsc → フロント静的ファイルのコピー
npm test               # 63 ケース（任意）
```

前提: Ollama（`ollama serve`）と VOICEVOX ENGINE を起動しておく。
`llm.model` は `ollama pull` 済みのモデル名にすること（未取得なら起動時に警告が出る）。

NVIDIA GPU がある場合は CUDA 版 whisper.cpp を導入すると認識が大幅に高速化されます:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-whisper-cuda.ps1   # 差し替え
powershell -ExecutionPolicy Bypass -File scripts\setup-whisper-cuda.ps1 -Restore  # 元に戻す
```

### 12.2 起動と確認

```powershell
.\start.bat              # Windows: 依存/ビルド/外部サービスを確認して起動（ブラウザも開く）
.\start.bat /nobrowser   # ブラウザを開かない
npm start                # 直接起動する場合
```

- ブラウザ: `http://localhost:3000`
- 疎通確認: `npm run smoke`（`/api/health` と `/ws` の hello / ping を検証）
- ログ: コンソール + `logs/app.log`

### 12.3 トラブルシュート

| 症状 | 確認ポイント |
|------|--------------|
| 「マイク入力を開始できませんでした」 | `audio.input_device`（空なら自動検出）、`ffmpeg` の PATH、`/api/audio-devices` の一覧 |
| 入力レベルが 0.000 のまま／途中から認識しない | `npm run check-audio` で実測（`frames` と `peak` dBFS）。Windows のサウンド設定・マイクミュートキー・Realtek ドライバを確認 |
| 発話が検出されない | `audio.silence_threshold` を調整、UI のレベルメーター（`level` イベント）を確認 |
| 認識結果が空 | `stt.model_path` / `stt.binary_path` / `stt.language` |
| LLM が 404 | `llm.model` が未取得（起動時警告）、`ollama list` |
| 音声が出ない | VOICEVOX の起動、`audio.output_volume`、`audio.player`（`ffplay` / `soundplayer`） |
| バージインしない | `conversation.barge_in_enabled`、`barge_in_min_score`（RMS, 既定 0.08） |
| 設定が反映されない | `POST /api/config/reload` または再起動（`PATCH /api/config` は即時保存） |

---

## 付録: As-Is / To-Be ファイル対応

| As-Is | To-Be |
|-------|-------|
| `backend/index.ts` | `backend/index.ts`（コンポジションルートに再設計） |
| `backend/config.ts` | `config/schema.ts` + `config/ConfigManager.ts` + `config/merge.ts` + `config/sanitize.ts` + `config/tomlSerializer.ts` |
| `backend/ollama.ts` | `services/OllamaLlmService.ts`（`core/ports.ts` の `LanguageModel` 実装） |
| `backend/voicevox.ts` | `services/VoicevoxTtsService.ts`（`TextToSpeech` 実装） |
| `backend/whisper.ts` | `services/WhisperSttService.ts`（`SpeechToText` 実装） |
| `backend/audio.ts` | `services/AudioService.ts` + `services/vad.ts` + `services/wav.ts` |
| `backend/pipeline.ts` | `conversation/ConversationPipeline.ts` + `ConversationHistory.ts` + `PromptBuilder.ts` + `services/CharacterService.ts` |
| `backend/server.ts` | `server/AppServer.ts` + `server/ApiRouter.ts` + `server/WsHub.ts` |
| `backend/declarations.d.ts` | 削除（未使用の `node-record-lpcm16` 依存も削除） |
| `src/frontend/*` | 全面刷新（型付きプロトコル、レベルメーター、テキスト入力、履歴同期、再接続バックオフ） |




