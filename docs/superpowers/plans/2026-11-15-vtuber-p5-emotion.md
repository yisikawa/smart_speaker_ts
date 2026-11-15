# VTuber 化 P5（感情タグ → 表情）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM の応答に `[喜]` などの感情タグを混ぜさせ、タグを読み上げから除去して**表情だけ**に反映する。タグが無い文は語彙から推定する。

**Architecture:** `shared/avatar/emotion.ts`（純粋）がタグ抽出・解決・推定を担う。`TurnRunner` が文ごとに適用して `SpeechQueue` へ `(text, expression)` を渡し、`PlaybackMeta.expression` → `tts_audio.expression` として画面へ届く。画面は `AvatarStage.setExpression()` に流す。

**Tech Stack:** TypeScript 5（strict）/ `node:test` / VOICEVOX / esbuild IIFE

## Global Constraints

- `develop` ブランチ。日本語コミット。作業後に `npm run verify`。
- 純粋ロジックは `src/shared`。タグは**必ず TTS の前**に除去する。
- `avatar.emotion_tags_enabled=false` でプロンプトに語彙を入れない。`emotion_heuristic_enabled=false` で推定しない。
- 未知のタグは落とすが、表情は変えない（`expressions` の空文字は「変えない」）。
- VOICEVOX のスタイル切替（`emotion_styles`）は今回のスコープ外（P5b）。

## スコープ

P5 のみ（設計書 §7）。Live2D の表情適用は P4、スタイル切替は P5b。

---

## ファイル構成

| パス | 役割 |
|---|---|
| `src/shared/avatar/emotion.ts`（新規） | タグ抽出・表情解決・語彙推定（純粋） |
| `src/backend/conversation/PromptBuilder.ts`（変更） | 感情タグの語彙 |
| `src/backend/conversation/TurnRunner.ts`（変更） | 文ごとのタグ除去と表情の決定 |
| `src/backend/conversation/SpeechQueue.ts`（変更） | `expression` を meta へ |
| `src/backend/core/ports.ts`（変更） | `PlaybackMeta.expression?` |
| `src/backend/server/WsPlaybackSink.ts`（変更） | `tts_audio.expression` |
| `src/shared/protocol.ts`（変更） | `tts_audio.expression?: string` |
| `src/frontend/app.ts`（変更） | 表情の適用と解除 |
| `tests/emotion.test.ts` / `tests/prompt-builder-avatar.test.ts`（新規） | 回帰 |

---

### Task 1: 感情タグの抽出と推定（純粋）

**Files:**
- Create: `src/shared/avatar/emotion.ts`
- Test: `tests/emotion.test.ts`

**Interfaces:**
- Produces: `EMOTION_TAGS` / `extractEmotion(text, expressions, options?)` / `inferEmotion(text)` / `resolveKey(raw)`

- [ ] **Step 1: 失敗するテストを書く**

`tests/emotion.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { extractEmotion, inferEmotion } from "../src/shared/avatar/emotion";

const expressions = { happy: "exp_01", sad: "exp_03", angry: "" };

test("タグを取り除き、設定から表情名へ解決する", () => {
  assert.deepEqual(extractEmotion("おはよう！[喜] いい天気だね。", expressions), {
    text: "おはよう！ いい天気だね。",
    expression: "exp_01",
  });
});

test("設定が空文字なら表情は変えない", () => {
  assert.deepEqual(extractEmotion("もう！[怒]", expressions), { text: "もう！", expression: null });
});

test("未知のタグは落とすが表情は変えない", () => {
  assert.deepEqual(extractEmotion("えっ[謎] 本当？", expressions), { text: "えっ 本当？", expression: null });
});

test("複数タグは最後を採用し、全部取り除く", () => {
  assert.deepEqual(extractEmotion("[喜]やった[哀]", expressions), { text: "やった", expression: "exp_03" });
});

test("タグが無ければ推定する（heuristic=true）", () => {
  assert.deepEqual(extractEmotion("ありがとう！", expressions, { heuristic: true }), {
    text: "ありがとう！",
    expression: "exp_01",
  });
  assert.deepEqual(extractEmotion("ありがとう！", expressions), { text: "ありがとう！", expression: null });
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

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsc -p tsconfig.test.json`
Expected: FAIL（モジュールが見つからない）

- [ ] **Step 3: 実装する**

`src/shared/avatar/emotion.ts`:

