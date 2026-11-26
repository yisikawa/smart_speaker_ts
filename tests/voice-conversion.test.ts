import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as path from "node:path";
import { TtsRouter } from "../src/backend/services/TtsRouter";
import { VoiceConversionService } from "../src/backend/services/VoiceConversionService";
import { createTempProject, makeWav } from "./helpers/project";

interface StubServer {
  port: number;
  close(): Promise<void>;
  lastBody: unknown;
}

function startStubServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void
): Promise<StubServer> {
  const state: { lastBody: unknown } = { lastBody: null };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      try {
        state.lastBody = body ? JSON.parse(body) : null;
      } catch {
        state.lastBody = body;
      }
      handler(req, res, body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("ポートを取得できませんでした"));
        return;
      }
      resolve({
        port: address.port,
        lastBody: state.lastBody,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test("voice_conversion の既定は有効で index_rate=0（ハードコードしない前提）", () => {
  const project = createTempProject();
  try {
    const cfg = project.config.getTTS().voice_conversion;
    assert.equal(cfg.enabled, true, "既定で有効（未起動なら自動スキップ）");
    assert.equal(cfg.index_rate, 0, "既定は 0（速度優先）");
    assert.equal(cfg.endpoint, "http://127.0.0.1:9890");
  } finally {
    project.cleanup();
  }
});

test("VoiceConversionService は設定の index_rate などをそのまま /convert へ渡す", async () => {
  const converted = makeWav({ ms: 30, sampleRate: 32000 });
  const bodies: Array<Record<string, unknown>> = [];
  const server = await startStubServer((_req, res, body) => {
    bodies.push(JSON.parse(body) as Record<string, unknown>);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ wav_base64: converted.toString("base64") }));
  });
  const project = createTempProject({
    patch: {
      tts: {
        voice_conversion: {
          enabled: true,
          endpoint: `http://127.0.0.1:${server.port}`,
          index_rate: 0.42,
          pitch: 3,
          f0_method: "harvest",
          model_path: "models/test.pth",
          index_path: "models/test.index",
        },
      },
    },
  });
  try {
    const service = new VoiceConversionService({ config: project.config });
    const input = makeWav({ ms: 30 });
    const result = await service.convert(input);

    assert.deepEqual(result, converted, "変換後の WAV をそのまま返す（40kHz のまま）");
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].index_rate, 0.42, "設定の index_rate をそのまま送る（ハードコードしない）");
    assert.equal(bodies[0].pitch, 3);
    assert.equal(bodies[0].f0_method, "harvest");
    assert.equal(bodies[0].model, path.resolve(project.rootDir, "models/test.pth"));
    assert.equal(bodies[0].index, path.resolve(project.rootDir, "models/test.index"));
    assert.equal(bodies[0].wav_base64, input.toString("base64"));
  } finally {
    await server.close();
    project.cleanup();
  }
});

test("VoiceConversionService は失敗時に元の WAV を返す（無音にしない）", async () => {
  const server = await startStubServer((_req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "boom" }));
  });
  const project = createTempProject({
    patch: {
      tts: {
        voice_conversion: {
          enabled: true,
          endpoint: `http://127.0.0.1:${server.port}`,
          model_path: "models/test.pth",
        },
      },
    },
  });
  try {
    const service = new VoiceConversionService({ config: project.config });
    const input = makeWav({ ms: 30 });
    let captured: unknown = null;
    const result = await service.convert(input, { onError: (error) => (captured = error) });
    assert.equal(result, input, "失敗時は元の WAV を返す");
    assert.ok(captured instanceof Error, "失敗は onError で通知する");
  } finally {
    await server.close();
    project.cleanup();
  }
});

test("VoiceConversionService は enabled=false なら通信しない", async () => {
  const project = createTempProject({ patch: { tts: { voice_conversion: { enabled: false } } } });
  try {
    let called = false;
    const service = new VoiceConversionService({
      config: project.config,
      fetchImpl: (async () => {
        called = true;
        throw new Error("呼ばれてはいけない");
      }) as typeof fetch,
    });
    const input = makeWav({ ms: 30 });
    assert.equal(await service.convert(input), input);
    assert.equal(called, false, "無効時は fetch しない");
  } finally {
    project.cleanup();
  }
});

test("TtsRouter は正規化の後に声質変換を呼ぶ", async () => {
  const ttsWav = makeWav({ ms: 40, sampleRate: 24000 });
  const server = await startStubServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "audio/wav" });
    res.end(ttsWav);
  });
  const project = createTempProject({
    patch: {
      conversation: { language: "en" },
      tts: { en: { engine: "openai_speech", endpoint: `http://127.0.0.1:${server.port}` } },
    },
  });
  try {
    const normalizedWav = makeWav({ ms: 50 });
    let received: Buffer | null = null;
    const router = new TtsRouter({
      config: project.config,
      normalize: async () => normalizedWav,
      voiceConversion: {
        convert: async (wav) => {
          received = wav;
          return Buffer.from("converted");
        },
      },
    });
    const result = await router.synthesize("Hello");
    assert.equal(result.toString(), "converted", "変換後の音声を返す");
    assert.equal(received, normalizedWav, "正規化の結果を変換へ渡す");
  } finally {
    await server.close();
    project.cleanup();
  }
});

test("index_rate は設定ファイルの値をそのまま使う（0.35 など中間値も可）", () => {
  const project = createTempProject({
    patch: { tts: { voice_conversion: { index_rate: 0.35 } } },
  });
  try {
    assert.equal(project.config.getTTS().voice_conversion.index_rate, 0.35);
  } finally {
    project.cleanup();
  }
});

test("index_rate / protect / pitch は RVC の仕様範囲へ補正され、警告が残る", () => {
  const project = createTempProject({
    patch: { tts: { voice_conversion: { index_rate: 3.5, protect: 0.9, pitch: 99 } } },
  });
  try {
    const cfg = project.config.getTTS().voice_conversion;
    assert.equal(cfg.index_rate, 1, "index_rate は 0..1");
    assert.equal(cfg.protect, 0.5, "protect は 0..0.5");
    assert.equal(cfg.pitch, 0, "pitch は -24..24");
    const warnings = project.config.getWarnings();
    assert.ok(
      warnings.some((w) => w.includes("index_rate")),
      `補正を警告に残す: ${warnings.join(" / ")}`
    );
  } finally {
    project.cleanup();
  }
});
