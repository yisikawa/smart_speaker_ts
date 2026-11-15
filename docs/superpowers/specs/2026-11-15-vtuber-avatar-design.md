# VTuber 化 改造設計（Live2D アバター + ブラウザ音声 + 配信/デスクトップ）

- 日付: 2026-11-15
- 対象: `smart_speaker_ts` v0.3.0（`develop`）
- 参考実装: [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)（`websocket_handler.py` / `utils/stream_audio.py` / `prompts/utils/live2d_expression_prompt.txt`）
- 位置づけ: 実装前の設計（As-Is は `docs/DESIGN.md`、既存の To-Be は `docs/REDESIGN.md`）。実装時は本書のフェーズを `writing-plans` で手順化する。

---

## 1. 目的とゴール

このアプリを「音声アシスタント」から「**自分の PC で完結する VTuber（AI 配信者）**」へ拡張する。

| # | ゴール | 備考 |
|---|---|---|
| G1 | ブラウザに **Live2D アバター**を表示する | ライセンスとアセットが無い環境では CSS 立ち絵（sprite）へ自動フォールバック |
| G2 | 発話に合わせた **口パク**（音量駆動）・**表情**・**モーション** | 音量列はサーバーが生成し、クライアントは再生時刻で引くだけ（OLV 方式） |
| G3 | 音声を **ブラウザ（WebAudio）で再生**する | サーバー再生（ffplay）はフォールバックとして残す。AEC が効くので `docs/TODO.md` 1-3 のエコー問題も同時に解消 |
| G4 | 応答を **文単位でストリーミング**して話し始める | 全文合成を待たない。`SpeechQueue` で 1 文先読み |
| G5 | **ステージモード**（透過背景＋字幕）を追加し、OBS のブラウザソースで配信できる | `?mode=stage` |
| G6 | **デスクトップ／ウィンドウ運用**へ段階的に拡張できる土台を作る | まず Edge/Chrome の `--app`、必要なら Electron（任意フェーズ） |
| G7 | （任意）**視覚入力**（画面共有・カメラ）を LLM に渡す | `[vision]` セクションの実装。マルチモーダルモデル必須 |

### 1.1 非ゴール（今回やらない）

- OLV の「多人数チャットグループ（`chat_group`）」「MCP ツール呼び出し」「音声クローン」「履歴管理 UI」
- VRM / 3D アバター（`three.js` + `@pixiv/three-vrm`）。この PC（GTX 1650 Max-Q 4GB）では重く、Live2D で十分
- クラウド API 依存（localhost 完結・外部送信なしの前提を維持）
- 配信プラットフォームへの自動投稿・コメント読み上げ

### 1.2 受け入れ条件（この改造の完了条件）

1. `http://localhost:3000/?mode=stage` でアバターと字幕のみが表示され、OBS のブラウザソースで背景が透過する。
2. 発話中に口が音声へ追従し、無音時に閉じる（`volumes` 駆動・スライス 20ms）。
3. 応答の**1 文目**が確定した時点で読み上げが始まる（全文合成を待たない）。本機で初声までの体感が 1 秒台に入る。
4. 感情タグ（例 `[喜]`）で表情が切り替わり、タグを LLM が出さない場合もヒューリスティックで破綻しない（表情が張り付かない）。
5. `audio.playback_target = "server"` に戻せば従来どおり ffplay で鳴る（**後方互換**）。
6. `npm run verify` が通る。**Live2D の vendor ファイルとモデルが無い環境でも test / build が成功する**（sprite フォールバック）。
7. `SpeechGate` の破棄統計・`turn_skipped` 通知・`commandHandlers` の完全マップなど、既存の不変条件を壊していない（`tests/` の回帰が緑）。

---

## 2. 参考実装（OLV）から取り込む／取り込まない

| OLV の要素 | このリポジトリでの扱い |
|---|---|
| `{"type":"audio","audio":base64,"volumes":[...],"slice_length":20,"display_text":{...},"actions":{"expressions":[...]}}` を WS で送り、**ブラウザで再生** | **取り込む**（`tts_audio` イベントとして実装。フィールド名は OLV に寄せる） |
| 口パク = 20ms スライスの RMS を最大値で正規化した `volumes` を再生時刻で引く | **取り込む**（サーバー側で計算。純粋関数として `src/shared` に置く） |
| プロンプトに `[expression1]` を列挙し、本文に混ぜさせる | **取り込む**（日本語の意味キー `[喜]` 等 → 設定でモデルの表情名へ写像） |
| `SentenceDivider` による文単位ストリーミング TTS | **取り込む**（ただし日本語特化の軽量実装。`pysbd` は使わない） |
| `set-model-and-conf` でキャラ設定とモデル情報を配る | **取り込む**（`hello.avatar` に同梱） |
| `interrupt-signal` / `mic-audio-*` でサーバー側が録音を駆動 | **取り込まない**。本アプリはブラウザが録音を駆動する既存設計を維持（`AGENTS.md` 12-4） |
| `chat_group` / MCP / `web-tool` / 履歴管理 | **取り込まない**（非ゴール） |
| Electron / デスクトップモード | **段階的に**。まず `--app` ウィンドウ、OBS 透過を先に成立させる |

> ねらい: OLV の「**音声をクライアントへ送り、音量列で口パク**」という一番効く部分だけを、このリポジトリの DI / ports / shared プロトコル / `node:test` の作法に翻訳して入れる。

---

## 3. 全体アーキテクチャ

