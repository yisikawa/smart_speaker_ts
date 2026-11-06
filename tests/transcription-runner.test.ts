import test from "node:test";
import assert from "node:assert/strict";
import type { PipelineEvent } from "../src/shared/protocol";
import { SpeechGate } from "../src/backend/conversation/SpeechGate";
import { TranscriptionRunner } from "../src/backend/conversation/TranscriptionRunner";
import { Logger } from "../src/backend/core/logger";
import { SpeechToText } from "../src/backend/core/ports";

Logger.configure({ level: "error" });

function fakeStt(handler: () => Promise<{ text: string; language: string; elapsedMs: number }>): SpeechToText {
  return {
    isAvailable: async () => true,
    transcribe: handler,
  };
}

function setup(handler: () => Promise<{ text: string; language: string; elapsedMs: number }>): {
  runner: TranscriptionRunner;
  events: PipelineEvent[];
  errors: string[];
} {
  const events: PipelineEvent[] = [];
  const errors: string[] = [];
  const runner = new TranscriptionRunner({
    stt: fakeStt(handler),
    gate: new SpeechGate(),
    logger: new Logger("Test"),
  });
  return { runner, events, errors };
}

function hooks(state: ReturnType<typeof setup>, active = true) {
  return {
    setState: () => undefined,
    emit: (event: PipelineEvent) => state.events.push(event),
    onError: (scope: string, error: unknown) => state.errors.push(`${scope}:${String(error)}`),
    isActive: () => active,
  };
}

test("TranscriptionRunner は認識結果を stt_complete として通知する", async () => {
  const state = setup(async () => ({ text: "こんにちは", language: "ja", elapsedMs: 5 }));
  const outcome = await state.runner.run(Buffer.alloc(3200), {
    signal: new AbortController().signal,
    hooks: hooks(state),
  });

  assert.deepEqual(outcome, { kind: "text", text: "こんにちは" });
  assert.ok(state.events.some((event) => event.type === "stt_complete"));
});

test("TranscriptionRunner は破棄判定を ignored として返す", async () => {
  const state = setup(async () => ({ text: "ご視聴ありがとうございました。", language: "ja", elapsedMs: 5 }));
  const outcome = await state.runner.run(Buffer.alloc(3200), {
    signal: new AbortController().signal,
    hooks: hooks(state),
  });

  assert.deepEqual(outcome, { kind: "ignored", reason: "hallucination" });
  assert.equal(state.events.some((event) => event.type === "stt_complete"), false);
});

test("TranscriptionRunner は空の認識結果でエラーを通知する", async () => {
  const state = setup(async () => ({ text: "   ", language: "ja", elapsedMs: 5 }));
  const outcome = await state.runner.run(Buffer.alloc(3200), {
    signal: new AbortController().signal,
    hooks: hooks(state),
  });

  assert.deepEqual(outcome, { kind: "empty" });
  const error = state.events.find(
    (event): event is Extract<PipelineEvent, { type: "error" }> => event.type === "error"
  );
  assert.equal(error?.scope, "stt");
});

test("TranscriptionRunner は STT の失敗を onError に渡す（中断は無言）", async () => {
  const state = setup(async () => {
    throw new Error("STT が失敗しました");
  });
  const outcome = await state.runner.run(Buffer.alloc(3200), {
    signal: new AbortController().signal,
    hooks: hooks(state),
  });
  assert.deepEqual(outcome, { kind: "empty" });
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0], /STT が失敗しました/);

  // 中断（signal.aborted）はエラー通知しない
  const aborted = setup(async () => {
    throw new Error("aborted");
  });
  const controller = new AbortController();
  controller.abort();
  const abortedOutcome = await aborted.runner.run(Buffer.alloc(3200), {
    signal: controller.signal,
    hooks: hooks(aborted),
  });
  assert.deepEqual(abortedOutcome, { kind: "empty" });
  assert.equal(aborted.errors.length, 0);
});
