# 潜在バグ優先リファクタリング設計（2026-11-25）

対象: `smart_speaker_ts`（TypeScript / Node.js + ブラウザ GUI / ローカル完結）
基準コミット: `7ec5a07`（main = develop）
作業ブランチ: `develop`
進め方: `docs/REFACTORING_PLAN.md` の P0〜P6 完了後の第 2 期。**挙動を変えるのは「バグ修正」だけ**とし、
それ以外は振る舞い不変のまま構造を 1 箇所へ寄せる。

---

## 1. 背景と目的

P0〜P6 で「二重実装・破棄通知漏れ・設定の手同期」は解消済みだが、**停止（中断）／再接続／設定導出**の
3 系統に、無言で壊れる箇所が残っている。行数削減そのものではなく、**同種の不具合が再発しない形**にする。

利用者から見える症状は次の 3 つに集約される。

1. 停止したのに音が鳴る（ブラウザ再生・サーバー再生の両方）
2. 再接続するとマイクが開いたまま／口パクの更新ループが二重になる
3. 設定を 1 箇所直したつもりが、ブラウザとサーバーで VAD の挙動がずれる

---

## 2. 診断（実コードで確認した潜在バグ）

| # | 事象 | 根拠 | 深刻度 | 対応フェーズ |
|---|---|---|---|---|
| B1 | ブラウザ再生で `stop()` 後にデコードが完了すると再生される | `AudioPlayer.decode()` が `await decodeAudioData` 後に `ready.push → pump()`。`token` 検査は `onended` のみ（`src/frontend/AudioPlayer.ts` 104-146） | 中 | P2 |
| B2 | サーバー再生で `stop()` 後も ffplay が起動し、一時ファイルも残る | `AudioService.play()` の async IIFE は `writeFileSync → await resolvePlayer → spawn` を継続。`resolved` は `complete()` 内でしか見ない（`src/backend/services/AudioService.ts` 336-421） | 中 | P2 |
| B3 | 再接続のたびに `MediaStream` / `AudioContext` / `requestAnimationFrame` が増える | `applyHello()` が `new AudioPlayer` / `new LipSyncDriver` を作り直し旧を破棄しない（`src/frontend/app.ts` 281-299）。`MicLoop.configure()` が `new BrowserMic` で旧ストリームを放置（`src/frontend/MicLoop.ts` 37-43）。`onClose` で `micLoop.stop()` を呼ばない（`app.ts` 66-70） | 中〜高 | P2 |
| B4 | ブラウザモードのバージイン（既定 OFF）で旧音声が止まらない | 検出時は `stop_speaking` 送信のみ（`MicLoop.ts` 151-176）。サーバーは `playback.stop()` だけで `SpeechQueue` を止めず（`ConversationPipeline.ts` 281-284）、`PlaybackLoop` は browser モードで早期 return するため `barge_in` を出さない（`PlaybackLoop.ts` 44） | 中（有効時） | P2 |
| B5 | VAD 設定の導出が 3 箇所 | `AudioService.ts` 91-103 / `WsHub.ts` 117-127 / `mic.ts` 240-261。秒→ms 換算と上限を手写し | 中 | P1 |
| B6 | sherpa のモデル種別が型と配列で二重管理 | `shared/protocol.ts` の `SherpaModelTypeName` と `ApiRouter.ts` 27-32 の `SHERPA_MODEL_TYPES` | 低〜中 | P1 |
| B7 | `errorText()` が 3 箇所 | `app.ts` 412 / `MicLoop.ts` 303 / `SettingsPanel.ts` 67 | 低 | P1 |
| B8 | `/api/models/stt` はルート外の絶対パスも受理する | `ConfigManager.resolvePath()` は絶対パスを素通し | 低（localhost 前提） | P4（文書化） |
| B9 | AGENTS.md / README のテスト件数が陳腐化（「119 件」→ 実測 255 件） | `npm test` の実測（2026-11-25）と `AGENTS.md` 21 行目・`README.md` 328 行目の記載が不一致 | 低 | P4 |

補足: `src/backend/core/childProcess.ts` は `WhisperSttService` が使用中（未使用コードではない）。
`src/backend/services/wav.ts` は既に Buffer 境界アダプタで、二重実装は解消済み。

