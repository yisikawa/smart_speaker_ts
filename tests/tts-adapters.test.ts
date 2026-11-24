import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { OpenAiSpeechTtsService } from "../src/backend/services/OpenAiSpeechTtsService";
import { TtsRouter } from "../src/backend/services/TtsRouter";
import { isPcm16MonoWav, normalizeWav } from "../src/backend/services/wavNormalize";
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

test("OpenAiSpeechTtsService は /v1/audio/speech の WAV を返す", async () => {
  const wav = makeWav({ ms: 50 });
  let received: unknown = null;
  const server = await startStubServer((req, res, body) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.url === "/v1/audio/speech") {
      received = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(wav);
      return;
    }
    res.writeHead(404).end();
  });

  const project = createTempProject({
    patch: {
      conversation: { language: "en" },
      tts: { en: { endpoint: `http://127.0.0.1:${server.port}`, model: "kokoro", voice: "af_heart", speed: 1.2 } },
    },
  });

  try {
    const service = new OpenAiSpeechTtsService({ config: project.config, profile: () => project.config.getTTS().en });
    assert.equal(await service.isAvailable(), true);
    const audio = await service.synthesize("Hello world");
    assert.equal(audio.subarray(0, 4).toString("ascii"), "RIFF");
    assert.deepEqual(received, {
      model: "kokoro",
      input: "Hello world",
      voice: "af_heart",
      response_format: "wav",
      speed: 1.2,
    });
  } finally {
    await server.close();
    project.cleanup();
  }
});

test("OpenAiSpeechTtsService は WAV 以外の応答を明示的に失敗させる", async () => {
  const server = await startStubServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not wav" }));
  });

  const project = createTempProject({
    patch: { tts: { en: { endpoint: `http://127.0.0.1:${server.port}` } } },
  });

  try {
    const service = new OpenAiSpeechTtsService({ config: project.config, profile: () => project.config.getTTS().en });
    await assert.rejects(() => service.synthesize("Hello"), /WAV ではありません/);
  } finally {
    await server.close();
    project.cleanup();
  }
});

test("TtsRouter は英語モードで合成結果を正規化して返す", async () => {
  const wav = makeWav({ ms: 50, sampleRate: 24000 });
  const server = await startStubServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "audio/wav" });
    res.end(wav);
  });

  const project = createTempProject({
    patch: {
      conversation: { language: "en" },
      audio: { ffmpeg_path: "C:/ffmpeg/bin/ffmpeg.exe" },
      tts: { en: { endpoint: `http://127.0.0.1:${server.port}` } },
    },
  });

  try {
    const normalized = Buffer.from("normalized");
    let seen: { ffmpegPath?: string; input?: Buffer } = {};
    const router = new TtsRouter({
      config: project.config,
      normalize: async (input, options) => {
        seen = { ffmpegPath: options.ffmpegPath, input };
        return normalized;
      },
    });
    const result = await router.synthesize("Hello");
    assert.equal(result.toString(), "normalized");
    assert.equal(seen.ffmpegPath, "C:/ffmpeg/bin/ffmpeg.exe");
    assert.equal(seen.input?.subarray(0, 4).toString("ascii"), "RIFF");
  } finally {
    await server.close();
    project.cleanup();
  }
});

test("normalizeWav は 16bit PCM モノラルをそのまま返す", async () => {
  const wav = makeWav({ ms: 30 });
  assert.equal(isPcm16MonoWav(wav), true);
  const result = await normalizeWav(wav);
  assert.equal(result, wav, "変換不要なら同一 Buffer を返す");
  assert.equal(isPcm16MonoWav(Buffer.from("not a wav")), false);
});
