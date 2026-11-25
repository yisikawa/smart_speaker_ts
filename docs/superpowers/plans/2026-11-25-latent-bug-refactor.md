# 潜在バグ優先リファクタリング Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 停止・再接続・VAD 設定導出の潜在バグを潰し、同種の不具合が再発しない単一経路へ寄せる。

**Architecture:** まず `shared` に音声設定の導出とエラー文言を集約し、hello の組み立てを純粋関数化する（挙動不変）。次に「停止は世代番号 / キャンセルフラグ」「再接続は teardown → 生成」を導入し、バグ修正として独立コミットする。テストは注入したフェイクで駆動し、DOM モックは増やさない。

**Tech Stack:** TypeScript 5 / Node.js 24 / `node:test` / Express + `ws` / esbuild（フロントは IIFE バンドル）

## Global Constraints

- 作業ブランチは `develop`（`main` は触らない）。設計書は `docs/superpowers/specs/2026-11-25-latent-bug-refactor-design.md`
- 変更後は必ず `npm run verify`（typecheck → test → build）。基準は **255 テスト / 0 fail**
- `tsconfig.json` は `strict` / `noUnusedLocals` / `noUnusedParameters`。`tsconfig.test.json` は未使用検査のみ無効
- `tests/` は `src/frontend` を既定で除外している。Task 6 で `include` に必要なファイルを追加し、同時に `exclude` から `src/frontend` を外す（`exclude` は `include` より優先されるため）
- hello の `audio.vad` は**キーを変えない**（`frameMs` / `preRollMs` / `silenceDurationMs` / `smoothingAlpha` / `relativeThresholdMultiplier` / `maxSilenceThreshold` / `calibrationMs` / `debounceFrames` / `inputGain`）
- 新規依存は追加しない。コメント・UI 文言・ログは日本語
- コミットは `refactor(...)`（挙動不変）と `fix(...)`（バグ修正）を分ける。メッセージは日本語で「何を・なぜ」
- 既存テストのアサーションは変更しない（追加のみ）。変更が必要になったら理由をコミットメッセージに書く

### ファイル構成（作成 / 変更）

| 種別 | パス | 責務 |
|---|---|---|
| 作成 | `src/shared/audio/vadSettings.ts` | `AudioConfig` 構造体 → `VadSettings` / hello 用 `ClientVadSettings` |
| 作成 | `src/backend/server/helloPayload.ts` | hello メッセージの純粋な組み立て |
| 作成 | `src/shared/stt/modelTypes.ts` | sherpa モデル種別の配列と型ガード |
| 作成 | `src/shared/errorText.ts` | Error / 文字列の表示用変換 |
| 作成 | `src/backend/services/PlaybackProcess.ts` | ffplay / SoundPlayer の起動・停止・一時ファイル管理 |
| 作成 | `tests/vad-settings.test.ts` | 導出の等価性と VAD 判定一致 |
| 作成 | `tests/vad-settings-single-source.test.ts` | 3 箇所の手写しが復活していないことの構造ガード |
| 作成 | `tests/hello-payload.test.ts` | hello の形と `vad` の一致 |
| 作成 | `tests/stt-model-types.test.ts` | 種別ガード |
| 作成 | `tests/shared-error-text.test.ts` | 文言変換 |
| 作成 | `tests/audio-player.test.ts` | stop 後のデコード破棄 |
| 作成 | `tests/playback-process.test.ts` | stop 後の spawn 禁止・引数 |
| 作成 | `tests/mic-loop.test.ts` | マイク再利用・shutdown・バージイン通知 |
| 作成 | `tests/turn-runner-stop-speaking.test.ts` | 残り文を鳴らさない |
| 変更 | `src/backend/services/AudioService.ts` / `src/backend/server/WsHub.ts` / `src/backend/server/ApiRouter.ts` / `src/backend/conversation/{ConversationPipeline,TurnRunner}.ts` / `src/frontend/{app,MicLoop,mic,AudioPlayer,dom,SettingsPanel}.ts` / `tsconfig.test.json` | 各タスクの対象 |
| 変更 | `AGENTS.md` / `README.md` / `docs/TODO.md` | 再発防止と現状同期（`docs/DESIGN.md` は旧構成の As-Is 記録のため触らない） |

---

### Task 1: VAD 設定の単一真実源

**Files:**
- Create: `src/shared/audio/vadSettings.ts`
- Test: `tests/vad-settings.test.ts`

**Interfaces:**
- Produces:
  - `export interface VadConfigSource { sample_rate: number; frame_ms: number; pre_roll_ms: number; silence_threshold: number; silence_duration: number; smoothing_alpha: number; relative_threshold_multiplier: number; silence_threshold_max: number; calibration_duration: number; debounce_frames: number; input_gain: number }`
  - `export function buildVadSettings(source: VadConfigSource): VadSettings`
  - `export interface ClientVadSettings { frameMs: number; preRollMs: number; silenceDurationMs: number; smoothingAlpha: number; relativeThresholdMultiplier: number; maxSilenceThreshold: number; calibrationMs: number; debounceFrames: number; inputGain: number }`
  - `export function buildClientVadSettings(source: VadConfigSource): ClientVadSettings`

- [ ] **Step 1: 失敗するテストを書く**

`tests/vad-settings.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { VadEngine } from "../src/shared/audio/vad";
import {
  buildClientVadSettings,
  buildVadSettings,
  type VadConfigSource,
} from "../src/shared/audio/vadSettings";

/** 既定値に近い入力（秒指定の項目を含む） */
const SOURCE: VadConfigSource = {
  sample_rate: 16000,
  frame_ms: 20,
  pre_roll_ms: 200,
  silence_threshold: 0.02,
  silence_duration: 0.8,
  smoothing_alpha: 0.3,
  relative_threshold_multiplier: 3,
  silence_threshold_max: 0.06,
  calibration_duration: 0.5,
  debounce_frames: 2,
  input_gain: 1.5,
};

test("buildVadSettings は秒指定を ms に直す", () => {
  const settings = buildVadSettings(SOURCE);
  assert.equal(settings.silenceDurationMs, 800);
  assert.equal(settings.calibrationMs, 500);
  assert.equal(settings.sampleRate, 16000);
  assert.equal(settings.maxSilenceThreshold, 0.06);
});

test("hello 用の設定はサーバー用から sampleRate としきい値を除いた同値", () => {
  const server = buildVadSettings(SOURCE);
  const client = buildClientVadSettings(SOURCE);
  assert.deepEqual(client, {
    frameMs: server.frameMs,
    preRollMs: server.preRollMs,
    silenceDurationMs: server.silenceDurationMs,
    smoothingAlpha: server.smoothingAlpha,
    relativeThresholdMultiplier: server.relativeThresholdMultiplier,
    maxSilenceThreshold: SOURCE.silence_threshold_max,
    calibrationMs: server.calibrationMs,
    debounceFrames: server.debounceFrames,
    inputGain: server.inputGain,
  });
});

test("同じフレーム列ならサーバーとブラウザで同じ判定になる", () => {
  const frameSamples = Math.round((SOURCE.sample_rate * SOURCE.frame_ms) / 1000);
  const frames: Int16Array[] = [];
  for (let i = 0; i < 60; i += 1) {
    const amplitude = i >= 10 && i < 40 ? 1200 : 30;
    frames.push(new Int16Array(frameSamples).fill(amplitude));
  }

  const options = { maxDurationMs: 5000, startTimeoutMs: 1000 };
  const server = new VadEngine(buildVadSettings(SOURCE), options);
  const browser = new VadEngine(
    {
      ...buildClientVadSettings(SOURCE),
      sampleRate: SOURCE.sample_rate,
      silenceThreshold: SOURCE.silence_threshold,
    },
    options
  );

  const serverKinds = frames.map((frame) => server.push(frame).kind);
  const browserKinds = frames.map((frame) => browser.push(frame).kind);
  assert.deepEqual(browserKinds, serverKinds);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test 2>&1 | Select-String -Pattern "vad-settings|Cannot find module" -Context 0,2`
