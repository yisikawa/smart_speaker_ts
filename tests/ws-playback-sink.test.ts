import test from "node:test";
import assert from "node:assert/strict";
import type { PlaybackMeta } from "../src/backend/core/ports";
import type { ServerMessage } from "../src/shared/protocol";
import { WsPlaybackSink } from "../src/backend/server/WsPlaybackSink";
import { Logger } from "../src/backend/core/logger";

Logger.configure({ level: "error" });

const meta: PlaybackMeta = {
  utteranceId: "u1",
  text: "こんにちは",
  volumes: [0.5, 1],
  sliceMs: 20,
  durationMs: 100,
};

function makeSink(overrides: { connected?: boolean; sent?: ServerMessage[] } = {}) {
  const sent = overrides.sent ?? [];
  return new WsPlaybackSink({
    send: (message) => {
      sent.push(message);
      return true;
    },
    hasPrimaryClient: () => overrides.connected ?? true,
    timeoutMarginMs: 1500,
  });
}

test("tts_audio を送り、ack で解決する", async () => {
  const sent: ServerMessage[] = [];
  const sink = makeSink({ sent });
  const handle = sink.play(Buffer.from([1, 2, 3]), meta);

  assert.equal(sent.length, 1);
  const message = sent[0] as { type: "event"; event: { type: string; utteranceId: string; audio: string } };
  assert.equal(message.type, "event");
  assert.equal(message.event.type, "tts_audio");
  assert.equal(message.event.utteranceId, "u1");
  assert.equal(message.event.audio, "AQID");

  sink.resolveDone("u1");
  await handle.finished;
});

test("ack が来なくても時間切れで解決する", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sink = makeSink();
  const handle = sink.play(Buffer.from([1]), meta);
  t.mock.timers.tick(100 + 1500);
  await handle.finished;
});

test("クライアント不在なら送らず即解決する", async () => {
  const sent: ServerMessage[] = [];
  const sink = makeSink({ connected: false, sent });
  assert.equal(sink.isAvailable(), false);
  await sink.play(Buffer.from([1]), meta).finished;
  assert.equal(sent.length, 0);
});

test("stop でも解決する", async () => {
  const sink = makeSink();
  const handle = sink.play(Buffer.from([1]), meta);
  handle.stop();
  await handle.finished;
});