```
┌────────────────────────── ブラウザ ──────────────────────────┐
│ index.html (?mode=chat|stage)                                │
│  ├─ WsClient ── WS ──────────────────────────────┐           │
│  ├─ MicLoop（既存: 録音・VAD・バージイン監視）      │           │
│  ├─ AudioPlayer  ← tts_audio（base64 WAV + volumes）│           │
│  │     └─ AudioContext(24k) → GainNode(output_volume)         │
│  │            └─ 再生時計（currentTime） ─→ LipSyncDriver      │
│  └─ AvatarStage                                        │      │
│        └─ AvatarRenderer（Live2D | Sprite | None）      │      │
│              ↑ setMouth(0..1) / setExpression(name) / playMotion
└─────────────────────────────────────────────────────────┼─────┘
                                                          │
┌──────────────────────── サーバー ────────────────────────┼─────┐
│ index.ts（Composition Root）                             │     │
│  ConfigManager / CharacterService                        │     │
│  AudioService(ffmpeg, ffplay) ── 録音 & サーバー再生       │     │
│  SttSwitcher / OllamaLlmService / VoicevoxTts            │     │
│                                                          ▼     │
│  ConversationPipeline ── TurnRunner ── SpeechQueue ── PlaybackRouter
│        │                    │              │             │      │
│        │               SentenceSplitter    └─ PlaybackSink(port)│
│        │               (shared/text)            ├─ ServerSink = AudioService
│        │                                        └─ BrowserSink = WsPlaybackSink ── WsHub.broadcast → クライアント
│        └─ PipelineEvent（既存 + tts_audio / avatar_*）          │
│  AppServer(ApiRouter + WsHub + ServiceMonitor)                  │
└─────────────────────────────────────────────────────────────────┘
```

**依存方向（既存規約の維持）**
- `shared` は純粋ロジックのみ（`text/sentenceSplitter.ts` / `avatar/lipSync.ts` / `avatar/emotion.ts` / `audio/envelope.ts`）。
- `core/ports.ts` に `PlaybackSink` を追加。`services` は `server` を import しない。
- クライアント再生の実装（`WsPlaybackSink`）は **`server/` 層**に置き、`index.ts` で配線する。
- `PipelineEvent` を単一のイベントストリームとして維持（新しい媒体も同じ列に載せる。順序が壊れない）。

---

## 4. 音声経路（中核）

現状: `TurnRunner` が全文を 1 回 TTS → `AudioService.play(wav)`（ffplay / SoundPlayer）→ ブラウザには音が渡らない。
変更後: `PlaybackSink` 抽象を挟み、設定で「サーバー再生」と「ブラウザ再生」を切り替える。

### 4.1 新しいポート

`src/backend/core/ports.ts` に追加（`AudioIO` はそのまま録音・サーバー再生の実装として残す）。

```ts
export interface PlaybackMeta {
  /** 発話単位の一意 ID（クライアントの完了通知と突き合わせる） */
  utteranceId: string;
  /** 表示用テキスト（感情タグは除去済み） */
  text: string;
  /** 感情タグから解決した表情名（未指定なら undefined） */
  expression?: string;
  motion?: { group: string; index: number };
  /** 20ms スライスごとの 0..1（口パク用）。サーバー再生では未使用 */
  volumes: number[];
  sliceMs: number;
  durationMs: number;
}

export interface PlaybackSink {
  readonly kind: "server" | "browser";
  /** この sink が今すぐ使えるか（クライアント未接続なら false） */
  isAvailable(): boolean;
  play(wav: Buffer, meta: PlaybackMeta): PlaybackHandle;
}
```

- `ServerPlaybackSink`: `AudioService.play()` をそのまま包むだけ（`volumes` は無視）。`isAvailable()` は常に `true`。
- `BrowserPlaybackSink`（`src/backend/server/WsPlaybackSink.ts`）: `WsHub` 経由で `tts_audio` を送り、クライアントの `audio_playback_done` を待つ。
- `volumes` は `SpeechQueue` が `buildVolumeEnvelope()` で WAV から作る（空配列ならクライアントは口を閉じる）。
- `PlaybackRouter`（`src/backend/conversation/PlaybackRouter.ts`）: `audio.playback_target` と `isAvailable()` を見て実 sink へ委譲。**片方が使えないときはもう片方へフォールバック**（ログ warn 1 行）。

```ts
// 使い方（PlaybackLoop / TurnRunner から見た形）
const playback = this.playback.play(wav, meta);
await playback.finished;   // クライアント再生でも「鳴り終わる」まで待つ
```

### 4.2 クライアント再生の完了待ち（必ず解けること）

`speaking` 状態が永久に続くと画面が固まる（`AGENTS.md` 16 の教訓と同じクラスの事故）。したがって:

| 契機 | 挙動 |
|---|---|
| クライアントが `audio_playback_done` を送る | 即 resolve |
| `stop_speaking` / `AbortSignal` / `stop()` | 即 resolve（クライアントにも停止指示） |
| `durationMs + 1500ms` 経過 | タイムアウトで resolve し、`warn` ログ（「クライアントが完了通知を返さない」） |
| 送信時点で表示クライアントが 0 台 | `isAvailable()=false` → ルータがサーバー再生へフォールバック |

### 4.3 口パク用の音量列（`volumes`）

`src/shared/audio/envelope.ts`（純粋・テスト対象）:

```ts
/** 16bit PCM（WAV はヘッダを除いて渡す）から 20ms ごとの RMS を求め、最大値で正規化する */
export function buildVolumeEnvelope(pcm: Int16Array, sampleRate: number, sliceMs = 20): number[];
/** 再生経過時間から口の開き（0..1）を引く。線形補間 + アタック/リリースで平滑化 */
export function mouthLevelAt(volumes: number[], sliceMs: number, elapsedMs: number, smoothing: number): number;
```

- 正規化は OLV と同じ「最大値で割る」。全部 0（無音）の場合は空配列を返し、クライアントは口を閉じる。
- **なぜサーバー計算か**: 決定論的でテストでき、`AnalyserNode` の実装差に依存しない。将来 Opus チャンク配信へ変えても `volumes` の契約はそのまま使える。

### 4.4 再生側（フロント）

`src/frontend/AudioPlayer.ts`
- `tts_audio` を受けたら base64 → `ArrayBuffer` → `AudioContext.decodeAudioData()`（VOICEVOX の WAV はそのまま解釈できる）。
- `GainNode` に `audio.output_volume` を適用（サーバー再生時の ffplay `-volume` 相当）。
- 文単位でキューイングし、**前の文が終わったら次を即再生**（`speaking_started` はターン最初、`speaking_finished` は最後）。
- `stop()` は再生ノードを停止し、キューを捨てる（バージイン・停止ボタン）。
- 各文の再生完了で `{ type: "audio_playback_done", utteranceId }` を送る。