Expected: `Cannot find module '../src/shared/audio/vadSettings'` で失敗（テストが赤）

- [ ] **Step 3: 最小実装を書く**

`src/shared/audio/vadSettings.ts`:

```ts
import type { VadSettings } from "./vad";

/**
 * `AudioConfig` のうち VAD が必要とする値（backend の型に依存しない構造的型）。
 * `src/backend/config/schema.ts` の `AudioConfig` がそのまま代入できる。
 */
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

/** hello で配る形（sampleRate としきい値は `audio` 直下に置くため除外） */
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

- [ ] **Step 4: 通ることを確認する**

Run: `npm run verify 2>&1 | Select-Object -Last 20`
Expected: `# pass 258`（255 + 3）以上、`fail 0`、`[build]` が成功

- [ ] **Step 5: コミット**

```bash
git add src/shared/audio/vadSettings.ts tests/vad-settings.test.ts
git commit -m "refactor(audio): VAD 設定の導出を shared に集約する" -m "ブラウザ・サーバー・hello で同じ変換を手写ししていたため、設定追加時に片方だけ直すと挙動がずれる。純粋関数とテストで単一の真実源にする（挙動は変えない）。"
```

---

### Task 2: hello ペイロードの純粋関数化

**Files:**
- Create: `src/backend/server/helloPayload.ts`
- Modify: `src/backend/server/WsHub.ts:77-130`
- Test: `tests/hello-payload.test.ts`

**Interfaces:**
- Consumes: `buildClientVadSettings(source: VadConfigSource): ClientVadSettings`（Task 1）
- Produces: `buildHelloPayload(input: HelloPayloadInput): HelloPayload`
  - `HelloPayloadInput` は `{ state; history; character; language; user; version; services; models; avatar; isPrimary; audio: AppConfig["audio"]; conversation: AppConfig["conversation"] }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/hello-payload.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildAvatarPayload } from "../src/backend/server/avatarPayload";
import { buildHelloPayload } from "../src/backend/server/helloPayload";
import { buildClientVadSettings } from "../src/shared/audio/vadSettings";
import { createTempProject } from "./helpers/project";

test("hello の audio.vad は buildClientVadSettings と一致する", () => {
  const project = createTempProject();
  try {
    const audio = project.config.getAudio();
    const payload = buildHelloPayload({
      state: "idle",
      history: [],
      character: { name: "さくら", label: "テスト" },
      language: "ja",
      user: "あなた",
      version: "0.0.0",
      services: { llm: true, tts: true, stt: true },
      models: { stt: { engine: "whisper", label: "whisper" }, llm: { model: "test" } },
      avatar: buildAvatarPayload(project.config.getAvatar(), []),
      isPrimary: true,
      audio,
      conversation: project.config.getConversation(),
    });
    assert.deepEqual(payload.audio.vad, buildClientVadSettings(audio));
  } finally {
    project.cleanup();
  }
});

test("hello の audio は従来と同じキーを持つ", () => {
  const project = createTempProject();
  try {
    const payload = buildHelloPayload({
      state: "idle",
      history: [],
      character: { name: "さくら", label: "テスト" },
      language: "ja",
      user: "あなた",
      version: "0.0.0",
      services: { llm: true, tts: true, stt: true },
      models: { stt: { engine: "whisper", label: "whisper" }, llm: { model: "test" } },
      avatar: buildAvatarPayload(project.config.getAvatar(), []),
      isPrimary: false,
      audio: project.config.getAudio(),
      conversation: project.config.getConversation(),
    });
    assert.deepEqual(Object.keys(payload.audio).sort(), [
      "bargeIn",
      "followup",
      "inputMode",
      "isPrimary",
      "maxRecordMs",
      "noSpeechTimeoutMs",
      "outputVolume",
      "playbackTarget",
      "sampleRate",
      "silenceThreshold",
      "vad",
    ]);
    assert.equal(payload.audio.isPrimary, false);
  } finally {
    project.cleanup();
  }
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test 2>&1 | Select-String -Pattern "hello-payload|Cannot find module" -Context 0,2`
Expected: `Cannot find module '../src/backend/server/helloPayload'` で失敗

- [ ] **Step 3: 最小実装を書く**

`src/backend/server/helloPayload.ts`:

```ts
import { buildClientVadSettings } from "../../shared/audio/vadSettings";
import type {
  AssistantState,
  AvatarConfigPayload,
  ChatMessage,
  HelloPayload,
  LanguageMode,
  ModelSelection,
  ServiceStatus,
} from "../../shared/protocol";
import type { AppConfig } from "../config/schema";

export interface HelloPayloadInput {
  state: AssistantState;
  history: ChatMessage[];
  character: { name: string; label: string };
  language: LanguageMode;
  user: string;
  version: string;
  services: ServiceStatus;
  models: ModelSelection;
  /** `buildAvatarPayload()` の結果（WsHub が組み立てて渡す） */
  avatar: AvatarConfigPayload;
  /** この接続が音声を鳴らす担当か */
  isPrimary: boolean;
  audio: AppConfig["audio"];
  conversation: AppConfig["conversation"];
}

/**
 * 接続直後の初期化メッセージを組み立てる。
 * 設定 → ワイヤ形式の変換（ms 換算・VAD 導出）をこの 1 箇所に閉じ込める。
 */
export function buildHelloPayload(input: HelloPayloadInput): HelloPayload {
  const audio = input.audio;
  const conv = input.conversation;
  return {
    type: "hello",
    state: input.state,
    history: input.history,
    character: input.character,
    language: input.language,
    user: input.user,
    version: input.version,
    services: input.services,
    models: input.models,
    avatar: input.avatar,
    audio: {
      inputMode: audio.input_mode,
      playbackTarget: audio.playback_target,
      isPrimary: input.isPrimary,
      outputVolume: audio.output_volume,
      sampleRate: audio.sample_rate,
      noSpeechTimeoutMs: audio.no_speech_timeout * 1000,
      followup: {
        enabled: conv.followup_enabled,
        maxTurns: conv.max_followup_turns,
        timeoutMs: conv.followup_timeout_seconds * 1000,
        guardMs: conv.followup_guard_ms,
        keepListening: conv.keep_listening,
      },
      bargeIn: {
        enabled: conv.barge_in_enabled,
        minScore: conv.barge_in_min_score,
      },
      silenceThreshold: audio.silence_threshold,
      maxRecordMs: audio.max_record_seconds * 1000,
      vad: buildClientVadSettings(audio),
    },
  };
}
```

`src/backend/server/WsHub.ts` の `ws.send(JSON.stringify({ ... }))`（L82-130）を次に置き換える。`buildAvatarPayload` の import は残す。

```ts
    ws.send(
      JSON.stringify(
        buildHelloPayload({
          state: this.deps.pipeline.getState(),
          history: this.deps.pipeline.getHistory(),
          character: { name: character.name, label: character.label },
          language,
          user: this.deps.config.getGUI().user_name,
          version: this.deps.version,
          services: this.deps.serviceStatus(),
          models: this.deps.models(),
          avatar: buildAvatarPayload(this.deps.config.getAvatar(), this.avatarModels()),
          isPrimary: this.clientIds.get(ws) === this.primaryId,
          audio: audioConfig,
          conversation: conversationConfig,
        })
      )
    );
```

先頭の import に追加:

```ts
import { buildHelloPayload } from "./helloPayload";
```

- [ ] **Step 4: 通ることを確認する**

Run: `npm run verify 2>&1 | Select-Object -Last 20`
Expected: `# pass 260` 以上、`fail 0`、ビルド成功

- [ ] **Step 5: コミット**

```bash
git add src/backend/server/helloPayload.ts src/backend/server/WsHub.ts tests/hello-payload.test.ts
git commit -m "refactor(server): hello の組み立てを純粋関数へ切り出す" -m "WsHub の接続処理に設定→ワイヤ形式の変換が直書きされ、テストできなかった。VAD 導出を shared の関数に統一し、hello の形をテストで固定する（ワイヤ形は不変）。"
```

