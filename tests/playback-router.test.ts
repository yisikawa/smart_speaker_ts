import test from "node:test";
import assert from "node:assert/strict";
import type { PlaybackHandle, PlaybackMeta, PlaybackSink } from "../src/backend/core/ports";
import { PlaybackRouter } from "../src/backend/conversation/PlaybackRouter";
import { createTempProject } from "./helpers/project";
import { Logger } from "../src/backend/core/logger";

Logger.configure({ level: "error" });

const meta: PlaybackMeta = {
  utteranceId: "u1",
  text: "こんにちは",
  volumes: [],
  sliceMs: 20,
  durationMs: 100,
};

function fakeSink(kind: "server" | "browser", available = true): { sink: PlaybackSink; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sink: {
      kind,
      isAvailable: () => available,
      play: (): PlaybackHandle => {
        calls.push(1);
        return { finished: Promise.resolve(), stop: () => undefined };
      },
    },
  };
}

test("playback_target=browser で表示クライアントがいれば browser", () => {
  const project = createTempProject({ patch: { audio: { playback_target: "browser" } } });
  try {
    const server = fakeSink("server");
    const browser = fakeSink("browser");
    const router = new PlaybackRouter({ config: project.config, server: server.sink, browser: browser.sink });
    router.play(Buffer.alloc(2), meta);
    assert.equal(router.kind, "browser");
    assert.equal(browser.calls.length, 1);
    assert.equal(server.calls.length, 0);
  } finally {
    project.cleanup();
  }
});

test("browser が使えなければ server へフォールバックする", () => {
  const project = createTempProject({ patch: { audio: { playback_target: "browser" } } });
  try {
    const server = fakeSink("server");
    const browser = fakeSink("browser", false);
    const router = new PlaybackRouter({ config: project.config, server: server.sink, browser: browser.sink });
    router.play(Buffer.alloc(2), meta);
    assert.equal(router.kind, "server");
    assert.equal(server.calls.length, 1);
  } finally {
    project.cleanup();
  }
});

test("playback_target=server なら browser があっても server", () => {
  const project = createTempProject();
  try {
    const server = fakeSink("server");
    const browser = fakeSink("browser");
    const router = new PlaybackRouter({ config: project.config, server: server.sink, browser: browser.sink });
    assert.equal(router.kind, "server");
  } finally {
    project.cleanup();
  }
});