`AudioContext` は既存のマイクと同じく**ユーザー操作の中で resume** する（`AGENTS.md` ハマりどころ 3）。`MicLoop` が既に持つ `pointerdown` 再開処理を `AudioPlayer` にも適用する。

### 4.5 多重再生とプライマリクライアント

複数タブを開くと二重に鳴る。`WsHub` の `connection` ハンドラは `req.url` を見て役割を決める。

```
http://localhost:3000/?mode=stage&role=display   ← 音声を鳴らす表示クライアント（OBS / デスクトップ）
http://localhost:3000/                           ← 操作クライアント（音声は鳴らさない）
```

- `role=display` が接続していればそれを優先。無ければ最初に接続したクライアント。
- **`tts_audio` は `WsHub` の通常ブロードキャストに載せない**。`WsHub.sendToPrimary(message)` を新設し、primary にだけ送る（他のイベントは従来どおり全配信）。字幕だけ欲しいタブは `caption` イベントで足りる。
- `hello.audio` に `playbackTarget` と `isPrimary` を追加して、画面側で「このタブは再生担当か」を表示できるようにする。

### 4.6 エコー（`docs/TODO.md` 1-3 の解消）

- ブラウザ再生になると `getUserMedia({ echoCancellation: true })` が自分の声を消せる。**バージインの本命対応**。
- ただし既定値はすぐには変えない。フェーズ P1 の受け入れで「3 往復連続で誤検知 0」を実測してから `conversation.barge_in_enabled` の既定を `true` に変更する（変更する場合は README / `AGENTS.md` も更新）。
- `MicLoop.startBargeMonitor()` は現状「再生中にもう 1 本 `listen` を開く」実装。ブラウザ再生に移行後もこの方式で動くが、P2 以降で「常時ストリーム + VAD」に置き換える余地を残す（今回は変更しない）。

---

## 5. 会話の文単位ストリーミング

### 5.1 文分割（純粋ロジック）

`src/shared/text/sentenceSplitter.ts`

```ts
export interface SentencePiece {
  /** TTS へ渡す文（感情タグ除去済み） */
  text: string;
  /** その文で発火する表情（最後に現れたタグ） */
  expression?: string;
  /** 元の断片（デバッグ用） */
  raw: string;
}

export class SentenceSplitter {
  /** LLM の差分を食わせ、確定した文だけを返す（未確定は内部バッファに残す） */
  push(delta: string): SentencePiece[];
  /** ストリーム終端で残りを吐く */
  flush(): SentencePiece[];
}
```

- 区切り: `。！？!?…` と改行。`、` は**文が長すぎるときだけ**（既定 40 文字超）分割に使う。
- 最小文字数（既定 4）未満の断片は次の文と結合（「はい。」だけで TTS を叩かない）。
- 感情タグ `[喜]` 形式を抽出して `text` から除去（TTS に読ませない）。未知タグは無視して `debug` ログ。
- **テスト**（`tests/sentence-splitter.test.ts`）: 日本語の句点、絵文字、`……`、英語の `Mr.`、タグのみの差分、チャンク境界がタグの途中で切れるケース。

### 5.2 `SpeechQueue`（読み上げの直列化と先読み）

`src/backend/conversation/SpeechQueue.ts`

```
LLM ストリーム ── SentenceSplitter ──► enqueue(piece)
                                          │
                        ┌─────────────────┴──────────────────┐
                        │ 合成ワーカー（prefetch 1）            │  TTS は 1 文先まで並行
                        └─────────────────┬──────────────────┘
                                          ▼
                                    play（順序保証）
```

- 状態: `pending`（未合成）/ `synthesized`（合成済み）/ `playing`。
- `stop()`: 進行中の TTS を `AbortSignal` で中断し、キューを空にし、再生を止め、`speaking_finished` を 1 回だけ出す。
- 例外: TTS が 1 文失敗しても**残りは読み上げる**（現状の「TTS 失敗でターン全体を捨てる」より体験が良い）。ただし全滅なら `error` イベント。

### 5.3 `TurnRunner` の変更

| 現状 | 変更後 |
|---|---|
| `chatStream` で全文取得 → 言語ガード（ハングル検出で 1 回再生成）→ 全文 TTS → 再生 | `chatStream` の差分を `SentenceSplitter` へ流し、**文が確定するたびに `SpeechQueue` へ積む**。再生は `SpeechQueue` が直列に行う |
| `llm_complete` は全文確定後に 1 回 | 同じ（表示は全文で確定させる） |
| 言語ガードは全文に対して 1 回 | **文ごとに検査**し、ハングルを検出したら「読み上げを中断 → 既存の再生成 → `speech_reset` を出して最初から読み直す」。画面は `llm_complete` の全文で上書きされるので破綻しない |

- `speaking_started` は最初の文の再生開始時、`speaking_finished` は最後の文の完了時（または中断時）に 1 回だけ。
- `TurnHooks.play(wav)` は `TurnHooks.speak(piece)` へ置き換え、`PlaybackLoop` は「1 文を鳴らす」責務に縮小（バージイン監視の扱いは現状維持）。

### 5.4 遅延の目安（この PC）

| 段階 | 現状 | 変更後 |
|---|---|---|
| 1 文目が確定するまで | 全文生成完了まで（数秒） | LLM が最初の「。」を出すまで（0.3〜1 秒） |
| 初声まで | 全文 TTS（2〜5 秒） | 1 文 TTS（0.3〜0.8 秒）+ 先読みで 2 文目以降は待ちなし |

---

## 6. アバター描画（フロント）

### 6.1 レンダラ抽象（Live2D が無くても壊れない）

`src/frontend/avatar/`

```ts
export interface AvatarRenderer {
  /** モデルを読み込む（失敗したら throw。呼び出し側が sprite へフォールバック） */
  load(info: AvatarModelInfo, container: HTMLElement): Promise<void>;
  /** 口の開き 0..1（毎フレーム呼ばれる） */
  setMouth(level: number): void;
  /** 表情（設定の expression_map で解決済みのモデル表情名） */
  setExpression(name: string | null): void;
  /** モーション（グループ名と番号。未定義なら無視） */
  playMotion(group: string, index?: number): void;
  resize(width: number, height: number): void;
  destroy(): void;
}
```