---

## 3. 目標と非目標

### 目標

1. 停止を**キャンセル可能な 1 経路**にする（ブラウザ再生・サーバー再生の両方）
2. 再接続時に**必ず teardown してから作り直す**（マイク・AudioContext・口パク）
3. 音声設定の導出を **`buildVadSettings()` 1 箇所**にする
4. 型から導出できる検証表（sherpa 種別）を手写ししない
5. 上記を**回帰テストで固定**する（既存テスト 255 件のアサーションは変えない）

### 非目標

- `src/backend/config/schema.ts`（586 行）や `ApiRouter`（342 行）の大分割
- `src/frontend/mic.ts`（361 行）の全面分割（`docs/TODO.md` 2-7 に残す）
- 未実装機能（RAG / レシピDB / 音楽 / プロアクティブ発話 / Home Assistant）の実装
- バージインの既定 ON 化（実測は別作業。本設計は**有効にしたときに正しく止まる**ところまで）
- 認証・外部公開・パス許可リストの導入（B8 は既知の制約として文書化）

---

## 4. 設計方針

### 4.1 単一真実源（P1）

- `shared/audio/vadSettings.ts` を新設し、`AudioConfig → VadSettings` の変換を 1 箇所に置く。
  `shared` は backend の `schema.ts` を import しない（依存方向を内向きに保つ）ため、
  必要なフィールドだけを持つ**構造的型** `VadConfigSource` を受け取る。
- hello で配る `audio.vad` は**ワイヤ形を変えない**。既存の `tests/frontend-script.test.ts` の
  hello フィクスチャを書き換えずに済み、クライアントとサーバーの同時更新も不要。
- `WsHub` の hello 組み立ては `server/helloPayload.ts` へ抽出し、`buildAvatarPayload()` と対称にする。
- sherpa のモデル種別は `protocol.ts` の型から配列と型ガードを導出する。

### 4.2 停止はキャンセルフラグ／世代番号で行う（P2）

- 非同期処理の途中で `stop()` されたら、**後続の副作用（write/spawn/play）を起こさない**。
- `AudioPlayer` は既に `token`（世代番号）を持つので、`decode()` の完了時にも同じ検査を入れる。
- `AudioService` の再生は `PlaybackProcess` に切り出し、`cancelled` を明示的に持つ。

### 4.3 teardown を先に、生成を後に（P2）

- `applyHello()` は「旧インスタンスを止める → 新しい設定で作る」の順にする。
- `MicLoop.configure()` は作り直さず、`BrowserMic.reconfigure()` で設定だけ差し替える。
- WebSocket 切断時はループとストリームを止める（再接続時に二重に開かない）。

### 4.4 テストは「失敗する期待」から書く（P1/P2）

- バグを再現するテストを先に置き、赤を確認してから直す。
- ブラウザ依存は**小さな注入点**（`createContext` / `spawn` / `createMic`）でフェイクに差し替える。
- DOM のモックは増やさない（既存の `frontend-script.test.ts` はバンドル評価のみに留める）。

---

## 5. フェーズ計画

### P1. 単一真実源（1 日・挙動不変）

| 作業 | 対象 | 内容 |
|---|---|---|
| VAD 設定の導出を集約 | `src/shared/audio/vadSettings.ts`（新規） | `VadConfigSource` / `buildVadSettings()` / `ClientVadSettings` / `buildClientVadSettings()` |
| サーバー録音の置換 | `src/backend/services/AudioService.ts` | L91-103 のリテラルを `buildVadSettings(cfg)` に置換 |
| hello の置換 | `src/backend/server/WsHub.ts` | L117-127 を `buildClientVadSettings(audioConfig)` に置換 |
| ブラウザ録音の置換 | `src/frontend/mic.ts` | L240-261 を `{ ...this.config.vad, sampleRate: this.captureRate, silenceThreshold: this.config.silenceThreshold }` に置換 |
| hello 組み立ての抽出 | `src/backend/server/helloPayload.ts`（新規） | `buildHelloPayload()` を純粋関数化し `WsHub.handleConnection` から呼ぶ |
| sherpa 種別の導出 | `src/shared/protocol.ts` / `src/backend/services/modelCatalog.ts` | `SHERPA_MODEL_TYPES`（`as const satisfies readonly SherpaModelTypeName[]`）と `isSherpaModelType()` を追加し `ApiRouter` は import する |
| `errorText` の集約 | `src/frontend/dom.ts` | `errorText()` を追加し 3 箇所のローカル定義を削除 |