---

### Task 3: サーバー / ブラウザ録音を `buildVadSettings` へ接続

**Files:**
- Modify: `src/backend/services/AudioService.ts:90-104`
- Modify: `src/frontend/mic.ts:240-261`
- Test: `tests/vad-settings-single-source.test.ts`

**Interfaces:**
- Consumes: `buildVadSettings(source: VadConfigSource): VadSettings`（Task 1）
- Produces: なし（内部の置換のみ）

- [ ] **Step 1: 失敗するテストを書く**

`tests/vad-settings-single-source.test.ts`（手写しの再発を防ぐ構造ガード）:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("AudioService は buildVadSettings を使う", () => {
  const source = read("src/backend/services/AudioService.ts");
  assert.match(source, /buildVadSettings/);
  assert.doesNotMatch(source, /silenceDurationMs:\s*cfg\.silence_duration\s*\*\s*1000/);
});

test("helloPayload は buildClientVadSettings を使う", () => {
  const source = read("src/backend/server/helloPayload.ts");
  assert.match(source, /buildClientVadSettings/);
  assert.doesNotMatch(source, /calibrationMs:\s*audio\.calibration_duration/);
});

test("BrowserMic は hello の vad 設定をそのまま使う", () => {
  const source = read("src/frontend/mic.ts");
  assert.match(source, /\.\.\.this\.config\.vad/);
  assert.doesNotMatch(source, /calibrationMs:\s*vad\.calibrationMs/);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test 2>&1 | Select-String -Pattern "vad-settings-single-source|buildVadSettings|AssertionError" -Context 0,2`
Expected: AudioService の `buildVadSettings` 不在で失敗（2 つ目・3 つ目は Task 1/2 で既に緑）

- [ ] **Step 3: 実装を置換する**

`src/backend/services/AudioService.ts` の L90-104 付近を次へ置き換える。

```ts
    const cfg = this.deps.config.getAudio();
    const engine = new VadEngine(buildVadSettings(cfg), {
      maxDurationMs: options.maxDurationMs,
      startTimeoutMs: options.startTimeoutMs,
      silenceDurationMs: options.silenceDurationMs,
      threshold: options.threshold,
    });
```

import を追加し、不要になった `VadSettings` を外す。

```ts
import { buildVadSettings } from "../../shared/audio/vadSettings";
import { VadEngine } from "../../shared/audio/vad";
```

`src/frontend/mic.ts` の L240-261 を次へ置き換える（`const vad = this.config.vad;` は削除）。

```ts
    const engine = new VadEngine(
      {
        ...this.config.vad,
        sampleRate: this.captureRate,
        silenceThreshold: this.config.silenceThreshold,
      },
      {
        maxDurationMs: options.maxDurationMs,
        startTimeoutMs: options.startTimeoutMs,
        threshold: options.threshold,
      }
    );
```

`finishSession()` の `this.config.vad.inputGain` はそのまま使える（形は不変）。

- [ ] **Step 4: 通ることを確認する**

Run: `npm run verify 2>&1 | Select-Object -Last 20`
Expected: `# pass 263` 以上、`fail 0`、ビルド成功

- [ ] **Step 5: コミット**

```bash
git add src/backend/services/AudioService.ts src/frontend/mic.ts tests/vad-settings-single-source.test.ts
git commit -m "refactor(audio): 録音の VAD 設定生成を buildVadSettings に一本化する" -m "サーバーとブラウザで同じ変換を手写ししており、設定追加時に無言でずれる恐れがあった。手写しの再発を構造テストで検出する（挙動は変えない）。"
```

---

### Task 4: sherpa モデル種別の型ガード

**Files:**
- Create: `src/shared/stt/modelTypes.ts`
- Modify: `src/backend/server/ApiRouter.ts:26-32`, `:306-313`
- Test: `tests/stt-model-types.test.ts`

**Interfaces:**
- Produces:
  - `export const SHERPA_MODEL_TYPES = [...] as const satisfies readonly SherpaModelTypeName[]`
  - `export function isSherpaModelType(value: unknown): value is SherpaModelTypeName`

- [ ] **Step 1: 失敗するテストを書く**

`tests/stt-model-types.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  SHERPA_MODEL_TYPES,
  isSherpaModelType,
} from "../src/shared/stt/modelTypes";

test("sherpa の 4 種別だけを受け付ける", () => {
  for (const type of SHERPA_MODEL_TYPES) {
    assert.equal(isSherpaModelType(type), true);
  }
  assert.equal(isSherpaModelType("whisper"), false);
  assert.equal(isSherpaModelType(""), false);
  assert.equal(isSherpaModelType(undefined), false);
  assert.equal(isSherpaModelType(1), false);
});

test("一覧は schema の型と同じ並び", () => {
  assert.deepEqual([...SHERPA_MODEL_TYPES], [
    "nemo_transducer",
    "nemo_ctc",
    "sense_voice",
    "zipformer_transducer",
  ]);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test 2>&1 | Select-String -Pattern "stt-model-types|Cannot find module" -Context 0,2`
Expected: `Cannot find module '../src/shared/stt/modelTypes'` で失敗

- [ ] **Step 3: 最小実装を書く**

`src/shared/stt/modelTypes.ts`:

```ts
import type { SherpaModelTypeName } from "../protocol";

/**
 * sherpa-onnx のモデル種別（ApiRouter の検証と schema の型を一致させる唯一の一覧）。
 * 型に追加したらここへ足す（`satisfies` で過不足をコンパイル時に検出する）。
 */
export const SHERPA_MODEL_TYPES = [
  "nemo_transducer",
  "nemo_ctc",
  "sense_voice",
  "zipformer_transducer",
] as const satisfies readonly SherpaModelTypeName[];

/** 未知の文字列を sherpa のモデル種別へ絞り込む */
export function isSherpaModelType(value: unknown): value is SherpaModelTypeName {
  return typeof value === "string" && (SHERPA_MODEL_TYPES as readonly string[]).includes(value);
}
```

`src/backend/server/ApiRouter.ts`:
- L26-32 のローカル `SHERPA_MODEL_TYPES` 定義を削除
- protocol の import から `SherpaModelTypeName` を削除
- 追加: `import { isSherpaModelType } from "../../shared/stt/modelTypes";`
- L306-313 を次へ置き換える

```ts
        const modelType = req.body?.sherpa_model_type;
        if (typeof modelType === "string" && modelType) {
          if (!isSherpaModelType(modelType)) {
            res.status(400).json({ error: `未対応の sherpa_model_type です: ${modelType}` });
            return;
          }
          sttPatch.sherpa_model_type = modelType;
        }
```

- [ ] **Step 4: 通ることを確認する**

Run: `npm run verify 2>&1 | Select-Object -Last 20`
Expected: `# pass 265` 以上、`fail 0`

- [ ] **Step 5: コミット**

```bash
git add src/shared/stt/modelTypes.ts src/backend/server/ApiRouter.ts tests/stt-model-types.test.ts
git commit -m "refactor(stt): sherpa のモデル種別を型から導出する" -m "型と検証用の配列を別々に手で管理していたため、種別追加時に 400 で弾かれる恐れがあった。配列と型ガードを shared に置き、satisfies で型との一致を保証する。"
```

---

### Task 5: エラー文言ヘルパの集約

**Files:**
- Create: `src/shared/errorText.ts`
- Modify: `src/frontend/app.ts:412-414`, `src/frontend/MicLoop.ts:303-307`, `src/frontend/SettingsPanel.ts:67-69`
- Test: `tests/shared-error-text.test.ts`

**Interfaces:**
- Produces: `export function errorText(error: unknown): string`

- [ ] **Step 1: 失敗するテストを書く**

`tests/shared-error-text.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { errorText } from "../src/shared/errorText";

test("Error は message を返す", () => {
  assert.equal(errorText(new Error("マイクを開けませんでした")), "マイクを開けませんでした");
});

test("Error 以外は String 化する", () => {
  assert.equal(errorText("そのまま"), "そのまま");
  assert.equal(errorText(undefined), "undefined");
  assert.equal(errorText(42), "42");
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test 2>&1 | Select-String -Pattern "shared-error-text|Cannot find module" -Context 0,2`
Expected: `Cannot find module '../src/shared/errorText'` で失敗

- [ ] **Step 3: 最小実装と置換**

`src/shared/errorText.ts`:

```ts
/** 画面表示用のエラー文言（Error 以外も文字列化する） */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

`src/frontend/app.ts`:
- 末尾の `function errorText(...)`（L412-414）を削除
- import を追加: `import { errorText } from "../shared/errorText";`

`src/frontend/MicLoop.ts`:
- 末尾の `function errorText(...)`（L303-307）を削除
- import を `import { BrowserMic } from "./mic";` に変更（`BrowserMicError` は不要になる）
- 追加: `import { errorText } from "../shared/errorText";`

`src/frontend/SettingsPanel.ts`:
- 末尾の `function errorText(...)`（L67-69）を削除
- 追加: `import { errorText } from "../shared/errorText";`

- [ ] **Step 4: 通ることを確認する**

Run: `npm run verify 2>&1 | Select-Object -Last 20`
Expected: `# pass 267` 以上、`fail 0`、`[build]` が成功（esbuild のバンドルが通る）

- [ ] **Step 5: コミット**

```bash
git add src/shared/errorText.ts src/frontend/app.ts src/frontend/MicLoop.ts src/frontend/SettingsPanel.ts tests/shared-error-text.test.ts
git commit -m "refactor(frontend): エラー文言の変換を shared に集約する" -m "同じ errorText を 3 ファイルに重複定義しており、文言や抽出規則がずれる余地があった。shared の 1 実装へ寄せる（表示は不変）。"
```

---

### Task 6: AudioPlayer の停止後デコードを破棄する（B1）

**Files:**
- Modify: `src/frontend/AudioPlayer.ts:6-9`, `:94-114`
- Modify: `tsconfig.test.json:10`
- Test: `tests/audio-player.test.ts`

**Interfaces:**
- Produces: `AudioPlayerDeps.createContext?: () => AudioContext`

- [ ] **Step 1: テスト用に frontend を 1 ファイルだけ compile 対象へ入れる**

`tsconfig.test.json` の `include` と `exclude` を次へ変更する（`exclude` から `src/frontend` を外さないと、`include` に書いても除外される）。

```json
  "include": ["src/backend/**/*", "src/shared/**/*", "src/frontend/AudioPlayer.ts", "tests/**/*"],
  "exclude": ["node_modules", "dist", "dist-test"],
```

`npm test` が既存のまま緑であることを確認する（Run: `npm test`、Expected: `fail 0`）。

- [ ] **Step 2: 失敗するテストを書く**

`tests/audio-player.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { AudioPlayer } from "../src/frontend/AudioPlayer";
import type { PipelineEvent } from "../src/shared/protocol";

interface FakeSource {
  buffer: unknown;
  onended: (() => void) | null;
  connect(): void;
  start(): void;
  stop(): void;
}

type AudioEvent = Extract<PipelineEvent, { type: "tts_audio" }>;

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const started: string[] = [];
  const stopped: number[] = [];
  const acks: string[] = [];
  const sources: FakeSource[] = [];
  const decodes: ((buffer: unknown) => void)[] = [];

  const context = {
    currentTime: 0,
    state: "running",
    destination: {},
    createGain: () => ({ gain: { value: 1 }, connect: () => undefined }),
    createBufferSource: () => {
      const source: FakeSource = {
        buffer: null,
        onended: null,
        connect: () => undefined,
        start: () => started.push("start"),
        stop: () => stopped.push(1),
      };
      sources.push(source);
      return source;
    },
    decodeAudioData: () => new Promise<unknown>((resolve) => decodes.push(resolve)),
    close: async () => undefined,
  };

  const player = new AudioPlayer({
    send: (command) => {
      if (command.type === "audio_playback_done") {
        acks.push(command.utteranceId);
      }
    },
    createContext: () => context as unknown as AudioContext,
  });
  return { player, started, stopped, acks, sources, decodes };
}

function ttsAudio(utteranceId: string): AudioEvent {
  return {
    type: "tts_audio",
    utteranceId,
    text: "テスト",
    audio: "",
    volumes: [],
    sliceMs: 20,
    durationMs: 10,
  };
}

test("デコード解決前に stop したら再生しない（ack も送らない）", async () => {
  const fakes = setup();
  fakes.player.enqueue(ttsAudio("u1"));
  fakes.player.stop();
  fakes.decodes[0]({});
  await flush();
  assert.deepEqual(fakes.started, []);
  assert.deepEqual(fakes.acks, []);
});

test("再生中の stop は source を止め、遅れて来た onended で二重 ack しない", async () => {
  const fakes = setup();
  fakes.player.enqueue(ttsAudio("u1"));
  fakes.decodes[0]({});
  await flush();
  assert.deepEqual(fakes.started, ["start"]);

  fakes.player.stop();
  fakes.sources[0].onended?.();
  await flush();
  assert.equal(fakes.stopped.length, 1);
  assert.deepEqual(fakes.acks, []);
});

test("stop 後の次の enqueue は再生される", async () => {
  const fakes = setup();
  fakes.player.enqueue(ttsAudio("u1"));
  fakes.decodes[0]({});
  await flush();
  fakes.player.stop();

  fakes.player.enqueue(ttsAudio("u2"));
  fakes.decodes[1]({});
  await flush();
  assert.equal(fakes.started.length, 2);
});
```

- [ ] **Step 3: 失敗を確認する**

Run: `npm test 2>&1 | Select-String -Pattern "デコード解決前|AudioPlayer" -Context 0,2`
Expected: 1 つ目のテストが `start` されて失敗（`AssertionError`）

- [ ] **Step 4: 実装を直す**

`src/frontend/AudioPlayer.ts` の `AudioPlayerDeps` に追加:

```ts
  /** AudioContext の生成（テスト用。既定は `new AudioContext()`） */
  createContext?: () => AudioContext;
```

`context()` を次へ変更:

```ts
  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = this.deps.createContext?.() ?? new AudioContext();
```

`decode()` を次へ変更（世代番号を捕捉し、stop 後は捨てる）:

```ts
  private async decode(event: AudioEvent): Promise<void> {
    const token = this.token;
    try {
      const copy = new Uint8Array(bytesFromBase64(event.audio));
      const buffer = await this.context().decodeAudioData(copy.buffer as ArrayBuffer);
      if (token !== this.token) {
        // stop() 済み。デコード結果は捨てる（ack も送らない）
        return;
      }
      this.ready.push({ event, buffer });
      this.pump();
    } catch (error) {
      console.warn("[Audio] 音声をデコードできませんでした", error);
      if (token === this.token) {
        this.deps.send({ type: "audio_playback_done", utteranceId: event.utteranceId });
      }
    }
  }
```

- [ ] **Step 5: 通ることを確認する**

Run: `npm run verify 2>&1 | Select-Object -Last 20`
Expected: `# pass 270` 以上、`fail 0`、ビルド成功

- [ ] **Step 6: コミット**

```bash
git add tsconfig.test.json tests/audio-player.test.ts src/frontend/AudioPlayer.ts
git commit -m "fix(playback): stop 後にデコードが終わった音声を再生しない" -m "decodeAudioData の完了が stop より後になると、停止したはずの文が鳴っていた。世代番号をデコード完了時にも検査し、テストで固定する。"
```

---

### Task 7: サーバー再生をキャンセル可能にする（B2）

**Files:**
- Create: `src/backend/services/PlaybackProcess.ts`
- Modify: `src/backend/services/AudioService.ts:29-38`, `:321-421`
- Test: `tests/playback-process.test.ts`

**Interfaces:**
- Produces:
  - `export function buildPlaybackArgs(kind: "ffplay" | "soundplayer", file: string, volume: number): string[]`
  - `export class PlaybackProcess { constructor(deps: PlaybackProcessDeps); play(wav: Buffer): PlaybackHandle }`
  - `PlaybackProcessDeps` は `{ config; logger; spawn; hasFfplay: () => Promise<boolean>; writeFile; removeFile; tmpFile }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/playback-process.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { ConfigManager } from "../src/backend/config/ConfigManager";
import type { AudioConfig } from "../src/backend/config/schema";
import type { Logger } from "../src/backend/core/logger";
import {
  PlaybackProcess,
  buildPlaybackArgs,
} from "../src/backend/services/PlaybackProcess";
import { encodeWav } from "../src/backend/services/wav";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const audio = {
  sample_rate: 16000,
  output_volume: 1,
  player: "ffplay",
} as AudioConfig;

const config = { getAudio: () => audio } as unknown as ConfigManager;
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const wav = encodeWav(Buffer.alloc(320), 16000);

interface FakeChild extends EventEmitter {
  killCount: number;
}

function setup() {
  const spawns: { binary: string; args: string[] }[] = [];
  const writes: string[] = [];
  const removes: string[] = [];
  const children: FakeChild[] = [];

  const playback = new PlaybackProcess({
    config,
    logger,
    spawn: (binary, args) => {
      spawns.push({ binary, args });
      const child = Object.assign(new EventEmitter(), {
        killCount: 0,
        kill() {
          this.killCount += 1;
        },
      }) as FakeChild;
      children.push(child);
      return child as unknown as ChildProcess;
    },
    hasFfplay: async () => true,
    writeFile: (file) => writes.push(file),
    removeFile: (file) => removes.push(file),
    tmpFile: () => "C:/tmp/playback.wav",
  });
  return { playback, spawns, writes, removes, children };
}

test("stop が spawn より先なら起動せず、書いたファイルを消す", async () => {
  const fakes = setup();
  const handle = fakes.playback.play(wav);
  handle.stop();
  await handle.finished;

  assert.equal(fakes.spawns.length, 0);
  assert.deepEqual(fakes.writes, ["C:/tmp/playback.wav"]);
  assert.deepEqual(fakes.removes, ["C:/tmp/playback.wav"]);
});

test("spawn 後の stop は子プロセスを kill する", async () => {
  const fakes = setup();
  const handle = fakes.playback.play(wav);
  await flush();
  assert.equal(fakes.spawns.length, 1);

  handle.stop();
  assert.equal(fakes.children[0].killCount, 1);
  await handle.finished;
  assert.deepEqual(fakes.removes, ["C:/tmp/playback.wav"]);
});

test("ffplay の音量は 0..100 に丸める", () => {
  assert.deepEqual(buildPlaybackArgs("ffplay", "a.wav", 1.5).slice(4, 6), ["-volume", "100"]);
  assert.deepEqual(buildPlaybackArgs("ffplay", "a.wav", -1).slice(4, 6), ["-volume", "0"]);
});

test("SoundPlayer はシングルクォートをエスケープしてパスを埋め込む", () => {
  const args = buildPlaybackArgs("soundplayer", "C:/tmp/a'b.wav", 1);
  assert.equal(args[0], "-NoProfile");
  assert.match(args[2], /a''b\.wav/);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test 2>&1 | Select-String -Pattern "playback-process|Cannot find module" -Context 0,2`
Expected: `Cannot find module '../src/backend/services/PlaybackProcess'` で失敗

- [ ] **Step 3: 最小実装を書く**

`src/backend/services/PlaybackProcess.ts`:

```ts
import type { ChildProcess } from "child_process";
import { ConfigManager } from "../config/ConfigManager";
import { Logger } from "../core/logger";
import type { PlaybackHandle } from "../core/ports";
import { ensureWav } from "./wav";

export interface PlaybackProcessDeps {
  config: ConfigManager;
  logger: Logger;
  /** 子プロセスの起動（テストではフェイク） */
  spawn: (binary: string, args: string[], options: { windowsHide: boolean }) => ChildProcess;
  /** ffplay が使えるか（テストでは固定値） */
  hasFfplay: () => Promise<boolean>;
  writeFile: (file: string, data: Buffer) => void;
  removeFile: (file: string) => void;
  tmpFile: () => string;
}

/** 再生バックエンドごとの引数（音量は 0..1 を 0..100 へ丸める） */
export function buildPlaybackArgs(
  kind: "ffplay" | "soundplayer",
  file: string,
  volume: number
): string[] {
  if (kind === "ffplay") {
    return [
      "-nodisp",
      "-autoexit",
      "-loglevel",
      "quiet",
      "-volume",
      String(Math.round(Math.min(1, Math.max(0, volume)) * 100)),
      "-i",
      file,
    ];
  }
  return [
    "-NoProfile",
    "-Command",
    `$p = New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}'; $p.PlaySync()`,
  ];
}