| 実装 | 用途 |
|---|---|
| `Live2DRenderer` | 本命。`pixi.js` + `pixi-live2d-display`（Cubism 4）。モデルの `Expressions` / `Motions` / `Parameters`（`ParamMouthOpenY`）を使う |
| `SpriteRenderer` | フォールバック。立ち絵画像 + 口差分（`mouth_open.png` / `mouth_half.png` / `mouth_close.png`）+ 表情差分。vendor もモデルも無い環境（CI 含む）で動く |
| `NullRenderer` | `avatar.enabled = false` のとき。何もしない |

`AvatarStage`（`src/frontend/avatar/AvatarStage.ts`）が
`AvatarRenderer` + `LipSyncDriver` + ウィンドウリサイズ + 背景をまとめる。

```ts
const stage = new AvatarStage(hello.avatar);
await stage.mount(document.getElementById("stage")!);  // 失敗時は自動で sprite → null へ
stage.onExpression((name) => ...);
```

### 6.2 Live2D の導入（vendor とライセンス）

- `live2dcubismcore.min.js`（Cubism Core）は **npm に無く、Live2D 社のライセンス下**にある。リポジトリへコミットしない。
  - `scripts/setup-live2d.ps1` で `vendor/live2d/` へ配置（手動ダウンロードの手順も README に書く）。
  - `vendor/` と `live2d-models/` は `.gitignore` に追加。
- `pixi.js` / `pixi-live2d-display` は `devDependencies`（esbuild でバンドル）。
  - バンドルサイズが膨らむため、**`vendor/live2d/` の Core だけは `<script>` で先に読み込み**、アプリ側は `window.Live2DCubismCore` を待つ。
  - 実装初日に **0.5 日スパイク**で「pixi 7 + `pixi-live2d-display` の版の組み合わせ」「esbuild での IIFE バンドル可否」「Hiyori 等サンプルモデルの表示」を確認して版を固定する（`AGENTS.md` の「フロントは必ず esbuild」を維持できること）。
- サンプルモデルは各自用意（Live2D のサンプル利用規約に従う）。無い場合は sprite にフォールバックするので、**CI と初回起動は常に成功する**。

### 6.3 口パク（`LipSyncDriver`）

```ts
// requestAnimationFrame ループ
const level = mouthLevelAt(volumes, sliceMs, player.elapsedMs(), smoothing);
renderer.setMouth(level);
```

- 再生していないときは 0 へ減衰（閉じる）。
- `smoothing` は `avatar.lip_sync_smoothing`（既定 0.4）。大きいほど追従が速く、小さいほど滑らか。
- `avatar.lip_sync_gain`（既定 1.0）で開き量を調整。

### 6.4 レイアウト（チャット / ステージ）

`gui.layout` と `?mode=` の両方で切り替えられる（クエリ優先）。

| モード | 内容 |
|---|---|
| `chat`（既定） | 既存 UI + 上部にアバター（`#stage` を `main` の先頭に置く）。チャットは従来どおり |
| `stage` | アバター全面 + 下部に字幕。ヘッダ・入力欄・設定・診断は非表示（`?mode=stage`）。`?transparent=1` で背景透過 |

- ステージの字幕は `llm_delta`（ストリーミング）と `llm_complete` を使う。`gui.caption_enabled` / `caption_font_size` で制御。
- 透過は `body { background: transparent }` + `#app { background: none }`。OBS のブラウザソースで「カスタム CSS」不要にする。

### 6.5 状態との対応（既存イベントの再利用）

| 状態 / イベント | アバター |
|---|---|
| `idle` | 待機モーション（`avatar.idle_motion_interval_seconds` ごとにランダム） |
| `recording` / `transcribing` | 表情 `neutral`、口は閉じる |
| `thinking` | 表情 `thinking`（設定にあれば）または `neutral` |
| `tts_audio.expression` | その文の再生開始時に表情を切り替え（次の指定まで保持） |
| `speaking_started` / `speaking_finished` | 口パクの有効 / 停止 |
| `barge_in` / `stop_speaking` | 口を即閉じ、表情を `neutral` に戻す |
| `error` | 表情 `sad`（設定にあれば）+ トースト（既存） |

---

## 7. 感情・モーション

### 7.1 タグ方式（OLV 互換）

- `PromptBuilder` が `avatar.emotion_tags_enabled` のとき、system プロンプトへ「語彙」を追記する。

```
感情表現:
文中に [喜] [怒] [哀] [驚] [照] [考] のいずれかを、文の区切りに 1 つだけ置くこと。
例: 「おはよう！[喜] 今日もいい天気だね。」
使えるのはこの 6 つだけ。文中の単語として書かないこと。
```

- タグ → モデル表情名の対応は `avatar.expressions`（TOML のテーブル）で写像する。モデルごとに名前が違うため、**意味キーを固定し、モデル側の名前を設定で差し替える**。

```toml
[avatar.expressions]
happy     = "exp_01"   # [喜]
angry     = "exp_02"   # [怒]
sad       = "exp_03"   # [哀]
surprised = "exp_04"   # [驚]
shy       = "exp_05"   # [照]
thinking  = ""         # 空なら「表情を変えない」
```

- 未知のタグは無視（`debug` ログ）。タグは必ず TTS 前に除去する。

### 7.2 ヒューリスティック・フォールバック（小さいモデル対策）

`llama3.2:1b` はタグ指示を守らないことが多い。`src/shared/avatar/emotion.ts`（純粋）で文から推定する。

```ts
export function inferEmotion(text: string): "happy" | "angry" | "sad" | "surprised" | "shy" | "thinking" | null;
```

- 判定材料: `！`/`？` の連続、末尾の「ね」「よ」「だよ」、語彙（ありがとう / ごめん / すごい / 怖い / 恥ずかしい …）。
- 優先順位: **LLM のタグ > ヒューリスティック > 変化なし**（毎文コロコロ変えないよう、同一表情が続く場合はモーションだけ間引く）。
- テストで「タグが無い文でも 8 割方 natural な表情になる」ことを固定（表形式のテストケース）。

### 7.3 モーション

- `avatar.motions` で「意味 → モデルのモーショングループ」を写像（例: `greeting = "Idle"`, `nod = "TapBody"`）。
- 発火条件は最小限: ターン開始時に 1 回（`greeting`）、感情が `happy` のとき `nod`。頻発させない。
- `avatar.idle_motion_interval_seconds`（既定 20、0 で無効）で待機モーション。