**受け入れ条件**

1. `npm run verify` が緑。既存テストの**アサーション変更なし**（追加のみ）
2. サーバー導出と hello 導出が全フィールド一致するテストがある
3. hello の `audio.vad` のキー集合が従来と同一（ワイヤ互換）
4. `git diff` に「振る舞いの変更」が含まれない（置換と抽出のみ）

**実装イメージ（`src/shared/audio/vadSettings.ts`）**

```ts
import type { VadSettings } from "./vad";

/** `AudioConfig` のうち VAD が必要とする値（backend の型に依存しない構造的型） */
export interface VadConfigSource {
  sample_rate: number;
  frame_ms: number;
  pre_roll_ms: number;
  silence_threshold: number;
  silence_duration: number;
  smoothing_alpha: number;
  relative_threshold_multiplier: number;
  silence_threshold_max: number;
  calibration_duration: number;
  debounce_frames: number;
  input_gain: number;
}

/** 秒指定の設定を ms へ直し、サーバー・ブラウザ共通の VadSettings を作る */
export function buildVadSettings(source: VadConfigSource): VadSettings {
  return {
    sampleRate: source.sample_rate,
    frameMs: source.frame_ms,
    preRollMs: source.pre_roll_ms,
    silenceThreshold: source.silence_threshold,
    silenceDurationMs: source.silence_duration * 1000,
    smoothingAlpha: source.smoothing_alpha,
    relativeThresholdMultiplier: source.relative_threshold_multiplier,
    maxSilenceThreshold: source.silence_threshold_max,
    calibrationMs: source.calibration_duration * 1000,
    debounceFrames: source.debounce_frames,
    inputGain: source.input_gain,
  };
}

/** hello で配る形（sampleRate としきい値は audio 直下に置くため除外） */
export interface ClientVadSettings {
  frameMs: number;
  preRollMs: number;
  silenceDurationMs: number;
  smoothingAlpha: number;
  relativeThresholdMultiplier: number;
  /** ワイヤ上は必須（既存の `audio.vad` の形に合わせる） */
  maxSilenceThreshold: number;
  calibrationMs: number;
  debounceFrames: number;
  inputGain: number;
}

export function buildClientVadSettings(source: VadConfigSource): ClientVadSettings {
  const settings = buildVadSettings(source);
  return {
    frameMs: settings.frameMs,
    preRollMs: settings.preRollMs,
    silenceDurationMs: settings.silenceDurationMs,
    smoothingAlpha: settings.smoothingAlpha,
    relativeThresholdMultiplier: settings.relativeThresholdMultiplier,
    maxSilenceThreshold: settings.maxSilenceThreshold ?? source.silence_threshold_max,
    calibrationMs: settings.calibrationMs,
    debounceFrames: settings.debounceFrames,
    inputGain: settings.inputGain,
  };
}
```

- `ClientVadSettings` は hello の既存形（`maxSilenceThreshold: number` 必須）に合わせる。
  `VadSettings` の任意性はこの関数で吸収する。
- フィールドの列挙が 2 箇所になるが、同一ファイル内に隣接させ、`tests/vad-settings.test.ts` で
  全フィールド一致を固定する（`shared` の外へは漏らさない）。

### P2. 停止・再接続の修正（2 日・バグ修正）

