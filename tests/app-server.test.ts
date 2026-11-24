import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { WebSocket } from "ws";
import { AppServer } from "../src/backend/server/AppServer";
import { CharacterService } from "../src/backend/services/CharacterService";
import { Logger } from "../src/backend/core/logger";
import type { ConversationPipeline } from "../src/backend/conversation/ConversationPipeline";
import type { AudioIO, LanguageModel, SpeechToText, TextToSpeech } from "../src/backend/core/ports";
import { createTempProject } from "./helpers/project";

/** 空きポートを 1 つ確保する（listen(0) → 取得 → close） */
function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** テストに必要なメソッドだけを持つ pipeline のスタブ */
function createPipelineStub(): ConversationPipeline {
  const pipeline = {
    on: () => () => undefined,
    getState: () => "idle",
    getHistory: () => [],
    clearHistory: () => undefined,
    stop: () => undefined,
    stopSpeaking: () => undefined,
    speak: async () => undefined,
    submitText: async () => undefined,
    submitAudio: async () => undefined,
    handleWakeWord: async () => undefined,
  };
  return pipeline as unknown as ConversationPipeline;
}

/** 条件が満たされるまで待つ（タイムアウトで必ず終わる） */
async function waitFor<T>(probe: () => T | undefined, label: string, timeoutMs = 5000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`タイムアウト: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("言語切替の通知は character.reload() 後のキャラクター名を配る", async () => {
  const project = createTempProject({
    copyConfig: true,
    patch: {
      conversation: { language: "ja" },
      llm: {
        character_file: "config/characters/sakura.toml",
        character_file_en: "config/characters/sakura.en.toml",
      },
    },
  });
  const logger = new Logger("TestServer");
  logger.info = () => undefined;
  logger.warn = () => undefined;
  logger.error = () => undefined;

  const character = new CharacterService({ config: project.config, logger });
  const port = await reservePort();
  const server = new AppServer({
    config: project.config,
    pipeline: createPipelineStub(),
    audio: {} as AudioIO,
    llm: { isAvailable: async () => true } as unknown as LanguageModel,
    stt: { isAvailable: async () => true } as unknown as SpeechToText,
    tts: { isAvailable: async () => true } as unknown as TextToSpeech,
    character,
    logger,
    version: "test",
    port,
    frontendDirs: [],
  });

  const messages: Record<string, unknown>[] = [];
  let socket: WebSocket | null = null;
  try {
    await server.start();
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.on("error", () => undefined);
    socket.on("message", (data) => {
      messages.push(JSON.parse(String(data)) as Record<string, unknown>);
    });

    await waitFor(() => messages.find((message) => message.type === "hello"), "hello の受信");

    // 言語と同時に英語キャラクターのファイルも変える（reload の前後で差が出るようにする）
    const enFile = "config/characters/review.en.toml";
    fs.writeFileSync(
      path.join(project.rootDir, "config", "characters", "review.en.toml"),
      'name = "Reviewer"\nlabel = "Strict"\npersonality = "review"\nresponse_rules = "-"\n',
      "utf-8"
    );

    const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation: { language: "en" },
        llm: { character_file_en: enFile },
      }),
    });
    assert.equal(response.status, 200);

    const notified = await waitFor(
      () => messages.find((message) => message.type === "language"),
      "language 通知の受信"
    );
    assert.equal(notified.language, "en");
    assert.equal(
      (notified.character as { name: string }).name,
      "Reviewer",
      "character.reload() 後の名前が配られる（通知順序の回帰）"
    );
  } finally {
    socket?.close();
    await server.stop();
    project.cleanup();
  }
});