---

## 8. 配信・デスクトップ

### 8.1 OBS（ブラウザソース）

1. `http://localhost:3000/?mode=stage&role=display&transparent=1` をブラウザソースに登録（1920×1080 推奨）。
2. 「カスタム CSS」は不要（アプリ側で透過）。音声は OBS の「音声をデスクトップから取得」またはアプリのブラウザ音声をキャプチャ。
3. 字幕はアプリ内で描画（OBS 側のテキストソース不要）。

### 8.2 ウィンドウ運用（Electron なし）

- `scripts/start-window.bat`: Edge / Chrome の `--app=http://localhost:3000/?mode=stage&role=display` で枠なしウィンドウを開く（透過は不可）。
- 透過・常時最前面・クリックスルーが必要になったら **P2（任意）** で Electron を追加する。
  - `desktop/main.js`（`transparent: true`, `frame: false`, `alwaysOnTop`, `setIgnoreMouseEvents(true, {forward:true})`）
  - 依存が 200MB 級になるため、既定では入れない（`npm run desktop` はオプション扱い）。

### 8.3 プライマリクライアントの運用

- OBS 用のタブを `role=display` で開き、操作は通常タブで行う（音声は display 側だけ）。
- 再接続時は `hello.audio.isPrimary` を見て「再生担当」バッジを出す。

---

## 9. 視覚入力（任意フェーズ）

- `[vision]` を実装（`UNSUPPORTED_SECTIONS` から外す）。
  - `enabled` / `source = "screen" | "camera"` / `interval_seconds` / `max_width` / `jpeg_quality`。
- 取得: フロントで `getDisplayMedia`（画面）または `getUserMedia`（カメラ）→ `<canvas>` → JPEG（既定 1024px / 0.7）→ base64。
- 送信: `ClientCommand { type: "submit_text"; text: string; image?: string }`（既存コマンドの拡張）。
- サーバー: `LlmMessage` に `images?: string[]` を追加し、`OllamaLlmService` が `/api/chat` の `messages[].images` へ渡す。
- 制約: **マルチモーダルモデル必須**（`llava` / `qwen2-vl` 等）。`llm.model` が非対応なら `warnings` を出して画像を捨てる（`ServiceMonitor` ではなく `ApiRouter` の `warnings` 経路）。
- プライバシー: 「画面を送る」は明示操作（ボタン）で開始し、`capture_started` をログ・UI に出す。既定は無効。

---

## 10. 設定スキーマ（`src/backend/config/schema.ts` が真実源）

### 10.1 追加・変更

```ts
export interface AudioConfig {
  /* 既存は省略 */
  /** 再生の出力先: server（ffplay）/ browser（WebAudio） */
  playback_target: "server" | "browser";
}

export interface AvatarConfig {
  enabled: boolean;
  /** model3.json のパス（プロジェクトルート基準） */
  model_path: string;
  /** ステージ内の拡大率と位置（0..1 の相対指定） */
  scale: number;
  offset_x: number;
  offset_y: number;
  /** 背景（CSS の色/グラデーション、または /backgrounds/xxx.png） */
  background: string;
  /** 待機モーションの間隔（秒）。0 で無効 */
  idle_motion_interval_seconds: number;
  lip_sync_smoothing: number;
  lip_sync_gain: number;
  /** LLM に感情タグを出させる */
  emotion_tags_enabled: boolean;
  /** タグが無いときに文から表情を推定する */
  emotion_heuristic_enabled: boolean;
  /** 意味キー → モデルの表情名（空文字は「変えない」） */
  expressions: Record<string, string>;
  /** 意味キー → モデルのモーショングループ名 */
  motions: Record<string, string>;
}

export interface GUIConfig {
  /* 既存 */
  layout: "chat" | "stage";
  caption_enabled: boolean;
  caption_font_size: number;
}

export interface TTSConfig {
  /* 既存 */
  split_sentences: boolean;
  prefetch_depth: number;
  min_sentence_chars: number;
  max_sentence_chars: number;
}
```

### 10.2 `settings.default.toml` の追加例

```toml
[audio]
playback_target = "server"   # VTuber 運用では "browser"

[avatar]
enabled = true
model_path = "live2d-models/hiyori/hiyori.model3.json"
scale = 1.0
offset_x = 0.5
offset_y = 0.85
background = "#0f1117"
idle_motion_interval_seconds = 20
lip_sync_smoothing = 0.4
lip_sync_gain = 1.0
emotion_tags_enabled = true
emotion_heuristic_enabled = true

[avatar.expressions]
happy = ""
angry = ""
sad = ""
surprised = ""
shy = ""
thinking = ""

[gui]
layout = "chat"
caption_enabled = true
caption_font_size = 34

[tts]
split_sentences = true
prefetch_depth = 1
min_sentence_chars = 4
max_sentence_chars = 60
```

- `npm run config:default` で同期（`tests/config-defaults.test.ts` が陳腐化を検出）。
- `[vision]` は P7 まで `UNSUPPORTED_SECTIONS` に残す。**先に設定だけ足すとテストが落ちる**ため、実装と同時に外す。

### 10.3 既定値の考え方

| 項目 | 既定 | 理由 |
|---|---|---|
| `audio.playback_target` | `server` | 後方互換。README の VTuber 手順で `browser` を推奨 |
| `avatar.enabled` | `true` | モデルが無ければ sprite → null に落ちるので安全 |
| `emotion_tags_enabled` | `true` | タグを守らないモデルでもヒューリスティックが動く |
| `tts.split_sentences` | `true` | 遅延改善の本体。`false` で従来動作 |

---

## 11. プロトコル差分（`src/shared/protocol.ts`）