| # | 作業 | 対象 | 内容 |
|---|---|---|---|
| B1 | デコード完了時の世代検査 | `src/frontend/AudioPlayer.ts` | `AudioContext` を `createContext` で注入可能にし、`decode()` の開始時に `token` を捕捉。完了後に変化していたら破棄（ack も送らない） |
| B2 | 再生のキャンセル可能化 | `src/backend/services/PlaybackProcess.ts`（新規）/ `AudioService.ts` | `spawn`・ファイル操作・ffplay 判定を注入。`stop()` 後の書込/spawn を禁止し、停止時に一時ファイルを削除 |
| B3 | 再接続時 teardown | `src/frontend/app.ts` / `MicLoop.ts` / `mic.ts` | `applyHello` で旧 `audioPlayer.dispose()` / `lipSync.stop()`、`onClose` で `micLoop.shutdown()`、`configure()` は `BrowserMic.reconfigure()` で再利用 |
| B4 | バージインの停止貫通 | `MicLoop.ts` / `ConversationPipeline.ts` / `TurnRunner.ts` | `onBargeIn()` でローカル再生を止め、`stop_speaking` は現ターンの `SpeechQueue` も止める。`speaking` 中の `stopSpeaking()` は `barge_in` を通知 |

**B1 の実装ポイント**

- `stop()` は `token += 1` 済み。`decode()` の `await` 後に `if (token !== this.token) return;` を入れる。
- 破棄した音声の `audio_playback_done` は**送らない**（`stop()` が既にサーバー側の待機を解いているため）。
  送らないことで `WsPlaybackSink` の二重解決も起きない。

**B2 の実装ポイント**

```ts
export interface PlaybackProcessDeps {
  config: ConfigManager;
  logger: Logger;
  /** 子プロセスの起動（テストではフェイク） */
  spawn: (binary: string, args: string[], options: { windowsHide: boolean }) => ChildProcess;
  /** ffplay の有無を調べる（テストでは固定値） */
  hasFfplay: () => boolean;
  writeFile: (file: string, data: Buffer) => void;
  removeFile: (file: string) => void;
  tmpFile: () => string;
}
```

- `play(wav)` は `cancelled` を持ち、`stop()` で true。`writeFile` の前後と `spawn` の直前に検査する。
- `stop()` が `spawn` より先なら、**ファイルを書かない／書いた場合は消す**。`spawn` 後なら `kill()`。
- 既存の `resolvePlayer()`（ffplay の probe）と ffplay / SoundPlayer の引数生成はこのクラスへ移す。
- `AudioService` は `AudioIO` の実装として `playbackProcess.play()` に委譲するだけにする。

**B3 の実装ポイント**

- `MicLoop.shutdown(): Promise<void>` を追加（`stop()` → `await mic.stopStream()`）。
  `app.ts` の `onClose` と `window.beforeunload` から呼ぶ。
- `BrowserMic.reconfigure(cfg)` を追加（`config` を `readonly` から外し、差し替えるだけ。AudioContext は維持）。
- `MicLoopDeps.createMic?: (cfg: AudioConfig) => BrowserMic` を追加（既定は `new BrowserMic(cfg)`）。
  テストでフェイクを渡すための唯一の生成経路にし、`configure()` はこれを使って作り直さない。
- `applyHello()` の先頭で `this.lipSync?.stop(); this.lipSync = null; this.audioPlayer?.dispose();` を実行。
  その後、`playbackTarget === "browser"` のときだけ新しい `AudioPlayer` を作る。
- `playbackTarget` が server に変わった場合も旧 `AudioPlayer` を破棄する（現状は else で放置）。

**B4 の実装ポイント**

- `MicLoopDeps.onBargeIn?: () => void` を追加し、`onSpeechStart` で `onBargeIn?.()` → `stop_speaking` 送信の順に呼ぶ。
  `app.ts` は `onBargeIn: () => this.audioPlayer?.stop()` を渡す。
- `TurnRunner` に `private activeQueue: SpeechQueue | null` を持たせ、`runStreaming` の生成/破棄で更新する。
  `stopSpeaking()` は `activeQueue?.stop()`。
- `ConversationPipeline.stopSpeaking()` は `turnRunner.stopSpeaking()` → `playback?.stop()` の順に呼び、
  `state === "speaking"` のときだけ `barge_in` を emit する（UI の停止ボタンは `stop_listening` なので二重通知にならない）。
- `SpeechQueue.stop()` は既に残りを捨てるため、追加のキュー実装は不要。

**受け入れ条件**