/**
 * WAV を一時ファイルへ書き、ffplay / SoundPlayer で再生する。
 *
 * `stop()` が書込や spawn より先に来たら、**後続の副作用を起こさない**。
 * 失敗しても `finished` は必ず解決する（パイプラインを止めない）。
 */
export class PlaybackProcess {
  private playerKind: "ffplay" | "soundplayer" | null = null;

  constructor(private readonly deps: PlaybackProcessDeps) {}

  play(wav: Buffer): PlaybackHandle {
    const cfg = this.deps.config.getAudio();
    const file = this.deps.tmpFile();
    let cancelled = false;
    let written = false;
    let proc: ChildProcess | null = null;
    let settled = false;
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    const removeTmp = (): void => {
      if (!written) {
        return;
      }
      written = false;
      try {
        this.deps.removeFile(file);
      } catch {
        // 一時ファイル削除の失敗は無視
      }
    };

    const complete = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeTmp();
      resolveFinished();
    };

    const kill = (child: ChildProcess): void => {
      try {
        child.kill();
      } catch {
        // 既に終了している場合は無視
      }
    };

    void (async () => {
      try {
        if (cancelled) {
          complete();
          return;
        }
        this.deps.writeFile(file, ensureWav(wav, cfg.sample_rate));
        written = true;
        if (cancelled) {
          complete();
          return;
        }

        const kind = await this.resolvePlayer();
        if (cancelled) {
          complete();
          return;
        }

        const child = this.deps.spawn(
          kind === "ffplay" ? "ffplay" : "powershell.exe",
          buildPlaybackArgs(kind, file, cfg.output_volume),
          { windowsHide: true }
        );
        proc = child;
        if (cancelled) {
          kill(child);
          complete();
          return;
        }

        child.on("error", (error) => {
          this.deps.logger.error("再生プロセスの起動に失敗しました", error);
          complete();
        });
        child.on("close", () => complete());
      } catch (error) {
        this.deps.logger.error("再生に失敗しました", error);
        complete();
      }
    })();

