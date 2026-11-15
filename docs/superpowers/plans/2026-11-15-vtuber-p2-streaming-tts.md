# VTuber 化 P2（文単位ストリーミング TTS）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM の応答を文単位に区切り、**1 文目が確定した時点で** TTS と再生を始める（全文合成を待たない）。

**Architecture:** `shared/text/sentenceSplitter.ts`（純粋）で差分を文へ切り、`conversation/SpeechQueue.ts` が「1 文先読み + 直列再生 + 中断」を担う。`TurnRunner` はストリーミングの差分を splitter に流し、キューへ積む。発話イベント（`speaking_started` / `speaking_finished`）はターン単位で 1 回だけ出す。

**Tech Stack:** TypeScript 5（strict）/ `node:test` / VOICEVOX / esbuild

## Global Constraints

- `develop` ブランチ。コミットは日本語で「何を・なぜ」。作業後に `npm run verify`。
- 純粋ロジックは `src/shared`。I/O と分離して `node:test` でテストする。
- フロントは esbuild の IIFE バンドルのみ。
- `tts.split_sentences = false` で**従来動作（全文を 1 回 TTS）**に戻せること（後方互換）。
- 破棄・中断のときは必ず待機を解く（`AGENTS.md` 16 と同じ理由で画面が固まる）。
- 実測環境: RTX 3060 12GB / i7-6700 / Node 24.11 / VOICEVOX `speaker_id=2`。

## スコープ

P2 のみ（設計書 §5）。感情タグの抽出は P5、口パクは P3。

---

## ファイル構成

| パス | 役割 |
|---|---|
| `src/shared/text/sentenceSplitter.ts`（新規） | 差分 → 確定した文（純粋） |
| `src/backend/conversation/SpeechQueue.ts`（新規） | 合成の先読み・直列再生・中断 |
| `src/backend/conversation/TurnRunner.ts`（変更） | ストリーミング + キュー + 言語ガード |
| `src/backend/conversation/PlaybackLoop.ts`（変更） | 発話イベントの抑止オプション |
| `src/backend/conversation/ConversationPipeline.ts`（変更） | `speaking_started` / `speaking_finished` をターン単位へ |
| `src/shared/protocol.ts`（変更） | `speech_reset` イベント |
| `src/frontend/app.ts`（変更） | `speech_reset` の表示 |
| `tests/sentence-splitter.test.ts` / `tests/speech-queue.test.ts` / `tests/turn-runner-streaming.test.ts`（新規） | 回帰 |

---

### Task 1: `SentenceSplitter`（差分 → 文）

**Files:**
- Create: `src/shared/text/sentenceSplitter.ts`
- Test: `tests/sentence-splitter.test.ts`（新規）

**Interfaces:**
- Produces: `new SentenceSplitter({ minChars, maxChars })` / `push(delta: string): string[]` / `flush(): string[]`

- [ ] **Step 1: 失敗するテストを書く**

`tests/sentence-splitter.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { SentenceSplitter } from "../src/shared/text/sentenceSplitter";

const options = { minChars: 4, maxChars: 40 };

test("句点で文を切り出す", () => {
  const splitter = new SentenceSplitter(options);
  assert.deepEqual(splitter.push("こんにちは。元気"), ["こんにちは。"]);
  assert.deepEqual(splitter.push("ですか？"), ["元気ですか？"]);
});

test("最小文字数未満は次の文と結合する", () => {
  const splitter = new SentenceSplitter(options);
  assert.deepEqual(splitter.push("はい。"), []);
  assert.deepEqual(splitter.push("そうですね。"), ["はい。そうですね。"]);
});

test("最大文字数を超えたら読点で切る", () => {
  const splitter = new SentenceSplitter(options);
  const text = `${"あ".repeat(30)}、${"い".repeat(30)}`;
  const pieces = splitter.push(text);
  assert.equal(pieces.length, 1);
  assert.ok(pieces[0].endsWith("、"));
  assert.equal(pieces[0].length, 31);
});

test("flush は残りを 1 文として返す", () => {
  const splitter = new SentenceSplitter(options);
  splitter.push("まだ途中の文");
  assert.deepEqual(splitter.flush(), ["まだ途中の文"]);
  assert.deepEqual(splitter.flush(), []);
});

test("チャンク境界が文の途中でも壊れない", () => {
  const splitter = new SentenceSplitter(options);
  const pieces = [
    ...splitter.push("今日は"),
    ...splitter.push("いい天気"),
    ...splitter.push("ですね。"),
  ];
  assert.deepEqual(pieces, ["今日はいい天気ですね。"]);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`sentenceSplitter` が見つからない）

- [ ] **Step 3: 実装する**

`src/shared/text/sentenceSplitter.ts`:

```ts
/** 文末とみなす文字（連続する「…」「!?」も 1 つの区切りとして扱う） */
const END_CHARS = new Set(["。", "．", ".", "！", "!", "？", "?", "…", "\n"]);

