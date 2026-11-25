import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import type { ConversationPipeline } from "../src/backend/conversation/ConversationPipeline";
import type { AudioIO, LanguageModel } from "../src/backend/core/ports";
import type { CharacterService } from "../src/backend/services/CharacterService";
import type { ServiceMonitor } from "../src/backend/server/ServiceMonitor";
import { createApiRouter } from "../src/backend/server/ApiRouter";
import { createTempProject } from "./helpers/project";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

test("未知の sherpa_model_type は 400 で拒否し、設定を保存しない", async () => {
  const project = createTempProject();
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumika-sherpa-"));
  fs.writeFileSync(path.join(modelDir, "tokens.txt"), "");

  const updated: unknown[] = [];
  const update = project.config.update.bind(project.config);
  project.config.update = ((patch) => {
    updated.push(patch);
    return update(patch);
  }) as typeof project.config.update;

  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createApiRouter({
      config: project.config,
      pipeline: {
        getState: () => "idle",
        isBusy: false,
        getHistory: () => [],
        clearHistory: () => undefined,
        speak: async () => undefined,
      } as unknown as ConversationPipeline,
      audio: { listInputDevices: async () => [] } as unknown as AudioIO,
      llm: { listModels: async () => [] } as unknown as LanguageModel,
      character: {
        get: () => ({ name: "さくら", label: "テスト" }),
        reload: () => undefined,
      } as unknown as CharacterService,
      serviceMonitor: {
        refresh: async () => ({ llm: true, tts: true, stt: true }),
        current: { llm: true, tts: true, stt: true },
      } as unknown as ServiceMonitor,
      version: "0.0.0",
      startedAt: Date.now(),
    })
  );

  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/models/stt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engine: "sherpa",
        sherpa_model_dir: modelDir,
        sherpa_model_type: "bogus_type",
      }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /bogus_type/);
    assert.equal(updated.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(modelDir, { recursive: true, force: true });
    project.cleanup();
  }
});