    return {
      finished,
      stop: () => {
        cancelled = true;
        if (proc) {
          kill(proc);
        }
        complete();
      },
    };
  }

  /** 再生バックエンドを決める（設定 → ffplay の有無 → SoundPlayer） */
  private async resolvePlayer(): Promise<"ffplay" | "soundplayer"> {
    const configured = this.deps.config.getAudio().player;
    if (configured === "ffplay" || configured === "soundplayer") {
      return configured;
    }
    if (this.playerKind) {
      return this.playerKind;
    }
    this.playerKind = (await this.deps.hasFfplay()) ? "ffplay" : "soundplayer";
    this.deps.logger.info(`再生バックエンド: ${this.playerKind}`);
    return this.playerKind;
  }
}
```

`src/backend/services/AudioService.ts` の変更:
- import を `import { encodeWav } from "./wav";` に変更（`ensureWav` を外す）
- import 追加: `import { PlaybackProcess } from "./PlaybackProcess";`
- フィールド `playerKind` を削除し、`private readonly playbackProcess: PlaybackProcess;` を追加
- コンストラクタで生成する

```ts
    this.playbackProcess = new PlaybackProcess({
      config: deps.config,
      logger: this.logger,
      spawn,
      hasFfplay: async () =>
        spawnSync("ffplay", ["-version"], { windowsHide: true, encoding: "utf8", timeout: 5000 })
          .status === 0,
      writeFile: (file, data) => fs.writeFileSync(file, data),
      removeFile: (file) => {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      },
      tmpFile: () =>
        path.join(
          os.tmpdir(),
          `sumika_play_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`
        ),
    });
