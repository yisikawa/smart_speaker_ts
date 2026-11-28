import test from "node:test";
import assert from "node:assert/strict";
import { ConversationHistory } from "../src/backend/conversation/ConversationHistory";
import { PromptBuilder } from "../src/backend/conversation/PromptBuilder";
import { TurnHooks, TurnRunner } from "../src/backend/conversation/TurnRunner";
import { Logger } from "../src/backend/core/logger";
import type { LanguageModel, PlaybackMeta, TextToSpeech } from "../src/backend/core/ports";
import { encodeWav } from "../src/backend/services/wav";
import { createTempProject } from "./helpers/project";

Logger.configure({ level: "error" });

test("play に volumes 付きの meta を渡す", async () => {
  const project = createTempProject({ patch: { conversation: { language: "ja" } } });
  try {
    const wav = encodeWav(Buffer.alloc(4800, 1), 24000); // 100ms / 24kHz
    const llm: LanguageModel = {
      isAvailable: async () => true,
      listModels: async () => [],
      chatStream: async (_messages, onDelta) => {
        onDelta("こんにちは。");
        return "こんにちは。";
      },
    };
    const tts: TextToSpeech = {
      isAvailable: async () => true,
      listSpeakers: async () => [],
      synthesize: async () => wav,
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

    const captured: PlaybackMeta[] = [];
    const hooks: TurnHooks = {
      setState: () => undefined,
      emit: () => undefined,
      onError: () => undefined,
      onHistoryChanged: () => undefined,
      onReply: () => undefined,
      play: async (_wav, meta) => {
        captured.push(meta);
        return undefined;
      },
      stopPlayback: () => undefined,
    };

    await runner.run("やあ", hooks, new AbortController().signal);
    assert.equal(captured.length, 1);
    const meta = captured[0];
    assert.equal(meta.text, "こんにちは。");
    assert.equal(meta.sliceMs, 20);
    assert.equal(meta.volumes.length, 5);
    assert.ok(meta.utteranceId.length > 0);
    assert.ok(meta.durationMs >= 90);
  } finally {
    project.cleanup();
  }
});
