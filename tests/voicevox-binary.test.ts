import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { encodeWav } from "../src/backend/services/wav";
import { VoicevoxTtsService } from "../src/backend/services/VoicevoxTtsService";
import { createTempProject, TempProject } from "./helpers/project";

/** 0x80-0xFF を含むバイナリ（UTF-8 変換で壊れることを検出するため） */
function binaryWav(): Buffer {
  const pcm = Buffer.alloc(2048);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = (i * 37) % 256;
  }
  return encodeWav(pcm, 24000);
}

interface FakeVoicevox {
  server: http.Server;
  port: number;
  requests: { path: string; text?: string; query?: Record<string, unknown> }[];
}

function startFakeVoicevox(audio: Buffer): Promise<FakeVoicevox> {
  const requests: FakeVoicevox["requests"] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/version") {
      res.end("0.0.1");
      return;
    }
    if (url.pathname === "/speakers") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify([{ name: "テスト話者", styles: [{ name: "ノーマル", id: 1 }] }]));
      return;
    }
    if (url.pathname === "/audio_query") {
      requests.push({ path: url.pathname, text: url.searchParams.get("text") ?? undefined });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ speedScale: 1, pitchScale: 0, volumeScale: 1, accentPhrases: [] }));
      return;
    }
    if (url.pathname === "/synthesis") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        requests.push({ path: url.pathname, query: raw ? JSON.parse(raw) : undefined });
        res.setHeader("Content-Type", "audio/wav");
        res.end(audio);
      });
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, requests });
    });
  });
}

function withConfig(port: number): TempProject {
  return createTempProject({
    prefix: "sumika-tts-",
    patch: {
      tts: { endpoint: `http://127.0.0.1:${port}`, speed: 1.5, pitch: -0.1, volume: 0.8, speaker_id: 3 },
    },
  });
}

test("synthesize はバイナリ音声を破損せずに返す（文字列変換バグの回帰テスト）", async () => {
  const audio = binaryWav();
  const fake = await startFakeVoicevox(audio);
  const project = withConfig(fake.port);

  try {
    const service = new VoicevoxTtsService({ config: project.config });
    const result = await service.synthesize("こんにちは、テストです。");

    assert.equal(result.length, audio.length);
    assert.ok(result.equals(audio), "受信したバイト列がそのまま返ること");

    const queryRequest = fake.requests.find((request) => request.path === "/audio_query");
    assert.equal(queryRequest?.text, "こんにちは、テストです。");

    const synthesisRequest = fake.requests.find((request) => request.path === "/synthesis");
    assert.equal(synthesisRequest?.query?.speedScale, 1.5);
    assert.equal(synthesisRequest?.query?.pitchScale, -0.1);
    assert.equal(synthesisRequest?.query?.volumeScale, 0.8);
  } finally {
    project.cleanup();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  }
});

test("isAvailable と listSpeakers が VOICEVOX の応答を解釈する", async () => {
  const fake = await startFakeVoicevox(binaryWav());
  const project = withConfig(fake.port);

  try {
    const service = new VoicevoxTtsService({ config: project.config });
    assert.equal(await service.isAvailable(), true);

    const speakers = await service.listSpeakers();
    assert.equal(speakers[0]?.name, "テスト話者");
    assert.equal(speakers[0]?.styles[0]?.id, 1);
  } finally {
    project.cleanup();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  }
});

test("空テキストは音声合成しない", async () => {
  const fake = await startFakeVoicevox(binaryWav());
  const project = withConfig(fake.port);

  try {
    const service = new VoicevoxTtsService({ config: project.config });
    await assert.rejects(() => service.synthesize("   "), /テキストが空/);
    assert.equal(fake.requests.length, 0);
  } finally {
    project.cleanup();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  }
});
