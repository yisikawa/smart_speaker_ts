import test from "node:test";
import assert from "node:assert/strict";
import type { AudioIO, PlaybackMeta } from "../src/backend/core/ports";
import { ServerPlaybackSink } from "../src/backend/services/ServerPlaybackSink";

const meta: PlaybackMeta = {
  utteranceId: "u1",
  text: "こんにちは",
  volumes: [],
  sliceMs: 20,
  durationMs: 100,
};

test("AudioIO.play へ委譲する", async () => {
  let plays = 0;
  const audio: AudioIO = {
    listInputDevices: async () => [],
    capture: () => ({ result: new Promise(() => undefined), stop: () => undefined }),
    play: () => {
      plays += 1;
      return { finished: Promise.resolve(), stop: () => undefined };
    },
    dispose: async () => undefined,
  };
  const sink = new ServerPlaybackSink({ audio });
  assert.equal(sink.kind, "server");
  assert.equal(sink.isAvailable(), true);
  await sink.play(Buffer.alloc(4), meta).finished;
  assert.equal(plays, 1);
});
