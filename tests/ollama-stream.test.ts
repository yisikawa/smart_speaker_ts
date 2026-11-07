import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { OllamaLlmService } from "../src/backend/services/OllamaLlmService";
import { createTempProject, TempProject } from "./helpers/project";

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

function withConfig(port: number): TempProject {
  return createTempProject({
    prefix: "sumika-llm-",
    patch: { llm: { endpoint: `http://127.0.0.1:${port}`, model: "test-model" } },
  });
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

test("接続を切られた場合は案内付きのエラーになる", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    // モデル読み込み失敗などを想定して接続を切る
    req.socket.destroy();
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  const project = withConfig(port);

  try {
    const service = new OllamaLlmService({ config: project.config });
    await assert.rejects(
      () => service.chatStream([{ role: "user", content: "やあ" }], () => {}),
      /Ollama との接続が中断されました/
    );
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

/** 任意のハンドラで応答する擬似 Ollama（読み込み待ちの再現用） */
function startCustomOllama(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ models: [{ name: "test-model:latest" }] }));
      return;
    }
    req.resume();
    req.on("end", () => handler(req, res));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

test("prepare は /api/generate でモデルを事前読み込みする", async () => {
  let generateCalled = 0;
  const { server, port } = await startCustomOllama((req, res) => {
    if (req.url === "/api/generate") {
      generateCalled += 1;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ done: true, done_reason: "load" }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  const project = withConfig(port);

  try {
    const service = new OllamaLlmService({ config: project.config });
    const elapsedMs = await service.prepare("test-model");
    assert.equal(generateCalled, 1);
    assert.ok(elapsedMs >= 0);
  } finally {
    project.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("最初のチャンクは応答タイムアウトより長く待つ（モデル読み込み中でも切らない）", async () => {
  // 応答タイムアウト 5 秒・読み込み待ち 30 秒。6 秒後に最初のチャンクを返す
  const { server, port } = await startCustomOllama((_req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    setTimeout(() => {
      res.write(`${JSON.stringify({ message: { content: "おはよう" }, done: false })}\n`);
      res.write(`${JSON.stringify({ message: { content: "！" }, done: true })}\n`);
      res.end();
    }, 6000);
  });
  const project = createTempProject({
    prefix: "sumika-llm-",
    patch: {
      llm: {
        endpoint: `http://127.0.0.1:${port}`,
        model: "test-model",
        response_timeout_seconds: 5,
        model_load_timeout_seconds: 30,
      },
    },
  });

  try {
    const service = new OllamaLlmService({ config: project.config });
    const text = await service.chatStream([{ role: "user", content: "やあ" }], () => {});
    assert.equal(text, "おはよう！", "読み込み待ちで打ち切られないこと");
  } finally {
    project.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("応答が空のまま終わった場合はモデル読み込みの案内になる", async () => {
  const { server, port } = await startCustomOllama((_req, res) => {
    // 本文を書かずに終了する（読み込みに失敗した場合に近い）
    res.setHeader("Content-Type", "application/x-ndjson");
    res.end();
  });
  const project = withConfig(port);

  try {
    const service = new OllamaLlmService({ config: project.config });
    await assert.rejects(
      () => service.chatStream([{ role: "user", content: "やあ" }], () => {}),
      (error: Error) => {
        assert.match(error.message, /モデルの読み込みに時間がかかっている可能性/);
        assert.match(error.message, /llm\.model_load_timeout_seconds/);
        return true;
      }
    );
  } finally {
    project.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
