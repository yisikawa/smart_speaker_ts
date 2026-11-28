# アバター感情連動モーション Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hiyori の 4 本腕を Idle モーションで解消し、感情タグに応じて A が残るモーションを再生する。

**Architecture:** 感情キーを `extractEmotion()` から `tts_audio.emotion` まで伝搬し、クライアントが `hello.avatar.motions` の設定でモーショングループへ変換して `stage.playMotion()` する。モデル側は `model3.json` の `Motions.Idle` が PartOpacity を切り替え、4 本腕を解消する。

**Tech Stack:** TypeScript strict / node:test / pixi-live2d-display 0.4.0 / esbuild / Express + WebSocket

## Global Constraints

- 新規依存は追加しない。TypeScript `strict` を維持する。
- コメント・UI 文言・ログは日本語。
- テストは `node:test`。作業後は `npm run verify`（typecheck → test → build）を通す。
- `Live2DModels/` と `config/settings.toml` は **gitignore 対象**。モデル設定とローカル設定はコミットしない（`git add -f` 禁止）。
- **コミットはプロジェクト規約により、ユーザーの明示的な承認があるまで実行しない。** 各タスクの Commit ステップは承認後のチェックポイントとする。
- B が残るモーション（m06 / m08）は追加しない。
- モーショングループ名は `M01`〜`M10`（`Idle` を除く）とし、感情との対応は `[avatar.motions]` に置く。

---

### Task 1: `extractEmotion()` が感情キーを返す

**Files:**
- Modify: `src/shared/avatar/emotion.ts`
- Test: `tests/emotion.test.ts`

**Interfaces:**
- Produces: `EmotionExtraction.emotion: EmotionKey | null`
- Produces: `extractEmotion(text, expressions, options): { text: string; expression: string | null; emotion: EmotionKey | null }`

- [ ] **Step 1: 失敗するテストへ更新する**

`tests/emotion.test.ts` を次の内容に置き換える。

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { extractEmotion, inferEmotion } from "../src/shared/avatar/emotion";

const expressions = { happy: "exp_01", sad: "exp_03", angry: "" };

test("タグを取り除き、設定から表情名へ解決する", () => {
  assert.deepEqual(extractEmotion("おはよう！[喜] いい天気だね。", expressions), {
    text: "おはよう！ いい天気だね。",
    expression: "exp_01",
    emotion: "happy",
  });
});

test("設定が空文字なら表情は変えないが感情キーは返す", () => {
  assert.deepEqual(extractEmotion("もう！[怒]", expressions), {
    text: "もう！",
    expression: null,
    emotion: "angry",
  });
});

test("未知のタグは落とすが表情も感情も変えない", () => {
  assert.deepEqual(extractEmotion("えっ[謎] 本当？", expressions), {
    text: "えっ 本当？",
    expression: null,
    emotion: null,
  });
});

test("複数タグは最後を採用し、全部取り除く", () => {
  assert.deepEqual(extractEmotion("[喜]やった[哀]", expressions), {
    text: "やった",
    expression: "exp_03",
    emotion: "sad",
  });
});

test("タグが無ければ推定する（heuristic=true）", () => {
  assert.deepEqual(extractEmotion("ありがとう！", expressions, { heuristic: true }), {
    text: "ありがとう！",
    expression: "exp_01",
    emotion: "happy",
  });
  assert.deepEqual(extractEmotion("ありがとう！", expressions), {
    text: "ありがとう！",
    expression: null,
    emotion: null,
  });
});

