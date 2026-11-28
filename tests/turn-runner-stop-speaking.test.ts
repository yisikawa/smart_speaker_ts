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
      conversation: { language: "ja" },
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