```

- `resolvePlayer()` と `play()` の実装（L321-421）を削除し、次だけ残す

```ts
  play(wav: Buffer): PlaybackHandle {
    return this.playbackProcess.play(wav);
  }
```

`fs` / `os` / `path` の import は上記の既定実装で使うため残す。

- [ ] **Step 4: 通ることを確認する**

Run: `npm run verify 2>&1 | Select-Object -Last 20`
Expected: `# pass 274` 以上、`fail 0`、ビルド成功

- [ ] **Step 5: コミット**

```bash
git add src/backend/services/PlaybackProcess.ts src/backend/services/AudioService.ts tests/playback-process.test.ts
git commit -m "fix(playback): stop 後の ffplay 起動と一時ファイル残留を防ぐ" -m "再生処理が stop 済みでも writeFile → spawn を続行し、停止したのに鳴ることがあった。キャンセルを明示的に持ち、spawn 前に検査する。引数生成は純粋関数にしてテストする。"
```

---

### Task 8: 再接続時の teardown とマイク再利用（B3）

**Files:**
- Modify: `src/frontend/MicLoop.ts:1-43`, `:138-143`
- Modify: `src/frontend/mic.ts:58-70`, `:231-278`
- Modify: `src/frontend/app.ts:59-105`, `:265-299`
- Modify: `tsconfig.test.json:10`
- Test: `tests/mic-loop.test.ts`

**Interfaces:**
- Produces:
  - `export interface MicLoopView`（`ChatView` が構造的に満たす）
  - `MicLoopDeps.createMic?: (cfg: MicAudioConfig) => BrowserMic`
  - `MicLoopDeps.onBargeIn?: () => void`
  - `MicLoop.shutdown(): Promise<void>`
  - `BrowserMic.reconfigure(cfg: MicAudioConfig): void`

- [ ] **Step 1: テスト対象を compile へ追加する**

`tsconfig.test.json` の `include` を次へ変更する。

```json
  "include": [
    "src/backend/**/*",
    "src/shared/**/*",
    "src/frontend/AudioPlayer.ts",
    "src/frontend/MicLoop.ts",
    "tests/**/*"
  ],
  "exclude": ["node_modules", "dist", "dist-test"],
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/mic-loop.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { MicLoop } from "../src/frontend/MicLoop";
import type { BrowserMic } from "../src/frontend/mic";
import type { ClientCommand, HelloPayload } from "../src/shared/protocol";

type AudioConfig = HelloPayload["audio"];
type ListenOptions = Parameters<BrowserMic["listen"]>[0];

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function audioConfig(overrides: Partial<AudioConfig> = {}): AudioConfig {
  return {
    inputMode: "browser",
    playbackTarget: "browser",
    isPrimary: true,
    outputVolume: 1,
    sampleRate: 16000,
    noSpeechTimeoutMs: 5000,
    followup: { enabled: false, maxTurns: 0, timeoutMs: 0, guardMs: 0, keepListening: false },
    bargeIn: { enabled: true, minScore: 0.05 },
    silenceThreshold: 0.02,
    maxRecordMs: 10000,
    vad: {
      frameMs: 20,
      preRollMs: 100,
      silenceDurationMs: 500,
      smoothingAlpha: 0.3,
      relativeThresholdMultiplier: 3,
      maxSilenceThreshold: 0.06,
      calibrationMs: 500,
      debounceFrames: 2,
      inputGain: 1,
    },
    ...overrides,
  };
}

class FakeMic {
  cfg: AudioConfig;
  stopStreamCalls = 0;
  isRunning = false;
  constructor(cfg: AudioConfig, private readonly autoSpeech = false) {
    this.cfg = cfg;
  }
  reconfigure(cfg: AudioConfig): void {
    this.cfg = cfg;
  }
  async start(): Promise<void> {
    this.isRunning = true;
  }
  async stopStream(): Promise<void> {
    this.stopStreamCalls += 1;
    this.isRunning = false;
  }
  async listDevices(): Promise<{ id: string; label: string }[]> {
    return [];
  }
  listen(options: ListenOptions): Promise<never> {
    if (this.autoSpeech) {
      options.onSpeechStart?.();
    }
    return new Promise<never>(() => undefined);
  }
  stop(): void {}
  diagnostics(): string {
    return "";
  }
}

function createView() {
  return {
    deviceSelect: { value: "", disabled: false },
    setDeviceOptions: () => undefined,
    updateLevel: () => undefined,
    resetLevel: () => undefined,
    addSystemNote: () => undefined,
    showToast: () => undefined,
    setServicesText: () => undefined,
  };
}

test("configure はマイクを作り直さず設定だけ差し替える", () => {
  const created: FakeMic[] = [];
  const loop = new MicLoop({
    view: createView(),
    send: () => undefined,
    isConnected: () => true,
    onStateChange: () => undefined,
    createMic: (cfg) => {
      const mic = new FakeMic(cfg);
      created.push(mic);
      return mic as unknown as BrowserMic;
    },
  });

  loop.configure(audioConfig());
  loop.configure(audioConfig({ silenceThreshold: 0.05 }));

  assert.equal(created.length, 1);
  assert.equal(created[0].cfg.silenceThreshold, 0.05);
});

test("shutdown はループを止めてストリームを解放する", async () => {
  const created: FakeMic[] = [];
  const loop = new MicLoop({
    view: createView(),
    send: () => undefined,
    isConnected: () => true,
    onStateChange: () => undefined,
    createMic: (cfg) => {
      const mic = new FakeMic(cfg);
      created.push(mic);
      return mic as unknown as BrowserMic;
    },
  });
  loop.configure(audioConfig());
  await loop.shutdown();
  assert.equal(created[0].stopStreamCalls, 1);
});

test("発話検出時はローカル停止を先に呼び、その後に stop_speaking を送る", async () => {
  const order: string[] = [];
  const loop = new MicLoop({
    view: createView(),
    send: (command: ClientCommand) => order.push(command.type),
    isConnected: () => true,
    onStateChange: () => undefined,
    onBargeIn: () => order.push("barge"),
    createMic: (cfg) => new FakeMic(cfg, true) as unknown as BrowserMic,
  });
  loop.configure(audioConfig());
  void loop.start();
  await flush();

  assert.deepEqual(order, ["barge", "stop_speaking"]);
  loop.stop();
});
```

- [ ] **Step 3: 失敗を確認する**

Run: `npm test 2>&1 | Select-String -Pattern "mic-loop|createMic|onBargeIn" -Context 0,2`
Expected: `createMic` / `onBargeIn` が型に無い、または `shutdown` 不在で失敗

- [ ] **Step 4: 実装を直す**

`src/frontend/mic.ts`:
- `constructor(private readonly config: MicAudioConfig) {}` を `constructor(private config: MicAudioConfig) {}` に変更
- 追加:

```ts
  /** 設定だけ差し替える（AudioContext とストリームは維持。次の listen から反映） */
  reconfigure(config: MicAudioConfig): void {
    this.config = config;
  }
```

`src/frontend/MicLoop.ts`:
- `import type { ChatView } from "./ChatView";` を削除し、次の interface を追加

```ts
export interface MicLoopView {
  readonly deviceSelect: { value: string; disabled: boolean };
  setDeviceOptions(devices: { id: string; label: string }[], current: string): void;
  updateLevel(level: number, threshold: number): void;
  resetLevel(): void;
  addSystemNote(text: string): void;
  showToast(message: string, type?: "info" | "error"): void;
  setServicesText(text: string, offline?: boolean): void;
}
```

- `MicLoopDeps` の `view` を `MicLoopView` に変更し、`createMic` と `onBargeIn` を追加