```ts
/* --- サーバー → クライアント（PipelineEvent に追加） --- */
| { type: "avatar_config"; avatar: AvatarConfigPayload }
| { type: "tts_audio";
    utteranceId: string;
    text: string;            // 感情タグ除去済み
    audio: string;           // base64 WAV
    volumes: number[];       // 20ms スライス 0..1
    sliceMs: number;
    durationMs: number;
    expression?: string;     // モデル表情名（解決済み）
    motion?: { group: string; index: number };
  }
| { type: "avatar_expression"; name: string }
| { type: "avatar_motion"; group: string; index: number }
| { type: "speech_reset" }    // 言語ガード再生成で読み直す
| { type: "caption"; text: string; final: boolean }

/* --- クライアント → サーバー（ClientCommand に追加） --- */
| { type: "audio_playback_done"; utteranceId: string }
| { type: "avatar_ready"; ok: boolean; renderer: "live2d" | "sprite" | "none"; message?: string }

/* --- hello の拡張 --- */
interface HelloPayload {
  /* 既存 */
  avatar: AvatarConfigPayload;
  audio: { /* 既存 */ playbackTarget: "server" | "browser"; isPrimary: boolean };
}

interface AvatarConfigPayload {
  enabled: boolean;
  renderer: "live2d" | "sprite" | "none";
  modelUrl: string;          // /live2d-models/<name>/<name>.model3.json
  scale: number;
  offsetX: number;
  offsetY: number;
  background: string;
  expressions: Record<string, string>;
  motions: Record<string, string>;
  idleMotionIntervalSeconds: number;
  lipSync: { sliceMs: number; smoothing: number; gain: number };
  emotionTags: string[];     // プロンプトと同じ語彙（UI 表示用）
}
```

**規約の順守**
- `ClientCommand` を増やしたら `WsHub.commandHandlers` に必ず実装（`AGENTS.md` 12-5。未実装はコンパイルエラー）。
- `PipelineEvent` は 1 本のストリームのまま。`tts_audio` は `speaking_started` の後、`speaking_finished` の前に必ず来る。
- 古い `dist/frontend` は未知イベントを `default: break` で捨てるため、**サーバーだけ更新しても壊れない**。

---

## 12. ファイル変更一覧

### 新規

| パス | 内容 |
|---|---|
| `src/shared/text/sentenceSplitter.ts` | 文分割 + 感情タグ抽出（純粋） |
| `src/shared/avatar/emotion.ts` | タグ解決 / ヒューリスティック推定（純粋） |
| `src/shared/avatar/lipSync.ts` | `mouthLevelAt()`（純粋） |
| `src/shared/avatar/modelCatalog.ts` | model3.json 候補の正規化・検証（純粋） |
| `src/shared/audio/envelope.ts` | `buildVolumeEnvelope()`（純粋） |
| `src/backend/services/avatarCatalog.ts` | `live2d-models/` のスキャン（fs） |
| `src/backend/conversation/SpeechQueue.ts` | 合成の先読みと再生の直列化 |
| `src/backend/conversation/PlaybackRouter.ts` | server / browser の切替とフォールバック |
| `src/backend/server/WsPlaybackSink.ts` | クライアント再生 sink（送信 + 完了待ち） |
| `src/frontend/AudioPlayer.ts` | WebAudio 再生・キュー・再生時計 |
| `src/frontend/avatar/AvatarStage.ts` | ステージ組み立て |
| `src/frontend/avatar/types.ts` | `AvatarRenderer` / `AvatarModelInfo` |
| `src/frontend/avatar/Live2DRenderer.ts` | pixi-live2d-display 実装 |
| `src/frontend/avatar/SpriteRenderer.ts` | 立ち絵フォールバック |
| `src/frontend/avatar/NullRenderer.ts` | 無効時 |
| `src/frontend/avatar/LipSyncDriver.ts` | rAF で口を動かす |
| `src/frontend/StageView.ts` | stage レイアウト・字幕・透過 |
| `scripts/setup-live2d.ps1` | vendor / モデルの配置確認 |
| `scripts/start-window.bat` | `--app` ウィンドウ起動 |
| `tests/*.test.ts` | 13 章のテスト |

### 変更

| パス | 内容 |
|---|---|
| `src/shared/protocol.ts` | 11 章の差分 |
| `src/backend/core/ports.ts` | `PlaybackSink` / `PlaybackMeta` |
| `src/backend/core/messages.ts` | `LlmMessage.images?: string[]`（P7） |
| `src/backend/config/schema.ts` | `[avatar]` / `[gui]` / `[tts]` / `audio.playback_target` |
| `config/settings.default.toml` | `npm run config:default` で生成 |
| `src/backend/conversation/TurnRunner.ts` | 文単位ストリーミング + `speech_reset` |
| `src/backend/conversation/PlaybackLoop.ts` | 1 文再生に縮小（バージインは現状維持） |
| `src/backend/conversation/ConversationPipeline.ts` | `SpeechQueue` の保持・`stopSpeaking()` の伝播・`avatar_config` 配信 |
| `src/backend/conversation/PromptBuilder.ts` | 感情タグの語彙 |
| `src/backend/server/WsHub.ts` | `role` 判定・primary client・`audio_playback_done` / `avatar_ready` |
| `src/backend/server/ApiRouter.ts` | `GET /api/avatar/models` |
| `src/backend/index.ts` | sink / router / queue の配線 |
| `src/frontend/app.ts` | `AudioPlayer` / `AvatarStage` / `StageView` の組み立て |
| `src/frontend/index.html` / `style.css` | `#stage` / 字幕 / stage 時の非表示 |
| `src/frontend/MicLoop.ts` | 再生完了 ack、`isPrimary` の反映 |
| `README.md` / `docs/REDESIGN.md` / `docs/TODO.md` / `AGENTS.md` | 手順・状態・残作業の更新 |

### 配線（`index.ts`）の注意

`ConversationPipeline` は `AppServer` より先に作られる。`WsPlaybackSink` の送信関数を後から差す必要があるため、
次の形にして循環を作らない（**services → server を import しない規約は維持**）。

```ts
let appServer: AppServer | null = null;
const browserSink = new WsPlaybackSink({
  config,
  send: (message) => appServer?.broadcast(message) ?? false,
  hasPrimaryClient: () => appServer?.hasPrimaryClient() ?? false,
  logger: new Logger("Playback"),
});
const playback = new PlaybackRouter({ config, server: serverSink, browser: browserSink });
// … pipeline 生成 …
appServer = new AppServer({ /* … */ pipeline });
```