/** 長すぎるときに使う区切り（読点） */
const COMMA_CHARS = new Set(["、", "，", ","]);

export interface SentenceSplitterOptions {
  /** これ未満の文は次と結合する */
  minChars: number;
  /** これ超の文は読点でも分割する */
  maxChars: number;
}

/**
 * LLM のストリーミング差分を「確定した文」へ切り出す。
 *
 * 文末の直後で切り、`minChars` 未満は次の文と結合する。句点が来ないまま
 * `maxChars` を超えたら読点で切る（読点も無ければ `maxChars` で切る）。
 * 感情タグの抽出は P5 で足す（P2 ではタグを送らない）。
 */
export class SentenceSplitter {
  private buffer = "";

  constructor(private readonly options: SentenceSplitterOptions) {}

  /** 差分を食わせ、確定した文だけを返す（未確定は内部バッファに残る） */
  push(delta: string): string[] {
    this.buffer += delta;
    const pieces: string[] = [];

    let searchFrom = 0;
    for (;;) {
      const cut = this.findCut(searchFrom);
      if (cut <= 0) {
        break;
      }
      const piece = this.buffer.slice(0, cut).trim();

      if (piece.length < this.options.minChars) {
        // 短すぎる文は次と結合する（次の区切りまで伸ばす）
        searchFrom = cut;
        continue;
      }

      this.buffer = this.buffer.slice(cut);
      if (piece) {
        pieces.push(piece);
      }
      searchFrom = 0;
    }

    return pieces;
  }

  /** ストリーム終端で残りを吐く */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }

  private findCut(from: number): number {
    for (let i = from; i < this.buffer.length; i += 1) {
      const char = this.buffer[i];
      if (!END_CHARS.has(char)) {
        continue;
      }
      // 「……」「!?」のような連続をまとめる
      let end = i + 1;
      while (end < this.buffer.length && END_CHARS.has(this.buffer[end])) {
        end += 1;
      }
      return end;
    }

    if (this.buffer.length <= this.options.maxChars) {
      return 0;
    }

    // 長すぎる: maxChars 以内の最後の読点で切る
    let lastComma = -1;
    for (let i = 0; i < Math.min(this.buffer.length, this.options.maxChars); i += 1) {
      if (COMMA_CHARS.has(this.buffer[i])) {
        lastComma = i + 1;
      }
    }
    return lastComma > 0 ? lastComma : this.options.maxChars;
  }
}
```

- [ ] **Step 4: テストを通す**

Run: `npx tsc -p tsconfig.test.json; node --test --test-timeout=30000 "dist-test/tests/sentence-splitter.test.js"`
Expected: PASS（5 件）

- [ ] **Step 5: コミット**

```bash
git add src/shared/text/sentenceSplitter.ts tests/sentence-splitter.test.ts
git commit -m "feat(text): ストリーミング差分を文単位に区切る SentenceSplitter を追加"
```

---

### Task 2: `SpeechQueue`（先読み・直列再生・中断）

**Files:**
- Create: `src/backend/conversation/SpeechQueue.ts`
- Test: `tests/speech-queue.test.ts`（新規）

**Interfaces:**
- Consumes: `TextToSpeech` / `PlaybackMeta`（既存）、`buildVolumeEnvelope`、`wavDurationMs`
- Produces: `new SpeechQueue({ tts, logger, signal, sampleRate, prefetchDepth, play, onSentence? })` / `enqueue(text: string): void` / `drain(): Promise<{ played: number; failed: number; bargeWav?: Buffer }>` / `stop(): void`

- [ ] **Step 1: 失敗するテストを書く**

`tests/speech-queue.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { SpeechQueue } from "../src/backend/conversation/SpeechQueue";
import { Logger } from "../src/backend/core/logger";
import type { PlaybackMeta, TextToSpeech } from "../src/backend/core/ports";
import { encodeWav } from "../src/backend/services/wav";