```ts
export interface MicLoopDeps {
  view: MicLoopView;
  send(command: ClientCommand): void;
  isConnected(): boolean;
  onStateChange(state: AssistantState): void;
  /** マイク生成（テスト用。既定は `new BrowserMic(cfg)`） */
  createMic?(cfg: AudioConfig): BrowserMic;
  /** バージイン検出時にローカル再生を止める（app.ts が audioPlayer.stop を渡す） */
  onBargeIn?(): void;
}
```

- `configure()` を次へ変更

```ts
  configure(cfg: AudioConfig): void {
    this.cfg = cfg;
    if (!this.mic) {
      this.mic = this.deps.createMic?.(cfg) ?? new BrowserMic(cfg);
    } else {
      this.mic.reconfigure(cfg);
    }
    if (cfg.inputMode !== "browser") {
      this.deps.view.deviceSelect.disabled = true;
    }
  }
```

- `stop()` の下に `shutdown()` を追加

```ts
  /** 接続断・ページ破棄でループとマイクを解放する（再接続で二重に開かない） */
  async shutdown(): Promise<void> {
    this.stop();
    await this.mic?.stopStream();
  }
```

- `startBargeMonitor()` の `onSpeechStart` を次へ変更

```ts
        onSpeechStart: () => {
          this.deps.onBargeIn?.();
          this.deps.send({ type: "stop_speaking" });
        },
```

`src/frontend/app.ts`:
- `onClose` の先頭で解放する

```ts
      onClose: () => {
        void this.micLoop.shutdown();
        this.audioPlayer?.stop();
        this.view.setServicesText("サーバー未接続（再接続中…）", true);
        this.setAssistantState("error");
        this.view.showToast("サーバーとの接続が切れました（再接続します）", "error");
      },
```

- `start()` に `beforeunload` を追加（`this.bindEvents()` の前後どちらでもよい）

```ts
    window.addEventListener("beforeunload", () => {
      void this.micLoop.shutdown();
      this.audioPlayer?.dispose();
    });
```

- `applyHello()` の先頭で旧インスタンスを破棄する

```ts
  private applyHello(hello: HelloPayload): void {
    this.ws.helloReceived();
    // 再接続時は旧インスタンスを必ず止める（マイク・AudioContext・口パクのリーク防止）
    this.lipSync?.stop();
    this.lipSync = null;
    this.audioPlayer?.dispose();
    this.audioPlayer = null;
    this.view.setServicesText("");
```

`audioPlayer` の生成は既存の `if (hello.audio.playbackTarget === "browser")` のままでよい（server のときは null のまま）。

- [ ] **Step 5: 通ることを確認する**

Run: `npm run verify 2>&1 | Select-Object -Last 20`
Expected: `# pass 277` 以上、`fail 0`、ビルド成功

- [ ] **Step 6: コミット**

```bash
git add tsconfig.test.json tests/mic-loop.test.ts src/frontend/MicLoop.ts src/frontend/mic.ts src/frontend/app.ts
git commit -m "fix(frontend): 再接続時にマイクと再生リソースを解放する" -m "hello のたびに BrowserMic / AudioPlayer / LipSyncDriver を作り直し、旧インスタンスを止めていなかった。切断時にループとストリームを止め、設定は reconfigure で差し替える。"
```

---

### Task 9: ブラウザのバージインで読み上げキューも止める（B4）

**Files:**
- Modify: `src/backend/conversation/TurnRunner.ts:51-60`, `:272-281`
- Modify: `src/backend/conversation/ConversationPipeline.ts:281-284`
- Modify: `src/frontend/app.ts`（`MicLoop` の deps に `onBargeIn` を渡す）
- Test: `tests/turn-runner-stop-speaking.test.ts`

**Interfaces:**
- Produces:
  - `TurnRunner.stopSpeaking(): void`
  - `ConversationPipeline.stopSpeaking()` は `barge_in` を `state === "speaking"` のときだけ emit する

- [ ] **Step 1: 失敗するテストを書く**

`tests/turn-runner-stop-speaking.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { ConversationHistory } from "../src/backend/conversation/ConversationHistory";
import { TurnRunner, type TurnHooks } from "../src/backend/conversation/TurnRunner";
import type { PromptBuilder } from "../src/backend/conversation/PromptBuilder";
import type { LanguageModel, TextToSpeech } from "../src/backend/core/ports";
import { Logger } from "../src/backend/core/logger";
import { encodeWav } from "../src/backend/services/wav";
import { createTempProject } from "./helpers/project";

test("stopSpeaking 後は残りの文を再生しない", async () => {
  const project = createTempProject({
    patch: {
      tts: {
        split_sentences: true,
        prefetch_depth: 0,
        min_sentence_chars: 1,
        max_sentence_chars: 200,
      },
    },
  });
  try {
    const logger = new Logger("Test");
    logger.info = () => undefined;
    logger.warn = () => undefined;
    logger.error = () => undefined;

    const llm = {
      isAvailable: async () => true,
      listModels: async () => [],
      chatStream: async (_messages: unknown, onDelta: (chunk: string) => void) => {
        onDelta("一文目です。");
        onDelta("二文目です。");
        return "一文目です。二文目です。";
      },
    } as unknown as LanguageModel;

    const tts = {
      isAvailable: async () => true,
      listSpeakers: async () => [],
      synthesize: async () => encodeWav(Buffer.alloc(320), 16000),
    } as TextToSpeech;

    const played: string[] = [];
    let runner!: TurnRunner;
    const hooks: TurnHooks = {
      setState: () => undefined,
      emit: () => undefined,
      onError: (scope, error) => {
        throw new Error(`${scope}: ${String(error)}`);
      },
      onHistoryChanged: () => undefined,
      onReply: () => undefined,
      play: async (_wav, meta) => {
        played.push(meta.text);
        runner.stopSpeaking();
        return undefined;
      },
      stopPlayback: () => undefined,
    };

    runner = new TurnRunner({
      config: project.config,
      history: new ConversationHistory(10),
      promptBuilder: { build: () => "system" } as unknown as PromptBuilder,
      llm,
      tts,
      logger,
    });

    await runner.run("テスト", hooks, new AbortController().signal);
    assert.deepEqual(played, ["一文目です。"]);
  } finally {
    project.cleanup();
  }
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test 2>&1 | Select-String -Pattern "stopSpeaking 後|runner.stopSpeaking" -Context 0,2`
Expected: `runner.stopSpeaking is not a function` で失敗

- [ ] **Step 3: 実装を直す**

`src/backend/conversation/TurnRunner.ts` にフィールドとメソッドを追加する。

```ts
export class TurnRunner {
  private readonly logger: Logger;
  /** 進行中の読み上げキュー（stopSpeaking で残りを捨てる） */
  private activeQueue: SpeechQueue | null = null;
```

```ts
  /** 進行中の読み上げだけを止める（ターンは続ける） */
  stopSpeaking(): void {
    this.activeQueue?.stop();
  }
```

`createQueue()` を次へ変更する。

```ts
  /** 文単位再生のキュー（先読み・直列・中断） */
  private createQueue(hooks: TurnHooks, signal: AbortSignal): SpeechQueue {
    const queue = new SpeechQueue({
      tts: this.deps.tts,
      logger: this.logger,
      signal,
      sampleRate: this.deps.config.getAudio().sample_rate,
      prefetchDepth: this.deps.config.getTTS().prefetch_depth,
      play: (wav, meta) => hooks.play(wav, meta, { announce: false }),
    });
    this.activeQueue = queue;
    return queue;
  }
```

`runStreaming()` の `const result = await queue?.drain();` の直後に追加する。

```ts
    this.activeQueue = null;
```

`src/backend/conversation/ConversationPipeline.ts` の `stopSpeaking()` を次へ変更する。

```ts
  /** 再生のみ停止する（ブラウザからのバージイン用） */
  stopSpeaking(): void {
    // 現在のターンの読み上げキューも止める（次の文が続けて鳴らないように）
    this.turnRunner.stopSpeaking();
    this.playback?.stop();
    if (this.state === "speaking") {
      this.emit({ type: "barge_in" });
    }
  }
```