`WsHub` は受け取った `audio_playback_done` を `browserSink.resolveDone(utteranceId)` に渡す
（`WsHubDeps` に `onAudioPlaybackDone` を追加）。

---

## 13. テスト計画（`node:test` / `--test-timeout=30000`）

| テスト | 対象 | 主なケース |
|---|---|---|
| `tests/sentence-splitter.test.ts` | `shared/text/sentenceSplitter` | 句点・`！？`・`……`・改行、最小文字数の結合、`max_sentence_chars` の読点分割、タグ抽出、タグがチャンク境界で切れる、`flush()` の残り |
| `tests/audio-envelope.test.ts` | `shared/audio/envelope` | 24kHz/16kHz、20ms のスライス数、正規化（最大 1.0）、全無音で空配列、末尾の端数 |
| `tests/lip-sync.test.ts` | `shared/avatar/lipSync` | 時刻→インデックス、範囲外、線形補間、`smoothing` の単調性、停止時の減衰 |
| `tests/emotion.test.ts` | `shared/avatar/emotion` | タグ解決（未知タグは無視・空文字は変えない）、ヒューリスティックの表駆動ケース |
| `tests/avatar-catalog.test.ts` | `shared/avatar/modelCatalog` ほか | `*.model3.json` の検出、壊れた JSON、`Expressions` / `Motions` の抽出（純粋関数へ切り出す） |
| `tests/speech-queue.test.ts` | `conversation/SpeechQueue` | 順序保証、prefetch 1、1 文失敗でも継続、`stop()` で全中断 + `speaking_finished` 1 回、abort で resolve |
| `tests/ws-playback-sink.test.ts` | `server/WsPlaybackSink` | ack で resolve、タイムアウト（fake timer）、`stop()`、クライアント 0 台で `isAvailable()=false` |
| `tests/prompt-builder-avatar.test.ts` | `PromptBuilder` | タグ語彙が入る / `emotion_tags_enabled=false` で入らない / 既存の言語ルールが最後に残る |
| `tests/playback-router.test.ts` | `conversation/PlaybackRouter` | `server` / `browser` の選択、未接続時のフォールバック |
| `tests/config-defaults.test.ts`（既存） | `schema.ts` ⇔ `settings.default.toml` | 新しい既定値の同期漏れを検出（自動） |

- フロント（DOM / pixi / WebAudio）は**テストしない**。ロジックは `shared` へ寄せて検証する（既存方針）。
- `npm run verify`（typecheck → test → build）を作業後に必ず実行。`pretest` が `dist-test` を掃除する。
- 手動確認（README に手順を書く）: `?mode=stage` の見た目、口パク、表情、OBS 透過、`playback_target=server` への切戻し。

---

## 14. フェーズ・見積・受け入れ条件

| フェーズ | 内容 | 見積 | 受け入れ条件 |
|---|---|---|---|
| **P0** 設定・基盤 | `schema.ts` / `settings.default.toml` / `protocol.ts` の型追加、`GET /api/avatar/models`、`.gitignore` | 1.0 日 | `npm run verify` 緑。`config-defaults` テスト緑。API がモデル 0 件でも 200 を返す |
| **P1** ブラウザ再生 | `PlaybackSink` / `PlaybackRouter` / `WsPlaybackSink` / `AudioPlayer` / `volumes` 生成 / ack / primary client | 2.0 日 | `playback_target=browser` で音が鳴る。`speaking` が必ず終わる（タイムアウト含む）。`server` へ戻すと ffplay で鳴る。3 往復で誤検知 0 を実測 |
| **P2** 文単位ストリーミング | `SentenceSplitter` / `SpeechQueue` / `TurnRunner` 改修 / 言語ガード | 2.0 日 | 1 文目で発話開始。`speech_reset` で読み直し。`stop_speaking` が即座に効く。既存の `turn_skipped` 回帰が緑 |
| **P3** アバター描画（sprite） | `AvatarStage` / `AvatarRenderer` / `SpriteRenderer` / `LipSyncDriver` / stage レイアウト・字幕・透過 | 2.0 日 | `?mode=stage&transparent=1` で透過表示。sprite で口パク。チャットモードが従来どおり動く |
| **P4** Live2D | スパイク（0.5 日）+ `Live2DRenderer` / モデル走査 / 表情・モーション / idle | 2.5 日 | 実モデルで表示・口パク・表情・モーション。モデル不在時は sprite に落ちる（CI 緑） |
| **P5** 感情 | プロンプト語彙 / タグ解決 / ヒューリスティック / モーション発火 | 1.0 日 | タグあり/なし両方で表情が破綻しない。タグが読み上げに混ざらない |
| **P6** 配信・デスクトップ | OBS 手順 / `start-window.bat` / `role=display` 運用 / README | 1.5 日 | OBS で透過・字幕・音声が成立。2 タブで二重再生しない |
| **P7** 視覚入力（任意） | `[vision]` 実装 / `LlmMessage.images` / キャプチャ UI | 2.5 日 | 対応モデルで画像質問が通る。非対応モデルで `warnings` |
| 合計 | P0〜P6 | **12.0 日** | （P7 込み 14.5 日） |

> 進め方: 各フェーズの終わりに `npm run verify` と「受け入れ条件」の手動確認を行い、
> フェーズ単位で `develop` へコミットする（メッセージは日本語で「何を・なぜ」）。
> P1 が終わった時点で `docs/TODO.md` の 1-3（エコー対策）を完了として削除する。

---