Logger.configure({ level: "error" });

const wav = encodeWav(Buffer.alloc(4800, 1), 24000);

function makeTts(calls: string[], onSynth?: (text: string) => Promise<Buffer>): TextToSpeech {
  return {
    isAvailable: async () => true,
    listSpeakers: async () => [],
    synthesize: async (text: string) => {
      calls.push(text);
      if (onSynth) {
        return onSynth(text);
      }
      if (text.includes("NG")) {
        throw new Error("tts failed");
      }
      return wav;
    },
  };
}

function makeQueue(options: {
  tts: TextToSpeech;
  played?: string[];
  playImpl?: (wav: Buffer, meta: PlaybackMeta) => Promise<Buffer | undefined>;
}) {
  const played = options.played ?? [];
  return new SpeechQueue({
    tts: options.tts,
    logger: new Logger("Test"),
    signal: new AbortController().signal,
    sampleRate: 24000,
    prefetchDepth: 1,
    play:
      options.playImpl ??
      (async (_wav, meta) => {
        played.push(meta.text);
        return undefined;
      }),
  });
}

test("文を順番に再生する", async () => {
  const calls: string[] = [];
  const played: string[] = [];
  const queue = makeQueue({ tts: makeTts(calls), played });
  queue.enqueue("一つ目です。");
  queue.enqueue("二つ目です。");
  const result = await queue.drain();
  assert.deepEqual(played, ["一つ目です。", "二つ目です。"]);
  assert.equal(result.played, 2);
  assert.equal(result.failed, 0);
});

test("1 文失敗しても残りは再生する", async () => {
  const calls: string[] = [];
  const played: string[] = [];
  const queue = makeQueue({ tts: makeTts(calls), played });
  queue.enqueue("NG です。");
  queue.enqueue("OK です。");
  const result = await queue.drain();
  assert.deepEqual(played, ["OK です。"]);
  assert.equal(result.failed, 1);
});

test("再生中に次の文を先読みする", async () => {
  const calls: string[] = [];
  const played: string[] = [];
  let release!: () => void;
  const queue = makeQueue({
    tts: makeTts(calls),
    played,
    playImpl: async (_wav, meta) => {
      played.push(meta.text);
      if (meta.text.startsWith("A")) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return undefined;
    },
  });
  queue.enqueue("A です。");
  queue.enqueue("B です。");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(calls.includes("B です。"), "B が先読みされている");
  release();
  await queue.drain();
});

test("stop したら残りを再生しない", async () => {
  const calls: string[] = [];
  const played: string[] = [];
  const queue = makeQueue({ tts: makeTts(calls), played });
  queue.enqueue("一つ目です。");
  queue.enqueue("二つ目です。");
  queue.stop();
  const result = await queue.drain();
  assert.deepEqual(played, []);
  assert.equal(result.played, 0);
});