1. 追加した回帰テストが緑（下記 6 章）。既存テストのアサーション変更なし
2. 手動: 読み上げ中に「停止」→ 即座に無音（ffplay / ブラウザの両方）
3. 手動: 読み上げ中にページを再読み込み / サーバー再起動 → マイクの使用中表示が 1 つだけ
4. 手動: `conversation.barge_in_enabled = true`（ブラウザ入力）で、読み上げ 2 秒後に発話 →
   旧音声が止まり、次のターンが始まる
5. 停止後 5 秒待っても `logs/app.log` に新しい `ffplay` 起動ログが出ない

### P3. 追加抽出の判断（0〜0.5 日・任意）

P2 で必要なシーム（`PlaybackProcess`・`createMic`・`createContext`）は **P2 の中で作る**。
ここでは追加の分割を行わない。`AudioService` の録音/デバイス分離と `mic.ts` の取得/VAD 分離は
`docs/TODO.md` 2-7 に残し、本設計のスコープ外とする。

| 作業 | 対象 | 内容 |
|---|---|---|
| 分割の棚卸し | `docs/TODO.md` | P2 で残った責務（`AudioService.capture` 周辺、`BrowserMic` の取得系）を TODO 2-7 に追記・更新 |
| シームの命名統一 | `src/backend/services/` / `src/frontend/` | 注入用の deps 名を `spawn` / `createMic` / `createContext` に揃える（挙動不変） |

**受け入れ条件**: `AudioIO` の公開 API（`capture` / `play` / `listInputDevices` / `dispose`）と
`BrowserMic` の `ListenResult` が不変。既存テストが無変更で通る。

### P4. 片付け・文書（0.5 日）

| 作業 | 対象 | 内容 |
|---|---|---|
| 再発防止メモ | `AGENTS.md` | 「停止は token / cancelled で二重実行を防ぐ」「再接続は teardown → 生成」「VAD 設定は `buildVadSettings()` のみ」「hello は `buildHelloPayload()`」を追記 |
| 既知の制約 | `docs/TODO.md` §3 | `/api/models/stt` は絶対パスを許可する（local 前提）ことを明記 |
| バックログ更新 | `docs/TODO.md` | 1-2（VAD 二重管理）を完了として削除。2-7（mic.ts 分割）は残す。2-8 は「実機検証」に更新 |
| 仕様書更新 | `README.md` / `docs/DESIGN.md` | 停止・再接続・バージインの挙動を現状に合わせる |
| テスト件数の同期 | `AGENTS.md` / `README.md` | 「119 件」を実測（255 件）へ更新し、件数を書かない運用にするか、`npm test` の出力を正とする旨を明記 |

---

## 6. テスト計画（新規）

すべて `node:test`。ブラウザ依存は注入点でフェイクにする（DOM のモックは増やさない）。

| ファイル | 検証内容 |
|---|---|
| `tests/vad-settings.test.ts` | 秒→ms 換算（`silence_duration` / `calibration_duration`）／`buildClientVadSettings` が `buildVadSettings` の部分集合（`sampleRate` と `silenceThreshold` を除いて deepEqual）／複数設定（既定・境界値）でサーバー導出と hello 導出が一致／同じフレーム列に対して両方の `VadEngine` が同じ判定を返す |
| `tests/hello-payload.test.ts` | `audio.vad` が `buildClientVadSettings()` と一致／`isPrimary` が該当フィールドだけを変える／キー集合が従来と同一 |
| `tests/model-catalog.test.ts`（追記） | `isSherpaModelType()` が 4 種別のみ true／配列が型と一致（`satisfies` によるコンパイル時検証） |
| `tests/audio-player.test.ts` | フェイク `AudioContext` を注入。`decode` の解決前に `stop()` → `source.start()` が呼ばれない／`onended` 後に二重 ack しない／`stop()` 後の次の `enqueue` は再生される |
| `tests/playback-process.test.ts` | フェイク `spawn`。`stop()` が `spawn` より先 → spawn されず一時ファイルも残らない／spawn 後 → `kill()` が呼ばれる／ffplay の音量が 0..1 にクランプされる／SoundPlayer の引数にファイルパスが入る |
| `tests/mic-loop.test.ts` | フェイク mic を注入。`configure()` を 2 回呼ぶと旧 mic の `stopStream()` が 1 回だけ呼ばれ、新しい設定が反映される／`shutdown()` でループとストリームが止まる／`onSpeechStart` で `onBargeIn` が先に呼ばれ、その後 `stop_speaking` が送られる |
| `tests/turn-runner-streaming.test.ts`（追記） | `stopSpeaking()` 後、残りの文が合成・再生されない（`play` が追加で呼ばれない） |