`src/frontend/app.ts` の `MicLoop` 生成に `onBargeIn` を追加する。

```ts
    this.micLoop = new MicLoop({
      view: this.view,
      send: (command) => this.send(command),
      isConnected: () => this.ws.isOpen,
      onStateChange: (state) => this.setAssistantState(state),
      onBargeIn: () => this.audioPlayer?.stop(),
    });
```

- [ ] **Step 4: 通ることを確認する**

Run: `npm run verify 2>&1 | Select-Object -Last 20`
Expected: `# pass 278` 以上、`fail 0`

- [ ] **Step 5: 手動確認（`barge_in_enabled = true`）**

1. `config/profiles/vtuber-rtx3060.toml` 等で `conversation.barge_in_enabled = true` にする（既定は false）
2. 起動し、長めの応答をさせる
3. 読み上げ開始から 2 秒後に話しかける
Expected: 旧音声が止まり、`logs/app.log` に `barge_in` が記録され、次のターンが始まる

- [ ] **Step 6: コミット**

```bash
git add src/backend/conversation/TurnRunner.ts src/backend/conversation/ConversationPipeline.ts src/frontend/app.ts tests/turn-runner-stop-speaking.test.ts
git commit -m "fix(barge-in): ブラウザの割り込みで読み上げキューを止める" -m "stop_speaking が現在の 1 文しか止めず、残りの文が続けて鳴っていた。TurnRunner が進行中の SpeechQueue を保持し、停止時に残りを捨てる。停止後は barge_in を通知する。"
```

---

### Task 10: 再発防止の文書化と現状同期

**Files:**
- Modify: `AGENTS.md`（§4 の 12-18 の直後）
- Modify: `docs/TODO.md`（§1 の 1-2、§2 の 2-7、§3、冒頭の最終更新）
- Modify: `README.md:212`, `:395` 付近

**Interfaces:** なし（文書のみ）

- [ ] **Step 1: AGENTS.md に再発防止ルールを追加する**

「12-18. **HTTPS は ...**」のブロックの直後、`13. **VAD のしきい値は「較正」で決まる**` の前に挿入する。

```markdown
12-19. **停止は「世代番号 / キャンセルフラグ」で二重実行を防ぐ**
    - ブラウザ再生は `AudioPlayer.token`（`stop()` で +1）。`decodeAudioData` の完了時にも検査する
    - サーバー再生は `PlaybackProcess` の `cancelled`。`writeFile` / `spawn` の前に必ず見る
    - 停止後に遅れて届いた音声・プロセスは捨てる（`audio_playback_done` も送らない）
    - 回帰テスト: `tests/audio-player.test.ts` / `tests/playback-process.test.ts`

12-20. **再接続は teardown → 生成の順**
    - `app.ts` の `onClose` は `micLoop.shutdown()` と `audioPlayer.stop()`
    - `applyHello()` は旧 `lipSync.stop()` / `audioPlayer.dispose()` を**先に**実行する
    - `MicLoop.configure()` はマイクを作り直さず `BrowserMic.reconfigure()` で設定だけ差し替える

12-21. **VAD 設定は `src/shared/audio/vadSettings.ts` のみ**
    - サーバーは `buildVadSettings(audio)`、hello は `buildClientVadSettings(audio)`
    - hello の組み立ては `backend/server/helloPayload.ts` の `buildHelloPayload()`
    - 手写しが復活していないことは `tests/vad-settings-single-source.test.ts` が検出する
```

- [ ] **Step 2: docs/TODO.md を更新する**

冒頭の「最終更新」を次の 1 行へ差し替える。

```markdown
最終更新: 2026-11-25（VAD 設定の単一化・停止/再接続の修正。テストは 255 件）
```

`### P1: 次にやる` の表から **1-2（VAD 設定の二重管理の解消）の行を削除**する。

`### P2: 余裕があれば` の 2-7 の「現状 / 理由」を次へ差し替える。

```markdown
| 2-7 | **`mic.ts`（398 行）の分割** | P3 でフロントを分割したが `BrowserMic` は未分割（デバイス管理・AudioWorklet・VAD 駆動・診断が同居）。2026-11 に `reconfigure()` のみ追加済み | 取得（`MicSource`）と VAD 駆動（`listen` / `stop`）に分割。`listen` の戻り値（`ListenResult`）は不変に保つ | 1 日 |
```

`## 3. 既知の制約` の表に次の行を追加する。

```markdown
| `/api/models/stt` は絶対パスも受理する | `ConfigManager.resolvePath()` が絶対パスをそのまま返すため。localhost 前提のローカルアプリなので許可リストは未導入（外部公開するなら必要） |
```

- [ ] **Step 3: README.md のバージイン説明を更新する**

`バージインは既定で無効（ブラウザのエコーキャンセルは ffplay の再生音には効かないため。有効化はヘッドホン推奨）` の直後に追加する。

```markdown
  - 有効時は、発話を検出した時点で**残りの文も含めて**読み上げを止め、その発話を次のターンとして処理します
```

`## トラブルシュート` の表（「バージインしない」の行の下）に追加する。

```markdown
| 停止したのに音が鳴る | ブラウザ再生は `AudioPlayer`、サーバー再生は `PlaybackProcess` が停止後の音声・プロセスを捨てます。古いビルドが残っていないか `npm run build` を確認してください |
```

`docs/DESIGN.md` は旧構成（`src/backend/pipeline.ts` 等）のままの As-Is 記録なので、本タスクでは触らない。
現行構成は `AGENTS.md` §3 と `docs/REDESIGN.md` を参照する（全面更新は別タスク）。

- [ ] **Step 4: 検証する**

Run: `npm run verify 2>&1 | Select-Object -Last 20`
Expected: `# pass 278`、`fail 0`、ビルド成功

- [ ] **Step 5: 一時ファイルの混入がないことを確認する**

Run: `git status --porcelain`
Expected: `M AGENTS.md` / `M README.md` / `M docs/TODO.md` のみ（`dist-test` や `logs/` が出ない）

- [ ] **Step 6: コミット**

```bash
git add AGENTS.md README.md docs/TODO.md
git commit -m "docs: 停止・再接続・VAD 設定の再発防止ルールを反映する" -m "実装した単一経路（buildVadSettings / buildHelloPayload / 停止のキャンセル / teardown）を AGENTS.md に記録し、TODO の完了項目と既知の制約を現状に合わせる。"
```

---

## 仕様との対応（セルフレビュー）

| 設計の項目 | 実装タスク |
|---|---|
| B1 ブラウザ再生の停止後デコード | Task 6 |
| B2 サーバー再生の停止後 spawn | Task 7 |
| B3 再接続時の teardown | Task 8 |
| B4 ブラウザのバージインでキュー停止 | Task 9 |
| B5 VAD 設定の単一真実源 | Task 1 / Task 3（hello は Task 2） |
| B6 sherpa 種別の型ガード | Task 4 |
| B7 `errorText` の重複 | Task 5 |
| B8 絶対パス受理の文書化 | Task 10 Step 2 |
| B9 テスト件数の陳腐化 | Task 10 Step 2 |
| P3 追加抽出（任意） | 実施しない（Task 10 Step 2 で TODO 2-7 を更新） |
| P4 文書・再発防止 | Task 10 |

### 実行時の注意

- Task 6 / Task 8 で `tsconfig.test.json` を変更する。**最終形は `src/frontend/AudioPlayer.ts` と `src/frontend/MicLoop.ts` の 2 つ**を含む形にする
- テスト件数は追加のたびに増える。`# pass` の期待値は各タスクの値を目安にし、**`fail 0` を必須**とする
- Task 7 / Task 9 は `fix(...)`、それ以外は `refactor(...)` / `docs(...)`。1 タスク 1 コミットを守る
- 手動確認（Task 9 Step 5）は既定 OFF の機能なので、確認後は `barge_in_enabled` を元に戻す