```ts
export type EmotionKey = "happy" | "angry" | "sad" | "surprised" | "shy" | "thinking";

/** プロンプトに出すタグ → 意味キー */
export const EMOTION_TAGS: Record<string, EmotionKey> = {
  "喜": "happy",
  "怒": "angry",
  "哀": "sad",
  "驚": "surprised",
  "照": "shy",
  "考": "thinking",
};

const TAG_PATTERN = /\[([^\]]{1,12})\]/g;

/** 推定に使う語彙（上から順に判定する） */
const HEURISTICS: { key: EmotionKey; words: string[] }[] = [
  { key: "surprised", words: ["えっ", "まさか", "本当", "びっくり", "！？", "?!"] },
  { key: "angry", words: ["むかつ", "ふざけ", "ダメ", "だめ", "怒"] },
  { key: "sad", words: ["ごめん", "残念", "悲し", "つらい", "寂し"] },
  { key: "shy", words: ["はずかし", "恥ずかし", "照れ"] },
  { key: "happy", words: ["ありがとう", "うれし", "嬉し", "楽しい", "やった", "すごい", "いいね"] },
  { key: "thinking", words: ["どうしよ", "たぶん", "かな", "考え"] },
];

export interface EmotionExtraction {
  /** タグを除去した読み上げ用テキスト */
  text: string;
  /** 解決済みのモデル表情名（無ければ null） */
  expression: string | null;
}

/**
 * 応答文から感情タグを取り除き、モデルの表情名へ解決する。
 *
 * - `[喜]`（日本語キー）と `[happy]`（英語キー）の両方を受ける
 * - タグが無い場合は `options.heuristic` のときだけ語彙から推定する
 * - 未知のタグは落とすが表情は変えない
 */
export function extractEmotion(
  text: string,
  expressions: Record<string, string>,
  options: { heuristic?: boolean } = {}
): EmotionExtraction {
  let key: EmotionKey | null = null;
  const stripped = text.replace(TAG_PATTERN, (_match, raw: string) => {
    const resolved = resolveKey(raw);
    if (resolved) {
      key = resolved;
    }
    return "";
  });

  if (!key && options.heuristic) {
    key = inferEmotion(stripped);
  }

  const expression = key ? expressions[key] || null : null;
  return { text: stripped.replace(/\s{2,}/g, " ").trim(), expression };
}

/** タグの中身（日本語 or 英語キー）を意味キーへ */
export function resolveKey(raw: string): EmotionKey | null {
  const trimmed = raw.trim();
  if (trimmed in EMOTION_TAGS) {
    return EMOTION_TAGS[trimmed];
  }
  return isEmotionKey(trimmed) ? trimmed : null;
}

/** 文から感情を推定する（見つからなければ null） */
export function inferEmotion(text: string): EmotionKey | null {
  for (const rule of HEURISTICS) {
    if (rule.words.some((word) => text.includes(word))) {
      return rule.key;
    }
  }
  return null;
}

function isEmotionKey(value: string): value is EmotionKey {
  return ["happy", "angry", "sad", "surprised", "shy", "thinking"].includes(value);
}
```

- [ ] **Step 4: テストを通す**

Run: `npx tsc -p tsconfig.test.json; node --test --test-timeout=30000 "dist-test/tests/emotion.test.js"`
Expected: PASS（6 件）

- [ ] **Step 5: コミット**

```bash
git add src/shared/avatar/emotion.ts tests/emotion.test.ts
git commit -m "feat(avatar): 感情タグの抽出・表情解決・語彙推定を追加"
```

---

### Task 2: プロンプトに感情タグの語彙を入れる

**Files:**
- Modify: `src/backend/conversation/PromptBuilder.ts`
- Test: `tests/prompt-builder-avatar.test.ts`（新規）

- [ ] **Step 1: 失敗するテストを書く**