## 15. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| Live2D Core / モデルのライセンス | 再配布不可・配信で権利問題 | `vendor/` と `live2d-models/` を `.gitignore`。`scripts/setup-live2d.ps1` と README で「各自取得」を明記。サンプルモデルの商用利用条件にも触れる |
| pixi + pixi-live2d-display の版不整合 | 表示できない・ビルド不能 | P4 冒頭 0.5 日スパイクで固定。esbuild の IIFE バンドルで動く版のみ採用 |
| バンドルサイズ増（pixi 等） | 初回ロードが遅い | localhost なので実害は小さい。必要なら P4 で pixi を vendor `<script>` へ分離 |
| 口パクがずれる（音声と口の位相） | 見た目の質 | 再生時計（`AudioContext.currentTime`）基準で駆動。`lip_sync_gain` / `smoothing` を設定で調整可能に |
| `audio_playback_done` が来ない | `speaking` が固まる（既知の事故クラス） | 必ずタイムアウトで resolve（4.2）。回帰テストで固定 |
| 複数タブで二重再生 | ハウリング・二重音声 | `role=display` の primary client のみに `tts_audio` を送る |
| `llama3.2:1b` がタグを守らない | 表情が動かない | ヒューリスティック併用。README で品質重視なら `gemma3:4b` を推奨（既存の記載を踏襲） |
| 文分割で読み上げが不自然（息継ぎ過多） | 体験低下 | `min_sentence_chars` / `max_sentence_chars` / prefetch 1。`tts.split_sentences=false` で従来動作に戻せる |
| 言語ガードと逐次読み上げの競合 | ハングルを読み上げてしまう | 文ごとに検査し、検出時は `stop` → 再生成 → `speech_reset`。回帰テストを追加 |
| AEC の実効性が環境依存 | バージイン誤検知 | 既定は OFF のまま。P1 受け入れで 3 往復の実測を条件に ON 化を判断 |
| 既存テストの暗黙前提（`TurnRunner` が一括 TTS） | 回帰が多数落ちる | P2 で `tests/` を先に洗い出し、`TurnRunner` のテストを「文単位」の期待に更新（`SpeechQueue` 単体テストを厚くする） |
| `[vision]` を先に設定だけ足す | `config-defaults` テストが落ちる | 実装（P7）と同時に `UNSUPPORTED_SECTIONS` から外す |

---

## 16. 代替案の比較（採用理由）

| 案 | 内容 | 長所 | 短所 | 判定 |
|---|---|---|---|---|
| **案 1（採用）** OLV 方式の移植 | 音声をブラウザ再生 + `volumes` で口パク + 感情タグ + 文単位ストリーミング。レンダラは sprite → Live2D の 2 段 | AEC・口パク・低遅延を同時に解決。純粋ロジックをテストできる。CI がアセット無しで通る | 変更範囲が広い（P0〜P6 で 12 日） | **採用** |
| 案 2 見た目だけ | サーバー再生（ffplay）のまま、口パクは再生中の sin 波。canvas に Live2D を出すだけ | 変更が小さく 2〜3 日 | 口パクが音声と無関係。AEC 問題（TODO 1-3）が残り、配信で音ズレが目立つ。`speaking` の終了時刻も不正確 | 却下 |
| 案 3 VRM / 3D | `three.js` + `@pixiv/three-vrm` で 3D アバター | 配信映え・リップシンク（viseme）が豊か | GTX 1650 Max-Q 4GB では負荷が高く、モデル調達も重い。実装も 2〜3 倍 | 将来オプション（今回は対象外） |

**案 1 を 2 段階（sprite → Live2D）で入れる理由**: Live2D の vendor とモデルが無い環境（CI・初回起動・別 PC）でも
「表示・口パク・字幕」が成立し、`npm run verify` が常に緑になる。`AvatarRenderer` を挟むことで
Live2D → VRM への差し替えも将来可能になる。

---

## 17. 実装前に確定する事項（スパイク）

以下は「未定」ではなく、**実装初日の 0.5 日スパイクで決める**項目（判断基準つき）。

| 項目 | 判断基準 |
|---|---|
| pixi / pixi-live2d-display の版 | `npm run build` の esbuild IIFE で例外なくバンドルでき、Hiyori サンプルが 60fps で動く版 |
| Cubism Core の配置方法 | `vendor/live2d/live2dcubismcore.min.js` を `<script>` で読む方式で動くこと（npm 化しない） |
| `volumes` のスライス長 | 20ms 固定で口の動きが滑らかに見えること（必要なら `avatar.lip_sync_slice_ms` を追加） |
| 感情タグの語彙 | 6 種で足りるか（`expressions` のキーを増やすだけで拡張できる形にする） |
| 既定 `playback_target` | 実測後も `server` を既定に保つ（browser は README の推奨設定） |

---

## 18. 実装後のドキュメント更新

| ファイル | 更新内容 |
|---|---|
| `README.md` | 「VTuber モード」節（Live2D の用意、`playback_target`、`?mode=stage`、OBS 設定、`start-window.bat`）。ライセンス注意 |
| `docs/REDESIGN.md` | 音声経路（PlaybackSink）・文単位ストリーミング・アバター層の設計を追記 |
| `docs/TODO.md` | 1-3（エコー対策）を完了として削除。残作業（Electron / VRM / viseme）を追記 |
| `AGENTS.md` | ハマりどころに「`audio_playback_done` が来なくてもタイムアウトで解く」「`tts_audio` は primary client のみ」「Live2D は vendor 前提で CI では sprite」を追加。現在の状態を更新 |
| `docs/superpowers/specs/` | 本書（実装中に判明した差分は本書へ追記してから実装する） |

---

## 付録 A: 参考にした OLV の実装箇所

| OLV のファイル | 参照した内容 |
|---|---|
| `src/open_llm_vtuber/utils/stream_audio.py` | `tts_audio` 相当の payload（`audio` / `volumes` / `slice_length` / `display_text` / `actions`）と RMS 正規化 |
| `src/open_llm_vtuber/websocket_handler.py` | クライアント→サーバーのコマンド一覧（`text-input` / `mic-audio-end` / `interrupt-signal`）と `set-model-and-conf` |
| `src/open_llm_vtuber/utils/sentence_divider.py` | 文分割とタグ付き文（`SentenceWithTags`）の考え方 |
| `prompts/utils/live2d_expression_prompt.txt` | 感情タグを LLM に混ぜさせるプロンプトの形 |
| `README.md` | 機能一覧（Live2D / 音声割り込み / モジュール構成）とライセンスの注意 |

## 付録 B: 用語

| 用語 | 意味 |
|---|---|
| `utterance` | 1 文ぶんの読み上げ単位（`utteranceId` で ack と対応） |
| primary client | 音声を再生する担当タブ（`role=display`） |
| sprite | Live2D が無いときの 2D 立ち絵フォールバック |
| `volumes` | 20ms スライスごとの RMS（最大値で正規化）。口パクの駆動源 |