**既存テストへの影響**

- `tests/frontend-script.test.ts` の hello フィクスチャは**変更しない**（ワイヤ形を維持するため）。
- `tests/pipeline.test.ts` / `turn-runner-*` のアサーションは変更しない（追加のみ）。
- 変更が必要になった場合は、その理由を PR / コミットメッセージに明記する（`AGENTS.md` §4-12 の運用）。

---

## 7. 受け入れ条件（全体）

1. `npm run verify`（typecheck → test → build）が緑。テスト件数は増えるが、**既存の削除・改変はなし**
2. B1〜B4 の再現テストは、**フェイク注入だけを先に入れて赤を確認**してから修正する（赤→緑をコミット履歴に残す）
3. 手動スモーク（`docs/REFACTORING_PLAN.md` §3 と同じ）:
   起動 → テキスト送信 → 応答 → 音声入力 → 停止 → 応答中に再読み込み → 再度応答
4. `git status` に一時ファイル・ログの混入がない
5. コミットは `fix(...)`（P2）と `refactor(...)`（P1/P3）を分ける。メッセージは日本語で「何を・なぜ」

---

## 8. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| B4 の変更が「停止」の意味を変える | バージイン有効時に読み上げが途中で止まる | 既定は `barge_in_enabled = false`。有効時のみの挙動であることを README に明記 |
| B2 の抽出で ffplay の引数が変わる | 音量・再生がおかしくなる | 引数生成を純粋関数化し、既存の値をそのまま移す。手動スモークで音量を確認 |
| B1 の ack 抑止でサーバーが待つ | `speaking` が長引く | `WsPlaybackSink` の `durationMs + 1500ms` フォールバックは維持（既存仕様） |
| `BrowserMic.reconfigure()` で AudioContext のサンプルレートが変わる | 再サンプリングの前提が崩れる | `captureRate` は実コンテキストの値を使い続ける（設定変更は次回 `listen` から） |
| テストのフェイクが実挙動と乖離する | 緑でも壊れる | 再生は「実機スモーク」を必須にし、フェイクは引数とキャンセルの検証に限定 |

---

## 9. 工数

| フェーズ | 見積 | 主な作業 |
|---|---|---|
| P1 | 1 日 | `vadSettings` / `helloPayload` / sherpa 型ガード / `errorText` ＋ テスト 2 本 |
| P2 | 2 日 | B1〜B4 の修正と回帰テスト（新規 3 本＋追記 1 本、フェイク基盤を含む） |
| P3 | 0〜0.5 日 | 追加抽出は行わず、TODO の棚卸しとシーム名の統一のみ |
| P4 | 0.5 日 | AGENTS / TODO / README / DESIGN の更新 |
| 合計 | **3.5〜4.5 日** | P1 → P2 を先に完結させ、P3 は必要になった分だけ |

---

## 10. 決定事項（この設計で固定する）

1. hello の `audio.vad` は**キーを変えない**（クライアント同時更新と既存フィクスチャ変更を避ける）
2. `mic.ts` の全面分割は**今回やらない**（TODO 2-7 に残す）。`reconfigure()` の追加に留める
3. `core/childProcess.ts` は**削除しない**（`WhisperSttService` が使用中）
4. B8（絶対パスの受理）は**コードを変えず**、既知の制約として文書化する
5. バージインの既定値は**変えない**（OFF のまま）。有効時の正しさだけを直す
6. `PlaybackProcess` は `AudioService` の内部実装とし、`core/ports.ts` の `AudioIO` は変更しない

---

## 11. 今回やらないこと（残すもの）

- `docs/TODO.md` 2-7: `mic.ts`（361 行）の取得系 / VAD 系の分割
- `docs/TODO.md` 1-3: バージインの実測と既定 ON 化
- `docs/TODO.md` 2-3: sherpa の `decode()` 中断対応
- `schema.ts` / `ApiRouter` の分割、`[rag]` などの未実装セクション