`tests/prompt-builder-avatar.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { PromptBuilder } from "../src/backend/conversation/PromptBuilder";
import { createTempProject } from "./helpers/project";

function build(emotionTags: boolean): string {
  const project = createTempProject({ patch: { avatar: { emotion_tags_enabled: emotionTags } } });
  try {
    return new PromptBuilder({
      config: project.config,
      character: {
        get: () => ({ name: "さくら", label: "さくら", personality: "明るい", responseRules: "- 簡潔に", catchphrases: [] }),
      },
    }).build();
  } finally {
    project.cleanup();
  }
}

test("感情タグの語彙を入れる（有効時）", () => {
  const prompt = build(true);
  assert.ok(prompt.includes("[喜]"));
  assert.ok(prompt.includes("感情表現"));
});

test("無効時は語彙を入れない", () => {
  const prompt = build(false);
  assert.ok(!prompt.includes("[喜]"));
  assert.ok(!prompt.includes("感情表現"));
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（プロンプトに `[喜]` が無い）

- [ ] **Step 3: 実装する**

`PromptBuilder.build()` の `if (character.catchphrases.length > 0) {...}` の後、`lines.push(LANGUAGE_RULE_SHORT);` の前に:

```ts
    const avatar = this.deps.config.getAvatar();
    if (avatar.emotion_tags_enabled) {
      lines.push(
        "",
        "感情表現:",
        "文中に [喜] [怒] [哀] [驚] [照] [考] のいずれかを、文の区切りに 1 つだけ置くこと。",
        "例: 「おはよう！[喜] 今日もいい天気だね。」",
        "使えるのはこの 6 つだけ。文中の単語として書かないこと。"
      );
    }
```

- [ ] **Step 4: テストを通す**

Run: `npm test`
Expected: PASS（`prompt-builder-avatar` 2 件）

- [ ] **Step 5: コミット**

```bash
git add src/backend/conversation/PromptBuilder.ts tests/prompt-builder-avatar.test.ts
git commit -m "feat(prompt): 感情タグの語彙をプロンプトに追加（無効化可能）"
```

---

### Task 3: 表情を端から端まで通す

**Files:**
- Modify: `src/backend/core/ports.ts`（`PlaybackMeta.expression?`）
- Modify: `src/backend/conversation/SpeechQueue.ts`（`enqueue(text, expression?)`）
- Modify: `src/backend/conversation/TurnRunner.ts`（タグ除去と表情の決定）
- Modify: `src/backend/server/WsPlaybackSink.ts`（`tts_audio.expression`）
- Modify: `src/shared/protocol.ts`（`tts_audio.expression?`）
- Modify: `src/frontend/app.ts`（表情の適用・解除）
- Test: `tests/ws-playback-sink.test.ts` / `tests/turn-runner-streaming.test.ts` に追記

- [ ] **Step 1: 失敗するテストを追記する**

`tests/ws-playback-sink.test.ts` の `meta` に `expression: "exp_01"` を足し、`tts_audio` を取り出すテストに:

```ts
  const event = message.event as { expression?: string };
  assert.equal(event.expression, "exp_01");
```

`tests/turn-runner-streaming.test.ts` に:

```ts
test("感情タグは読み上げから除かれる", async () => {
  const ctx = setup({ replies: ["おはよう！[喜] いい天気だね。"] });
  try {
    await ctx.runner.run("やあ", ctx.hooks, new AbortController().signal);
    // 文分割は「！」で切れるため 2 文になる。どちらにもタグは残らない
    assert.deepEqual(ctx.synthCalls, ["おはよう！", "いい天気だね。"]);
    assert.ok(ctx.synthCalls.every((text) => !text.includes("[")));
  } finally {
    ctx.project.cleanup();
  }
});
```

（`setup()` の `played` は既存のまま。表情は `PlaybackMeta.expression` で確認するため、上のテストでは `DEFAULT_CONFIG.avatar.expressions` が空でも「タグが消える」ことを検証する）

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（タグが残る / `expression` が無い）

- [ ] **Step 3: 実装する**

`ports.ts` の `PlaybackMeta` に:

```ts
  /** この文で発火する表情（モデルの表情名。無ければ undefined） */
  expression?: string;
```

`SpeechQueue.ts`:

```ts
interface Item {
  text: string;
  expression?: string;
  promise?: Promise<Buffer | null>;
}
```

`enqueue(text: string, expression?: string): void` に変え、`this.items.push({ text: trimmed, expression });`。
`meta()` の戻り値に `expression: item` を渡せるよう `this.meta(wav, item.text, item.expression)` とし:

```ts
  private meta(wav: Buffer, text: string, expression?: string): PlaybackMeta {
    return {
      utteranceId: randomUUID(),
      text,
      expression,
      volumes: buildVolumeEnvelope(wav),
      sliceMs: 20,
      durationMs: wavDurationMs(wav, this.deps.sampleRate),
    };
  }
```

`TurnRunner.ts` の import に `import { extractEmotion } from "../../shared/avatar/emotion";` を足し、`runStreaming()` の冒頭で:

```ts
    const avatarConfig = this.deps.config.getAvatar();
