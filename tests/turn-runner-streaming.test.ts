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

function setup(options: { replies: string[]; split?: boolean; language?: "ja" | "en" }) {
  const project = createTempProject({
    patch: {
      tts: { split_sentences: options.split ?? true, min_sentence_chars: 4, max_sentence_chars: 60 },
      conversation: { language: options.language ?? "ja" },
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

test("英語モードで日本語が混ざったら読み直す（speech_reset）", async () => {
  const ctx = setup({
    replies: ["こんにちは。Hello there.", "Hello there! How are you?"],
    language: "en",
  });
  try {
    await ctx.runner.run("Hi", ctx.hooks, new AbortController().signal);
    assert.equal(ctx.events.filter((e) => e.type === "speech_reset").length, 1, "1 回だけ再生成");
    assert.ok(
      !ctx.synthCalls.some((text) => /[\u3040-\u30FF\u4E00-\u9FFF]/.test(text)),
      "日本語の文は読み上げない"
    );
    assert.ok(
      ctx.synthCalls.some((text) => text.includes("Hello")),
      "英語で読み直す"
    );
  } finally {
    ctx.project.cleanup();
  }
});