test("バージインがあれば止めて WAV を返す", async () => {
  const calls: string[] = [];
  const played: string[] = [];
  const barge = Buffer.from([1, 2, 3]);
  const queue = makeQueue({
    tts: makeTts(calls),
    played,
    playImpl: async (_wav, meta) => {
      played.push(meta.text);
      return barge;
    },
  });
  queue.enqueue("一つ目です。");
  queue.enqueue("二つ目です。");
  const result = await queue.drain();
  assert.deepEqual(played, ["一つ目です。"]);
  assert.equal(result.played, 1);
  assert.equal(result.bargeWav, barge);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`SpeechQueue` が見つからない）

- [ ] **Step 3: 実装する**

`src/backend/conversation/SpeechQueue.ts`:

```ts
import { randomUUID } from "node:crypto";
import { buildVolumeEnvelope } from "../../shared/audio/envelope";
import { Logger } from "../core/logger";
import type { PlaybackMeta, TextToSpeech } from "../core/ports";
import { wavDurationMs } from "../services/wav";

export interface SpeechQueueDeps {
  tts: TextToSpeech;
  logger: Logger;
  signal: AbortSignal;
  /** WAV にヘッダが無い場合のサンプリングレート */
  sampleRate: number;
  /** 先読みする文数（1 推奨） */
  prefetchDepth: number;
  /** 1 文を鳴らす。バージイン発話があれば WAV を返す */
  play(wav: Buffer, meta: PlaybackMeta): Promise<Buffer | undefined>;
  /** 合成を始めた文（ログ・表示用） */
  onSentence?(text: string): void;
}

export interface SpeechQueueResult {
  played: number;
  failed: number;
  bargeWav?: Buffer;
}

interface Item {
  text: string;
  promise?: Promise<Buffer | null>;
}

/**
 * 文単位の音声合成と再生。
 *
 * - `enqueue` された順に 1 文ずつ再生する（順序保証）
 * - 再生中に次の 1 文を先読みして、文の間で止まらないようにする
 * - 1 文の合成失敗は警告して残りを続ける
 * - `stop()` / `AbortSignal` で即座に止め、`drain()` は必ず解決する
 */
export class SpeechQueue {
  private readonly items: Item[] = [];
  private running = false;
  private stopped = false;
  private played = 0;
  private failed = 0;
  private bargeWav: Buffer | undefined;
  private readonly idleWaiters: (() => void)[] = [];

  constructor(private readonly deps: SpeechQueueDeps) {}

  enqueue(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.stopped || this.deps.signal.aborted) {
      return;
    }
    this.items.push({ text: trimmed });
    void this.run();
  }

  /** すべて再生し終わるまで待つ（中断・失敗でも必ず解決する） */
  async drain(): Promise<SpeechQueueResult> {
    if (!this.running && this.items.length === 0) {
      return this.result();
    }
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    return this.result();
  }

  stop(): void {
    this.stopped = true;
    this.items.length = 0;
    this.notifyIdle();
  }

  private result(): SpeechQueueResult {
    return { played: this.played, failed: this.failed, bargeWav: this.bargeWav };
  }

  private notifyIdle(): void {
    if (this.running) {
      return;
    }
    for (const resolve of this.idleWaiters.splice(0)) {
      resolve();
    }
  }

  private async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (!this.stopped && !this.deps.signal.aborted && this.items.length > 0) {
        const item = this.items[0];
        const wav = await this.synthesize(item);
        if (this.stopped || this.deps.signal.aborted) {
          return;
        }
        if (!wav) {
          this.items.shift();
          this.failed += 1;
          continue;
        }

        // 再生を待つ間に次の文を合成しておく
        for (let i = 1; i <= this.deps.prefetchDepth && i < this.items.length; i += 1) {
          void this.synthesize(this.items[i]);
        }

        this.items.shift();
        const barge = await this.deps.play(wav, this.meta(wav, item.text));
        if (this.stopped) {
          return;
        }
        this.played += 1;
        if (barge) {
          this.bargeWav = barge;
          this.stopped = true;
          return;
        }
      }
    } finally {
      this.running = false;
      if (!this.stopped && this.items.length > 0) {
        void this.run();
      }
      this.notifyIdle();
    }
  }

  private synthesize(item: Item): Promise<Buffer | null> {
    if (!item.promise) {
      this.deps.onSentence?.(item.text);
      item.promise = this.deps.tts.synthesize(item.text, { signal: this.deps.signal }).catch((error) => {
        this.deps.logger.warn(`文の音声合成に失敗しました: ${item.text}`, error);
        return null;
      });
    }
    return item.promise;
  }

  private meta(wav: Buffer, text: string): PlaybackMeta {
    return {
      utteranceId: randomUUID(),
      text,
      volumes: buildVolumeEnvelope(wav),
      sliceMs: 20,
      durationMs: wavDurationMs(wav, this.deps.sampleRate),
    };
  }
}
```

- [ ] **Step 4: テストを通す**

Run: `npx tsc -p tsconfig.test.json; node --test --test-timeout=30000 "dist-test/tests/speech-queue.test.js"`
Expected: PASS（5 件）

- [ ] **Step 5: コミット**

```bash
git add src/backend/conversation/SpeechQueue.ts tests/speech-queue.test.ts
git commit -m "feat(audio): 文単位の合成を先読みして直列再生する SpeechQueue を追加"
```

---

### Task 3: 発話イベントをターン単位にし、`speech_reset` を足す

**Files:**
- Modify: `src/shared/protocol.ts`（`PipelineEvent` に `speech_reset`）
- Modify: `src/backend/conversation/PlaybackLoop.ts`（`announce` オプション）
- Modify: `src/backend/conversation/ConversationPipeline.ts`（`play` の引数追加・`stopPlayback`）
- Modify: `src/backend/conversation/TurnRunner.ts`（`TurnHooks` の型のみ）

**Interfaces:**
- Produces: `TurnHooks.play(wav, meta, options?: { announce?: boolean })` / `TurnHooks.stopPlayback(): void` / `PipelineEvent` の `{ type: "speech_reset" }`

- [ ] **Step 1: プロトコルと型を足す**

`PipelineEvent` の `tts_audio` の後に:

```ts
  /** 言語ガードで読み直す（画面は「日本語で生成し直しています」を出す） */
  | { type: "speech_reset" }
```

`TurnRunner.ts` の `TurnHooks` を:

```ts
  /** 読み上げ（バージイン監視込み）。次のターンの発話 WAV を返す */
  play(wav: Buffer, meta: PlaybackMeta, options?: { announce?: boolean }): Promise<Buffer | undefined>;
  /** 進行中の再生だけを止める（ターンは続ける） */
  stopPlayback(): void;
```

- [ ] **Step 2: `PlaybackLoop` に `announce` を足す**

`play` のシグネチャを:

```ts
  async play(
    wav: Buffer,
    meta: PlaybackMeta,
    hooks: PlaybackHooks,
    options: { announce?: boolean } = {}
  ): Promise<Buffer | undefined> {
```

`hooks.emit({ type: "speaking_started" });` を:

```ts
    if (options.announce !== false) {
      hooks.emit({ type: "speaking_started" });
    }
```

`hooks.emit({ type: "speaking_finished" });`（2 か所）を:

```ts
      if (options.announce !== false) {
        hooks.emit({ type: "speaking_finished" });
      }
```

- [ ] **Step 3: `ConversationPipeline` を追随させる**

`respond()` の hooks を:

```ts
      play: (wav, meta, options) => this.playWithBargeIn(wav, meta, options),
      stopPlayback: () => {
        this.playback?.stop();
      },
```

`playWithBargeIn` を:

```ts
  private playWithBargeIn(
    wav: Buffer,
    meta: PlaybackMeta,
    options?: { announce?: boolean }
  ): Promise<Buffer | undefined> {
    return this.playbackLoop.play(wav, meta, {
```

に変え、`playbackLoop.play(...)` の閉じ括弧を `}, options);` にする。

- [ ] **Step 4: 型と既存テストを通す**

Run: `npm run typecheck`
Expected: エラーなし（`TurnRunner` は `options` を省略して呼ぶので互換）

Run: `npm test`
Expected: PASS（既存 168 件）

- [ ] **Step 5: コミット**

```bash
git add src/shared/protocol.ts src/backend/conversation/PlaybackLoop.ts src/backend/conversation/ConversationPipeline.ts src/backend/conversation/TurnRunner.ts
git commit -m "feat(conversation): 発話イベントをターン単位に抑止できるようにし、speech_reset を追加"
```

---

### Task 4: `TurnRunner` を文単位ストリーミングへ

**Files:**
- Modify: `src/backend/conversation/TurnRunner.ts`
- Test: `tests/turn-runner-streaming.test.ts`（新規）

**Interfaces:**
- Consumes: `SentenceSplitter`（Task 1）/ `SpeechQueue`（Task 2）/ `TurnHooks.play(..., { announce })`（Task 3）
- Produces: `tts.split_sentences = true` で文単位、`false` で従来動作

- [ ] **Step 1: 失敗するテストを書く**

`tests/turn-runner-streaming.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { ConversationHistory } from "../src/backend/conversation/ConversationHistory";
import { PromptBuilder } from "../src/backend/conversation/PromptBuilder";
import { TurnHooks, TurnRunner } from "../src/backend/conversation/TurnRunner";
import { Logger } from "../src/backend/core/logger";
import type { LanguageModel, TextToSpeech } from "../src/backend/core/ports";
import type { PipelineEvent } from "../src/shared/protocol";
import { encodeWav } from "../src/backend/services/wav";
import { createTempProject } from "./helpers/project";

Logger.configure({ level: "error" });

const wav = encodeWav(Buffer.alloc(4800, 1), 24000);

function setup(options: { replies: string[]; split?: boolean }) {
  const project = createTempProject({
    patch: {
      tts: { split_sentences: options.split ?? true, min_sentence_chars: 4, max_sentence_chars: 60 },
    },
  });
  const synthCalls: string[] = [];
  const played: string[] = [];
  const events: PipelineEvent[] = [];
  let call = 0;
  const llm: LanguageModel = {
    isAvailable: async () => true,
    listModels: async () => [],
    chatStream: async (_messages, onDelta) => {
      const reply = options.replies[Math.min(call, options.replies.length - 1)];
      call += 1;
      for (const char of reply) {
        onDelta(char);
      }
      return reply;
    },
  };
  const tts: TextToSpeech = {
    isAvailable: async () => true,
    listSpeakers: async () => [],
    synthesize: async (text: string) => {
      synthCalls.push(text);
      return wav;
    },
  };
  const runner = new TurnRunner({
    config: project.config,
    history: new ConversationHistory(6),
    promptBuilder: new PromptBuilder({
      config: project.config,
      character: {
        get: () => ({ name: "t", label: "t", personality: "", responseRules: "", catchphrases: [] }),
      },
    }),
    llm,
    tts,
    logger: new Logger("Test"),
  });
  const hooks: TurnHooks = {
    setState: () => undefined,
    emit: (event) => events.push(event),
    onError: () => undefined,
    onHistoryChanged: () => undefined,
    onReply: () => undefined,
    play: async (_wav, meta) => {
      played.push(meta.text);
      return undefined;
    },
    stopPlayback: () => undefined,
  };
  return { project, runner, hooks, synthCalls, played, events };
}

test("文ごとに合成して順番に再生する", async () => {
  const ctx = setup({ replies: ["おはよう。今日は晴れです。"] });
  try {
    await ctx.runner.run("やあ", ctx.hooks, new AbortController().signal);
    assert.deepEqual(ctx.synthCalls, ["おはよう。", "今日は晴れです。"]);
    assert.deepEqual(ctx.played, ["おはよう。", "今日は晴れです。"]);
    assert.equal(ctx.events.filter((e) => e.type === "speaking_started").length, 1);
    assert.equal(ctx.events.filter((e) => e.type === "speaking_finished").length, 1);
  } finally {
    ctx.project.cleanup();
  }
});

test("split_sentences=false なら全文を 1 回だけ合成する", async () => {
  const ctx = setup({ replies: ["おはよう。今日は晴れです。"], split: false });
  try {
    await ctx.runner.run("やあ", ctx.hooks, new AbortController().signal);
    assert.deepEqual(ctx.synthCalls, ["おはよう。今日は晴れです。"]);
  } finally {
    ctx.project.cleanup();
  }
});

test("ハングルを検出したら読み直す（speech_reset）", async () => {
  const ctx = setup({ replies: ["안녕하세요。", "こんにちは。元気です。"] });
  try {
    await ctx.runner.run("やあ", ctx.hooks, new AbortController().signal);
    assert.equal(ctx.events.filter((e) => e.type === "speech_reset").length, 1);
    assert.ok(!ctx.synthCalls.some((text) => text.includes("안녕")));
    assert.ok(ctx.synthCalls.includes("こんにちは。"));
  } finally {
    ctx.project.cleanup();
  }
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`speech_reset` が出ない / 合成が 1 回）

- [ ] **Step 3: 実装する（`TurnRunner.run` を置き換え）**

import に:

```ts
import { SentenceSplitter } from "../../shared/text/sentenceSplitter";
import { SpeechQueue } from "./SpeechQueue";
```

`run()` の全体を次に置き換える（`buildMessages` は現状維持）:

```ts
  async run(userText: string, hooks: TurnHooks, signal: AbortSignal): Promise<Buffer | undefined> {
    this.deps.history.add("user", userText);
    hooks.onHistoryChanged();

    hooks.setState("thinking");
    hooks.emit({ type: "llm_started" });
    const llmStartedAt = Date.now();

    const ttsConfig = this.deps.config.getTTS();
    const audio = this.deps.config.getAudio();
    const splitter = ttsConfig.split_sentences
      ? new SentenceSplitter({ minChars: ttsConfig.min_sentence_chars, maxChars: ttsConfig.max_sentence_chars })
      : null;

    let announced = false;
    let resetRequested = false;
    let queue: SpeechQueue | null = null;

    const createQueue = (): SpeechQueue =>
      new SpeechQueue({
        tts: this.deps.tts,
        logger: this.logger,
        signal,
        sampleRate: audio.sample_rate,
        prefetchDepth: ttsConfig.prefetch_depth,
        play: (wav, meta) => hooks.play(wav, meta, { announce: false }),
      });

    const enqueue = (text: string): void => {
      if (!queue) {
        return;
      }
      if (containsHangul(text)) {
        if (!resetRequested) {
          resetRequested = true;
          this.logger.warn("応答にハングルが混入したため読み直します");
          queue.stop();
          queue = null;
          hooks.stopPlayback();
        }
        return;
      }
      if (!announced) {
        announced = true;
        hooks.setState("speaking");
        hooks.emit({ type: "speaking_started" });
      }
      queue.enqueue(text);
    };

    if (splitter) {
      queue = createQueue();
    }

    let reply = "";
    try {
      reply = await this.deps.llm.chatStream(
        this.buildMessages(),
        (delta) => {
          hooks.emit({ type: "llm_delta", content: delta });
          if (splitter) {
            for (const piece of splitter.push(delta)) {
              enqueue(piece);
            }
          }
        },
        { signal }
      );
    } catch (error) {
      queue?.stop();
      if (signal.aborted) {
        return undefined;
      }
      hooks.onError("llm", error);
      return undefined;
    }

    reply = reply.trim();

    if (splitter) {
      for (const piece of splitter.flush()) {
        enqueue(piece);
      }
    }

    // 言語ガード: ハングルを検出したら 1 回だけ生成し直して最初から読み上げる
    if (resetRequested) {
      queue?.stop();
      queue = null;
      hooks.emit({ type: "speech_reset" });
      try {
        reply = (
          await this.deps.llm.chatStream(this.buildMessages({ languageRetry: true }), () => undefined, { signal })
        ).trim();
      } catch (error) {
        if (signal.aborted) {
          return undefined;
        }
        hooks.onError("llm", error);
        return undefined;
      }
      announced = false;
      resetRequested = false;
      const retrySplitter = new SentenceSplitter({
        minChars: ttsConfig.min_sentence_chars,
        maxChars: ttsConfig.max_sentence_chars,
      });
      queue = createQueue();
      for (const piece of [...retrySplitter.push(reply), ...retrySplitter.flush()]) {
        enqueue(piece);
      }
    }

    hooks.emit({ type: "llm_complete", text: reply, elapsedMs: Date.now() - llmStartedAt });
    if (!reply) {
      queue?.stop();
      hooks.emit({ type: "error", scope: "llm", message: "LLM の応答が空でした" });
      return undefined;
    }
    this.deps.history.add("assistant", reply);
    hooks.onReply(reply);
    hooks.onHistoryChanged();

    if (splitter) {
      hooks.emit({ type: "tts_started" });
      const started = Date.now();
      const result = await (queue as SpeechQueue | null)?.drain();
      hooks.emit({ type: "tts_complete", elapsedMs: Date.now() - started });
      if (announced) {
        hooks.emit({ type: "speaking_finished" });
      }
      if (!result || (result.played === 0 && result.failed > 0)) {
        hooks.emit({ type: "error", scope: "tts", message: "音声合成に失敗しました" });
      }
      return result?.bargeWav;
    }

    // 従来動作（全文を 1 回 TTS）
    hooks.setState("speaking");
    hooks.emit({ type: "tts_started" });
    const ttsStartedAt = Date.now();
    let wav: Buffer;
    try {
      wav = await this.deps.tts.synthesize(reply, { signal });
    } catch (error) {
      if (signal.aborted) {
        return undefined;
      }
      hooks.onError("tts", error);
      return undefined;
    }
    hooks.emit({ type: "tts_complete", elapsedMs: Date.now() - ttsStartedAt });

    const meta: PlaybackMeta = {
      utteranceId: randomUUID(),
      text: reply,
      volumes: buildVolumeEnvelope(wav),
      sliceMs: 20,
      durationMs: wavDurationMs(wav, audio.sample_rate),
    };
    return hooks.play(wav, meta);
  }
```

`tests/turn-runner-playback.test.ts` の `hooks` に `stopPlayback: () => undefined,` を足す（型エラー回避）。

- [ ] **Step 4: テストと既存回帰を通す**

Run: `npm test`
Expected: PASS（`turn-runner-streaming` 3 件 + 既存 168 件）

- [ ] **Step 5: コミット**

```bash
git add src/backend/conversation/TurnRunner.ts tests/turn-runner-streaming.test.ts tests/turn-runner-playback.test.ts
git commit -m "feat(conversation): 応答を文単位で合成・再生し、初声までの待ちを短縮する"
```

---

### Task 5: 画面の `speech_reset` とドキュメント・最終検証

**Files:**
- Modify: `src/frontend/app.ts`
- Modify: `README.md` / `docs/REDESIGN.md` / `AGENTS.md`

- [ ] **Step 1: 画面に通知を出す**

`app.ts` の `handleEvent()` の `switch` に:

```ts
      case "speech_reset":
        view.addSystemNote("日本語で生成し直しています…");
        break;
```

- [ ] **Step 2: ドキュメントを更新する**

`README.md` の VTuber モード節に:

```markdown
- 読み上げは**文単位**（`tts.split_sentences = true`）。1 文目が確定した時点で話し始める。
  文の区切りは `min_sentence_chars` / `max_sentence_chars` で調整できる（`false` で従来動作）
```

`AGENTS.md` の 12 章に:

```markdown
12-11. **読み上げは文単位（`SentenceSplitter` + `SpeechQueue`）**。`tts.split_sentences=false` で
    従来動作（全文 1 回）。`speaking_started` / `speaking_finished` は**ターン単位で 1 回**だけ出し、
    文ごとの再生は `announce: false` で `PlaybackLoop` のイベントを抑止する。
    言語ガードで読み直すときは `speech_reset` を出し、`hooks.stopPlayback()` で再生だけ止める。
```

`docs/REDESIGN.md` の 13 章に「13.4 文単位ストリーミング」を追加（`SentenceSplitter` →
`SpeechQueue`（先読み 1・直列・`drain` は必ず解決）→ `tts.split_sentences` で切替）。

- [ ] **Step 3: 最終検証**

Run: `npm run verify`
Expected: typecheck ✅ / テスト ✅ / build ✅

`git status --porcelain` が意図したファイルだけであることを確認する。

- [ ] **Step 4: コミット**

```bash
git add src/frontend/app.ts README.md docs/REDESIGN.md AGENTS.md
git commit -m "docs: 文単位ストリーミングの挙動と設定を追記"
```

---

## 計画のセルフレビュー（実施済み）

| 仕様（設計書 §5） | タスク |
|---|---|
| 5.1 文分割（`push` / `flush`、最小・最大、チャンク境界） | Task 1 |
| 5.2 `SpeechQueue`（先読み 1・直列・停止・例外継続） | Task 2 |
| 5.3 `TurnRunner`（文単位化・言語ガード・`speech_reset`） | Task 3 / 4 |
| 5.3 `speaking_started` / `speaking_finished` をターン 1 回 | Task 3 / 4 |
| 5.4 遅延（初声） | Task 5 の手動確認 |

- プレースホルダ無し。型名は `SpeechQueueResult` / `TurnHooks.play(..., options)` / `SentenceSplitterOptions` を全タスクで統一。
- **既知の割り切り**: 言語ガードで読み直すとき、既に再生中の 1 文は最後まで鳴る（`stopPlayback()` で止めるが、
  バージイン監視の録音は次ターンまで残る）。気になる場合は P5 で「文の再生開始前にタグ・言語を確定」へ寄せる。

---

## 実行結果（2026-11-15 / `develop`）

| タスク | コミット | 結果 |
|---|---|---|
| 1 `SentenceSplitter` | `3cbdc81` | ✅ 5 件（短い文を「次の区切りまで伸ばす」方式に修正） |
| 2 `SpeechQueue` | `2ec2595` | ✅ 5 件（順序・失敗継続・先読み・stop・バージイン） |
| 3 イベント抑止 + `speech_reset` | `75f774f` | ✅ 既存 178 件緑 |
| 4 `TurnRunner` 文単位化 | `f5e435d` | ✅ 3 件（文単位 / `false` で全文 / ハングル読み直し） |
| 5 画面 + ドキュメント | （このコミット） | ✅ `npm run verify` 181 件 pass / build OK |

**実装で確定した点**

- `speaking_started` / `speaking_finished` は `TurnRunner` がターン単位で出し、文ごとの再生は
  `announce: false`。既存の `pipeline` テストは無変更で緑のまま。
- `split_sentences=false` は `runWholeText()` に分岐（従来のハングル再生成も維持）。
- ハングル検出時は「キューを捨てる → `stopPlayback()` → `speech_reset` → 再生成 → 新しいキューで最初から」。








