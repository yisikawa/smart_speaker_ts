import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { AddressInfo } from "node:net";
import { ConfigManager } from "../src/backend/config/ConfigManager";
import { OllamaLlmService } from "../src/backend/services/OllamaLlmService";

/** NDJSON をわざと細かく分割して返す擬似 Ollama サーバー */
function startFakeOllama(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ models: [{ name: "test-model:latest" }] }));
      return;
    }

    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/x-ndjson");
      const payload =
        [
          JSON.stringify({ message: { content: "こん" }, done: false }),
          JSON.stringify({ message: { content: "にちは" }, done: false }),
          JSON.stringify({ message: { content: "！" }, done: true }),
        ].join("\n") + "\n";

      // 3 文字ずつ送る（JSON の途中でチャンクが切れる）
      let index = 0;
      const timer = setInterval(() => {
        if (index >= payload.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(payload.slice(index, index + 3));
        index += 3;
      }, 1);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function withConfig(port: number): { rootDir: string; config: ConfigManager; cleanup: () => void } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumika-llm-"));
  const config = new ConfigManager({ rootDir });
  config.update({ llm: { endpoint: `http://127.0.0.1:${port}`, model: "test-model" } });
  return { rootDir, config, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

test("Ollama の NDJSON ストリームはチャンク境界をまたいでも欠落しない", async () => {
  const { server, port } = await startFakeOllama();
  const project = withConfig(port);

  try {
    const service = new OllamaLlmService({ config: project.config });
    const deltas: string[] = [];

    const text = await service.chatStream([{ role: "user", content: "やあ" }], (delta) => {
      deltas.push(delta);
    });

    assert.equal(text, "こんにちは！");
    assert.equal(deltas.join(""), "こんにちは！");
    assert.ok(deltas.length >= 3, `deltas=${deltas.join("|")}`);
  } finally {
    project.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("isAvailable / listModels / hasModel が Ollama の応答を解釈する", async () => {
  const { server, port } = await startFakeOllama();
  const project = withConfig(port);

  try {
    const service = new OllamaLlmService({ config: project.config });
    assert.equal(await service.isAvailable(), true);
    assert.deepEqual(await service.listModels(), ["test-model:latest"]);
    assert.equal(await service.hasModel("test-model"), true);
    assert.equal(await service.hasModel("unknown"), false);
  } finally {
    project.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("接続できない場合は isAvailable が false を返す", async () => {
  const project = withConfig(1); // 使用されていないポート
  try {
    const service = new OllamaLlmService({ config: project.config });
    assert.equal(await service.isAvailable(), false);
  } finally {
    project.cleanup();
  }
});

/** モデル未取得時に Ollama が返す 404 を再現する擬似サーバー */
function startFakeOllamaMissingModel(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ models: [] }));
      return;
    }

    req.resume();
    req.on("end", () => {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "model 'test-model' not found" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

test("モデル未取得の 404 は ollama pull を促すエラーになる", async () => {
  const { server, port } = await startFakeOllamaMissingModel();
  const project = withConfig(port);

  try {
    const service = new OllamaLlmService({ config: project.config });
    await assert.rejects(
      () => service.chatStream([{ role: "user", content: "やあ" }], () => {}),
      (error: Error) => {
        assert.match(error.message, /Ollama にモデル 'test-model' がありません（404）/);
        assert.match(error.message, /ollama pull test-model/);
        assert.match(error.message, /not found/);
        return true;
      }
    );
  } finally {
    project.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