```

`enqueue` を:

```ts
    const enqueue = (raw: string): void => {
      const { text, expression } = extractEmotion(raw, avatarConfig.expressions, {
        heuristic: avatarConfig.emotion_heuristic_enabled,
      });
      if (!text || !queue) {
        return;
      }
      if (containsHangul(text)) {
        // …既存の言語ガード…
      }
      if (!announced) {
        // …既存のまま…
      }
      queue.enqueue(text, expression);
    };
```

`WsPlaybackSink.ts` の `tts_audio` に `expression: meta.expression,` を足す。

`protocol.ts` の `tts_audio` に:

```ts
      /** 発火する表情（モデルの表情名） */
      expression?: string;
```

`app.ts` の `case "tts_audio":` を:

```ts
      case "tts_audio":
        this.stage.setExpression(event.expression ?? null);
        this.audioPlayer?.enqueue(event);
        break;
```

`case "speaking_finished":` に:

```ts
        this.stage.setExpression(null);
```

- [ ] **Step 4: テストを通す**

Run: `npm run verify`
Expected: すべて PASS

- [ ] **Step 5: コミット**

```bash
git add src/backend/core/ports.ts src/backend/conversation/SpeechQueue.ts src/backend/conversation/TurnRunner.ts src/backend/server/WsPlaybackSink.ts src/shared/protocol.ts src/frontend/app.ts tests/ws-playback-sink.test.ts tests/turn-runner-streaming.test.ts
git commit -m "feat(avatar): 感情タグを読み上げから除き、表情として画面へ渡す"
```

---

### Task 4: ドキュメントと最終検証

- [ ] **Step 1: ドキュメント更新**

`README.md` の VTuber モード節に:

```markdown
- 感情: LLM に `[喜]` `[怒]` `[哀]` `[驚]` `[照]` `[考]` を出させ、読み上げからは除去して表情だけに使う。
  タグが無い文は語彙から推定する（`avatar.emotion_tags_enabled` / `emotion_heuristic_enabled`）
```

`AGENTS.md` の 12 章に:

```markdown
12-13. **感情タグは TTS の前に必ず除去する**（`shared/avatar/emotion.ts` の `extractEmotion`）。
    タグ→表情名の対応は `avatar.expressions`（空文字は「変えない」）。タグが無ければ
    `emotion_heuristic_enabled` のときだけ語彙推定する。表情は `tts_audio.expression` で画面へ渡す。
```

`docs/REDESIGN.md` に「13.6 感情タグと表情（P5）」を追記。

- [ ] **Step 2: 最終検証**

Run: `npm run verify`
Expected: typecheck ✅ / テスト ✅ / build ✅

- [ ] **Step 3: コミット**

```bash
git add README.md AGENTS.md docs/REDESIGN.md
git commit -m "docs: 感情タグと表情の使い方を追記"
```

---

## 計画のセルフレビュー（実施済み）

| 仕様（設計書 §7） | タスク |
|---|---|
| 7.1 タグ方式（語彙・除去・写像） | Task 1 / 2 / 3 |
| 7.2 ヒューリスティック（タグが無いとき） | Task 1 |
| 7.2 優先順位（タグ > 推定 > 変化なし） | Task 1（`extractEmotion`） |
| 7.3 モーション | 対象外（P5b） |
| 7.1 VOICEVOX スタイル切替 | 対象外（P5b） |

- タグは `[喜]`（日本語）と `[happy]`（英語）の両対応。未知タグは落とすが表情は変えない。
- 読み上げテキストは常にタグ除去後（TTS に `[` が渡らない）。

---

## 実行結果（2026-11-15 / `develop`）

| タスク | コミット | 結果 |
|---|---|---|
| 1 感情の抽出・推定 | `36fe2d5` | ✅ 6 件 |
| 2 プロンプト語彙 | `4e70b61` | ✅ 2 件 |
| 3 表情の配線 | `6e0736a` | ✅ 200 件（`ws-playback-sink` / `turn-runner-streaming` に追記） |
| 4 ドキュメント | （このコミット） | ✅ `npm run verify` 200 件 pass / build OK |

**計画から変えた点**

1. 感情タグは**文単位**で除去するため、`おはよう！[喜] …` は `！` で 2 文に割れ、タグは 2 文目に付く。
   テストは「どの文にも `[` が残らない」ことで検証する（1 文に収めるにはタグを句点の前に置く）。
2. `extractEmotion` は `null` を返すので、`SpeechQueue.enqueue` へは `expression ?? undefined` で渡す。
3. `StageView.setExpression()`（`AvatarStage` への委譲）を追加（計画の Interfaces に漏れていた）。