test("推定の語彙", () => {
  assert.equal(inferEmotion("ありがとう！"), "happy");
  assert.equal(inferEmotion("ごめんなさい…"), "sad");
  assert.equal(inferEmotion("えっ、本当！？"), "surprised");
  assert.equal(inferEmotion("はずかしいな"), "shy");
  assert.equal(inferEmotion("たぶんね"), "thinking");
  assert.equal(inferEmotion("ああ"), null);
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-timeout=30000 dist-test/tests/emotion.test.js
```

Expected: 各 `deepEqual` が FAIL（actual に `emotion` が無い）。

- [ ] **Step 3: 最小の実装を入れる**

`src/shared/avatar/emotion.ts` の `EmotionExtraction` と `extractEmotion()` を変更する。

```ts
export interface EmotionExtraction {
  /** タグを除去した読み上げ用テキスト */
  text: string;
  /** 解決済みのモデル表情名（無ければ null） */
  expression: string | null;
  /** タグ・推定から得た感情キー（無ければ null） */
  emotion: EmotionKey | null;
}
```

```ts
  const expression = key ? expressions[key] || null : null;
  return { text: stripped.replace(/\s{2,}/g, " ").trim(), expression, emotion: key };
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-timeout=30000 dist-test/tests/emotion.test.js
```

Expected: PASS（全 6 テスト）。

- [ ] **Step 5: Commit（ユーザーの明示的な承認後）**

```bash
git add src/shared/avatar/emotion.ts tests/emotion.test.ts
git commit -m "feat(emotion): 感情キーを抽出結果に含める"
```

---

### Task 2: 感情キーを `PlaybackMeta` / `tts_audio` まで通す

**Files:**
- Modify: `src/backend/core/ports.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/backend/conversation/SpeechQueue.ts`
- Modify: `src/backend/server/WsPlaybackSink.ts`
- Test: `tests/speech-queue.test.ts`
- Test: `tests/ws-playback-sink.test.ts`

**Interfaces:**
- Consumes: `EmotionKey`（Task 1）
- Produces: `PlaybackMeta.emotion?: EmotionKey`
- Produces: `tts_audio.emotion?: EmotionKey`
- Produces: `SpeechQueue.enqueue(text: string, expression?: string, emotion?: EmotionKey): void`

- [ ] **Step 1: 失敗するテストを追加する**

`tests/speech-queue.test.ts` の末尾に追加する。

```ts
test("感情キーを meta に伝搬する", async () => {
  const metas: PlaybackMeta[] = [];
  const queue = makeQueue({
    tts: makeTts([]),
    playImpl: async (_wav, meta) => {
      metas.push(meta);
      return undefined;
    },
  });
  queue.enqueue("やった！", undefined, "happy");
  await queue.drain();
  assert.equal(metas[0]?.emotion, "happy");
});
```

`tests/ws-playback-sink.test.ts` の `meta` に `emotion: "happy"` を追加し、型キャストと assertion を更新する。

```ts
const meta: PlaybackMeta = {
  utteranceId: "u1",
  text: "こんにちは",
  expression: "exp_01",
  emotion: "happy",
  volumes: [0.5, 1],
  sliceMs: 20,
  durationMs: 100,
};
```

```ts
  const message = sent[0] as {
    type: "event";
    event: { type: string; utteranceId: string; audio: string; expression?: string; emotion?: string };
  };
  assert.equal(message.type, "event");
  assert.equal(message.event.type, "tts_audio");
  assert.equal(message.event.utteranceId, "u1");
  assert.equal(message.event.audio, "AQID");
  assert.equal(message.event.expression, "exp_01");
  assert.equal(message.event.emotion, "happy");
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run:

```bash
npx tsc -p tsconfig.test.json
```

Expected: `PlaybackMeta` に `emotion` が無いというコンパイルエラー（Feature missing の RED）。

- [ ] **Step 3: 最小の実装を入れる**

`src/backend/core/ports.ts` の先頭に import を追加する。

```ts
import type { EmotionKey } from "../../shared/avatar/emotion";
```

`PlaybackMeta` に追加する。

```ts
  /** 感情キー（クライアントのモーション選択用。無ければ undefined） */
  emotion?: EmotionKey;
```

`src/shared/protocol.ts` の先頭に import を追加する。

```ts
import type { EmotionKey } from "./avatar/emotion";
```

`tts_audio` イベントに追加する。

```ts
      /** 感情キー（クライアントのモーション選択用） */
      emotion?: EmotionKey;
```

`src/backend/conversation/SpeechQueue.ts` を変更する。

```ts
import type { EmotionKey } from "../../shared/avatar/emotion";
```

```ts
interface Item {
  text: string;
  expression?: string;
  emotion?: EmotionKey;
  promise?: Promise<Buffer | null>;
}
```

```ts
  enqueue(text: string, expression?: string, emotion?: EmotionKey): void {
    const trimmed = text.trim();
    if (!trimmed || this.stopped || this.deps.signal.aborted) {
      return;
    }
    this.items.push({ text: trimmed, expression, emotion });
    void this.run();
  }
```

```ts
        const barge = await this.deps.play(wav, this.meta(wav, item.text, item.expression, item.emotion));
```

```ts
  private meta(
    wav: Buffer,
    text: string,
    expression?: string,
    emotion?: EmotionKey
  ): PlaybackMeta {
    return {
      utteranceId: randomUUID(),
      text,
      expression,
      emotion,
      volumes: buildVolumeEnvelope(wav),
      sliceMs: 20,
      durationMs: wavDurationMs(wav, this.deps.sampleRate),
    };
  }
```

`src/backend/server/WsPlaybackSink.ts` の `tts_audio` オブジェクトに追加する。

```ts
        expression: meta.expression,
        emotion: meta.emotion,
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-timeout=30000 dist-test/tests/speech-queue.test.js dist-test/tests/ws-playback-sink.test.js
```

Expected: PASS（既存テスト + 追加テスト）。

- [ ] **Step 5: Commit（ユーザーの明示的な承認後）**

```bash
git add src/backend/core/ports.ts src/shared/protocol.ts src/backend/conversation/SpeechQueue.ts src/backend/server/WsPlaybackSink.ts tests/speech-queue.test.ts tests/ws-playback-sink.test.ts
git commit -m "feat(protocol): tts_audio に感情キーを追加する"
```

---

### Task 3: TurnRunner（文単位）が感情キーを渡す

**Files:**
- Modify: `src/backend/conversation/TurnRunner.ts`
- Test: `tests/turn-runner-streaming.test.ts`

**Interfaces:**
- Consumes: `extractEmotion().emotion`（Task 1）、`SpeechQueue.enqueue(..., emotion)`（Task 2）
- Produces: 文単位の再生で `tts_audio.emotion` が設定される

- [ ] **Step 1: 失敗するテストを追加する**

`tests/turn-runner-streaming.test.ts` の import に `PlaybackMeta` を追加する。

```ts
import type { LanguageModel, PlaybackMeta, TextToSpeech } from "../src/backend/core/ports";
```

`setup()` に `metas` を追加し、`play` で捕捉する。

```ts
  const synthCalls: string[] = [];
  const played: string[] = [];
  const metas: PlaybackMeta[] = [];
  const events: PipelineEvent[] = [];
```

```ts
    play: async (_wav, meta) => {
      metas.push(meta);
      played.push(meta.text);
      return undefined;
    },
```

```ts
  return { project, runner, hooks, synthCalls, played, metas, events };
```

末尾にテストを追加する。

```ts
test("感情タグの感情キーを meta に伝える", async () => {
  const ctx = setup({ replies: ["おはよう！[喜] いい天気だね。"] });
  try {
    await ctx.runner.run("やあ", ctx.hooks, new AbortController().signal);
    assert.ok(
      ctx.metas.some((meta) => meta.emotion === "happy"),
      "感情キーが tts_audio 用の meta に載ること"
    );
  } finally {
    ctx.project.cleanup();
  }
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-timeout=30000 dist-test/tests/turn-runner-streaming.test.js
```

Expected: FAIL（`meta.emotion` がすべて undefined）。

- [ ] **Step 3: 最小の実装を入れる**

`src/backend/conversation/TurnRunner.ts` の `runStreaming()` 内の `enqueue` を変更する。

```ts
      const { text, expression, emotion } = extractEmotion(raw, avatarConfig.expressions, {
        heuristic: avatarConfig.emotion_heuristic_enabled,
        vocabulary: pack.emotion,
      });
```

```ts
      queue.enqueue(text, expression ?? undefined, emotion ?? undefined);
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-timeout=30000 dist-test/tests/turn-runner-streaming.test.js
```

Expected: PASS。

- [ ] **Step 5: Commit（ユーザーの明示的な承認後）**

```bash
git add src/backend/conversation/TurnRunner.ts tests/turn-runner-streaming.test.ts
git commit -m "feat(turn): 文単位の再生に感情キーを伝搬する"
```

---

### Task 4: 全文一括モードでもタグを除去し感情キーを渡す

**Files:**
- Modify: `src/backend/conversation/TurnRunner.ts`
- Test: `tests/turn-runner-streaming.test.ts`

**Interfaces:**
- Consumes: `extractEmotion()`（Task 1）
- Produces: `split_sentences=false` でも TTS にタグが渡らず、`PlaybackMeta.emotion` が設定される

- [ ] **Step 1: 失敗するテストを追加する**

`tests/turn-runner-streaming.test.ts` の末尾に追加する。

```ts
test("split_sentences=false でもタグを読み上げず感情キーを渡す", async () => {
  const ctx = setup({ replies: ["おはよう！[喜] いい天気だね。"], split: false });
  try {
    await ctx.runner.run("やあ", ctx.hooks, new AbortController().signal);
    assert.deepEqual(ctx.synthCalls, ["おはよう！ いい天気だね。"]);
    assert.equal(ctx.metas[0]?.emotion, "happy");
  } finally {
    ctx.project.cleanup();
  }
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-timeout=30000 dist-test/tests/turn-runner-streaming.test.js
```

Expected: FAIL（合成テキストに `[喜]` が残り、`emotion` が undefined）。

- [ ] **Step 3: 最小の実装を入れる**

`src/backend/conversation/TurnRunner.ts` の import に `EmotionKey` を追加する。

```ts
import { extractEmotion, type EmotionKey } from "../../shared/avatar/emotion";
```

`runWholeText()` の `reply = reply.trim();` 以降を次のように変更する（`llm_complete`・履歴・`onReply` は従来どおり raw の `reply` を使う）。

```ts
    reply = reply.trim();
    hooks.emit({ type: "llm_complete", text: reply, elapsedMs: Date.now() - llmStartedAt });
    if (!reply) {
      hooks.emit({ type: "error", scope: "llm", message: "LLM の応答が空でした" });
      return undefined;
    }
    this.deps.history.add("assistant", reply);
    hooks.onReply(reply);
    hooks.onHistoryChanged();

    const avatarConfig = this.deps.config.getAvatar();
    const pack = getLanguagePack(mode);
    const { text: spoken, expression, emotion } = extractEmotion(reply, avatarConfig.expressions, {
      heuristic: avatarConfig.emotion_heuristic_enabled,
      vocabulary: pack.emotion,
    });

    hooks.setState("speaking");
    hooks.emit({ type: "tts_started" });
    const ttsStartedAt = Date.now();
    let wav: Buffer;
    try {
      wav = await this.deps.tts.synthesize(spoken, { signal });
    } catch (error) {
      if (signal.aborted) {
        return undefined;
      }
      hooks.onError("tts", error);
      return undefined;
    }
    hooks.emit({ type: "tts_complete", elapsedMs: Date.now() - ttsStartedAt });
    return hooks.play(wav, this.meta(wav, spoken, expression ?? undefined, emotion ?? undefined));
```

`meta()` を次のシグネチャに変更する。

```ts
  private meta(
    wav: Buffer,
    text: string,
    expression?: string,
    emotion?: EmotionKey
  ): PlaybackMeta {
    return {
      utteranceId: randomUUID(),
      text,
      expression,
      emotion,
      volumes: buildVolumeEnvelope(wav),
      sliceMs: 20,
      durationMs: wavDurationMs(wav, this.deps.config.getAudio().sample_rate),
    };
  }
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-timeout=30000 dist-test/tests/turn-runner-streaming.test.js
```

Expected: PASS（全テスト）。

- [ ] **Step 5: Commit（ユーザーの明示的な承認後）**

```bash
git add src/backend/conversation/TurnRunner.ts tests/turn-runner-streaming.test.ts
git commit -m "fix(turn): 全文一括時も感情タグを除去して感情キーを渡す"
```

---

### Task 5: 感情キー → モーショングループの純粋関数

**Files:**
- Create: `src/shared/avatar/motionSelection.ts`
- Test: `tests/motion-selection.test.ts`

**Interfaces:**
- Produces: `selectMotionGroup(motions: Record<string, string>, emotion: EmotionKey | null | undefined, current: string | null): string | null`

- [ ] **Step 1: 失敗するテストを作成する**

`tests/motion-selection.test.ts` を作成する。

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { selectMotionGroup } from "../src/shared/avatar/motionSelection";

const motions = { happy: "M05", angry: "", sad: "M04" };

test("感情キーに対応するグループを返す", () => {
  assert.equal(selectMotionGroup(motions, "happy", null), "M05");
  assert.equal(selectMotionGroup(motions, "happy", "M03"), "M05");
});

test("未設定・空文字・感情なしは再生しない", () => {
  assert.equal(selectMotionGroup(motions, "angry", null), null);
  assert.equal(selectMotionGroup(motions, "surprised", null), null);
  assert.equal(selectMotionGroup(motions, null, null), null);
  assert.equal(selectMotionGroup(motions, undefined, null), null);
});

test("再生中のグループと同じなら再スタートしない", () => {
  assert.equal(selectMotionGroup(motions, "happy", "M05"), null);
  assert.equal(selectMotionGroup(motions, "sad", "M04"), null);
});

test("前後の空白は無視する", () => {
  assert.equal(selectMotionGroup({ happy: " M05 " }, "happy", null), "M05");
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run:

```bash
npx tsc -p tsconfig.test.json
```

Expected: `Cannot find module '../src/shared/avatar/motionSelection'`（Feature missing の RED）。

- [ ] **Step 3: 最小の実装を作成する**

`src/shared/avatar/motionSelection.ts` を作成する。

```ts
import type { EmotionKey } from "./emotion";

/**
 * 感情キーからモーショングループを選ぶ。
 * 未設定・空文字・現在再生中のグループと同じ場合は null（再生しない）。
 */
export function selectMotionGroup(
  motions: Record<string, string>,
  emotion: EmotionKey | null | undefined,
  current: string | null
): string | null {
  if (!emotion) {
    return null;
  }
  const group = motions[emotion]?.trim();
  if (!group || group === current) {
    return null;
  }
  return group;
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-timeout=30000 dist-test/tests/motion-selection.test.js
```

Expected: PASS（4 テスト）。

- [ ] **Step 5: Commit（ユーザーの明示的な承認後）**

```bash
git add src/shared/avatar/motionSelection.ts tests/motion-selection.test.ts
git commit -m "feat(avatar): 感情キーからモーショングループを選ぶ"
```

---

### Task 6: クライアントが感情モーションを再生する

**Files:**
- Modify: `src/frontend/StageView.ts`
- Modify: `src/frontend/app.ts`

**Interfaces:**
- Consumes: `selectMotionGroup()`（Task 5）、`tts_audio.emotion`（Task 2）、`hello.avatar.motions`
- Produces: `StageView.playMotion(group: string): void`（`AvatarStage` へ委譲）
- Produces: `tts_audio` 受信時の Live2D モーション再生

- [ ] **Step 1: `StageView` に `playMotion` を追加する**

`src/frontend/StageView.ts` の `setExpression()` の後に追加する。

```ts
  playMotion(group: string): void {
    this.avatar.playMotion(group);
  }
```

- [ ] **Step 2: import とフィールドを追加する**

`src/frontend/app.ts` の import に追加する。

```ts
import { selectMotionGroup } from "../shared/avatar/motionSelection";
```

`SumikaApp` のフィールドに追加する。

```ts
  /** 感情キー → モーショングループ（hello.avatar.motions） */
  private avatarMotions: Record<string, string> = {};
  /** 現在再生中のモーショングループ（同一ターン内の連続再生を抑制） */
  private currentMotion: string | null = null;
```

- [ ] **Step 3: hello で対応表を取り込む**

`applyHello()` の `this.inputMode = hello.audio.inputMode;` の近くに追加する。

```ts
    this.avatarMotions = { ...(hello.avatar?.motions ?? {}) };
    this.currentMotion = null;
```

- [ ] **Step 4: ターン開始でリセットし、tts_audio で再生する**

`handleEvent()` の `llm_started` に追加する。

```ts
      case "llm_started":
        this.caption = "";
        this.currentMotion = null;
        this.stage.setCaption("", false);
        break;
```

`tts_audio` を次のように変更する。

```ts
      case "tts_audio": {
        this.stage.setExpression(event.expression ?? null);
        const motion = selectMotionGroup(this.avatarMotions, event.emotion, this.currentMotion);
        if (motion) {
          this.currentMotion = motion;
          this.stage.playMotion(motion);
        }
        this.audioPlayer?.enqueue(event);
        break;
      }
```

- [ ] **Step 5: 型チェックを実行する**

Run:

```bash
npx tsc -p tsconfig.frontend.json
```

Expected: PASS（エラーなし）。

この配線は DOM / WebAudio に依存し、bundle のテストハーネスからは再生結果を観測できない。
判定ロジックは Task 5 の純粋関数テストで担保し、実際の Live2D 再生は Task 9 で目視確認する。

- [ ] **Step 6: Commit（ユーザーの明示的な承認後）**

```bash
git add src/frontend/StageView.ts src/frontend/app.ts
git commit -m "feat(ui): 感情タグに応じてアバターのモーションを再生する"
```

---

### Task 7: 既定の感情マッピングとローカル設定

**Files:**
- Modify: `src/backend/config/schema.ts`
- Modify: `config/settings.default.toml`
- Modify（ローカル・gitignore）: `config/settings.toml`
- Modify: `AGENTS.md`
- Modify: `docs/REDESIGN.md`
- Test: `tests/config-defaults.test.ts`

**Interfaces:**
- Produces: 既定の `[avatar.motions]` = happy→M05 / angry→M03 / sad→M04 / surprised→M01 / shy→M07 / thinking→M09

- [ ] **Step 1: schema の既定値を変更してテストの失敗を確認する**

`src/backend/config/schema.ts` の `motions` を変更する。

```ts
    motions: {
      happy: "M05",
      angry: "M03",
      sad: "M04",
      surprised: "M01",
      shy: "M07",
      thinking: "M09",
    },
```

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-timeout=30000 dist-test/tests/config-defaults.test.js
```

Expected: FAIL（`settings.default.toml` に `avatar.motions.happy` などが無い）。

- [ ] **Step 2: `config/settings.default.toml` を同期する**

Run:

```bash
npm run config:default
```

その後、`config/settings.default.toml` の `[avatar.motions]` を次の内容にする（同期スクリプトは古い `greeting` / `nod` を削除しないため、手で削除する）。

```toml
[avatar.motions]
happy = "M05"
angry = "M03"
sad = "M04"
surprised = "M01"
shy = "M07"
thinking = "M09"
```

- [ ] **Step 3: ローカルの `config/settings.toml` を更新する**

`config/settings.toml` の `[avatar.motions]` を同じ内容に置き換える（このファイルは gitignore なのでコミットしない）。

```toml
[avatar.motions]
happy = "M05"
angry = "M03"
sad = "M04"
surprised = "M01"
shy = "M07"
thinking = "M09"
```

- [ ] **Step 4: ドキュメントを更新する**

`AGENTS.md` の 12-13（感情タグ）に追記する。

```md
    - 感情キーは `tts_audio.emotion` でクライアントへ渡し、`[avatar.motions]` の対応で
      `stage.playMotion()` する。モデル側は `Motions.Idle` が必須（hiyori は PartArmA/B の切り替え）。
```

`docs/REDESIGN.md` の 13.3 付近に追記する。

```md
- `tts_audio.emotion` は感情キー（happy / angry / ...）。クライアントは `avatar.motions` で
  モーショングループへ変換して `playMotion()` する。`Motions.Idle` はモデルの待機モーション。
```

- [ ] **Step 5: テストを実行して成功を確認する**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-timeout=30000 dist-test/tests/config-defaults.test.js
```

Expected: PASS。

- [ ] **Step 6: Commit（ユーザーの明示的な承認後）**

```bash
git add src/backend/config/schema.ts config/settings.default.toml AGENTS.md docs/REDESIGN.md
git commit -m "feat(config): 感情キーごとの既定モーションを設定する"
```

---

### Task 8: hiyori のモデル設定と README

**Files:**
- Modify（ローカル・gitignore）: `Live2DModels/hiyori_vts/hiyori.model3.json`
- Modify: `README.md`

**Interfaces:**
- Produces: `Motions.Idle`（m02）と A の 7 モーション（M01/M03/M04/M05/M07/M09/M10）

- [ ] **Step 1: モデルの `FileReferences` に Motions を追加する**

`Live2DModels/hiyori_vts/hiyori.model3.json` の `FileReferences` を次の形にする。

```json
	"FileReferences": {
		"Moc": "hiyori.moc3",
		"Textures": [
			"hiyori.2048/texture_00.png",
			"hiyori.2048/texture_01.png"
		],
		"Physics": "hiyori.physics3.json",
		"DisplayInfo": "hiyori.cdi3.json",
		"Motions": {
			"Idle": [{ "File": "animations/hiyori_m02.motion3.json" }],
			"M01": [{ "File": "animations/hiyori_m01.motion3.json" }],
			"M03": [{ "File": "animations/hiyori_m03.motion3.json" }],
			"M04": [{ "File": "animations/hiyori_m04.motion3.json" }],
			"M05": [{ "File": "animations/hiyori_m05.motion3.json" }],
			"M07": [{ "File": "animations/hiyori_m07.motion3.json" }],
			"M09": [{ "File": "animations/hiyori_m09.motion3.json" }],
			"M10": [{ "File": "animations/hiyori_m10.motion3.json" }]
		}
	},
```

このファイルは gitignore 対象のため **コミットしない**。

- [ ] **Step 2: JSON とグループを検証する**

Run:

```bash
node -e "const j=require('./Live2DModels/hiyori_vts/hiyori.model3.json'); console.log(Object.keys(j.FileReferences.Motions))"
```

Expected:

```text
[ 'Idle', 'M01', 'M03', 'M04', 'M05', 'M07', 'M09', 'M10' ]
```

- [ ] **Step 3: README にモデル側の注意を追記する**

`README.md` の `model3.json` の説明（255 行目付近）の後に追加する。

```md
- hiyori のように PartArmA / PartArmB を持つモデルは、`model3.json` の
  `FileReferences.Motions` に `Idle`（例: `animations/hiyori_m02.motion3.json`）を登録する。
  `Idle` は自動再生され、片方の腕が隠れる。感情タグに応じたモーションは
  `[avatar.motions]` で「感情キー → モーショングループ」を設定する（例: `happy = "M05"`）。
```

- [ ] **Step 4: Commit（ユーザーの明示的な承認後）**

```bash
git add README.md
git commit -m "docs: hiyori の Motions.Idle と感情モーションの設定を追記する"
```

---

### Task 9: 一括検証と実機確認

**Files:** なし（検証のみ）

- [ ] **Step 1: 一括検証を実行する**

Run:

```bash
npm run verify
```

Expected: typecheck → 全テスト PASS → build 成功。

- [ ] **Step 2: サーバーを再起動して設定を反映する**

Run（既存の起動方法に従う）:

```bat
.\quit.bat
.\start.bat
```

`config/settings.toml` と `schema.ts` の既定値は起動時に読まれるため、再起動が必要。
`Live2DModels/hiyori_vts/hiyori.model3.json` は静的配信なので、ページ再読み込みで反映される。

- [ ] **Step 3: 画面で確認する**

確認項目:

1. ページを再読み込みし、hiyori の腕が **2 本**になっている（Idle モーションが PartArmB を隠す）
2. 感情タグ付きの応答（例: `[喜]`）で対応するモーション（M05）が 1 回再生される
3. 同じターン内で同じモーションが連続再生されず、次のターンでは再び再生される
4. `speech_reset` 後にアプリが落ちない
5. `logs/app.log` に新規エラーが出ていない

- [ ] **Step 4: 作業ツリーを確認する**

Run:

```bash
git status --short
```

Expected: 意図した tracked ファイルのみ。`Live2DModels/` と `config/settings.toml` が変更一覧に出ないこと。
