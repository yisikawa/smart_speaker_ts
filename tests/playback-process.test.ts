import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { ConfigManager } from "../src/backend/config/ConfigManager";
import type { AudioConfig } from "../src/backend/config/schema";
import type { Logger } from "../src/backend/core/logger";
import {
  PlaybackProcess,
  buildPlaybackArgs,
} from "../src/backend/services/PlaybackProcess";
import { encodeWav } from "../src/backend/services/wav";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const audio = {
  sample_rate: 16000,
  output_volume: 1,
  player: "ffplay",
} as AudioConfig;

const config = { getAudio: () => audio } as unknown as ConfigManager;
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const wav = encodeWav(Buffer.alloc(320), 16000);

interface FakeChild extends EventEmitter {
  killCount: number;
}

function setup() {
  const spawns: { binary: string; args: string[] }[] = [];
  const writes: string[] = [];
  const removes: string[] = [];
  const children: FakeChild[] = [];

  const playback = new PlaybackProcess({
    config,
    logger,
    spawn: (binary, args) => {
      spawns.push({ binary, args });
      const child = Object.assign(new EventEmitter(), {
        killCount: 0,
        kill() {
          this.killCount += 1;
        },
      }) as FakeChild;
      children.push(child);
      return child as unknown as ChildProcess;
    },
    hasFfplay: async () => true,
    writeFile: (file) => writes.push(file),
    removeFile: (file) => removes.push(file),
    tmpFile: () => "C:/tmp/playback.wav",
  });
  return { playback, spawns, writes, removes, children };
}

test("stop が spawn より先なら起動せず、書いたファイルを消す", async () => {
  const fakes = setup();
  const handle = fakes.playback.play(wav);
  handle.stop();
  await handle.finished;

  assert.equal(fakes.spawns.length, 0);
  assert.deepEqual(fakes.writes, ["C:/tmp/playback.wav"]);
  assert.deepEqual(fakes.removes, ["C:/tmp/playback.wav"]);
});

test("spawn 後の stop は子プロセスを kill する", async () => {
  const fakes = setup();
  const handle = fakes.playback.play(wav);
  await flush();
  assert.equal(fakes.spawns.length, 1);

  handle.stop();
  assert.equal(fakes.children[0].killCount, 1);
  await handle.finished;
  assert.deepEqual(fakes.removes, ["C:/tmp/playback.wav"]);
});

test("dispose は再生中の子プロセスを kill する", async () => {
  const fakes = setup();
  fakes.playback.play(wav);
  await flush();
  assert.equal(fakes.spawns.length, 1);

  fakes.playback.dispose();
  assert.equal(fakes.children[0].killCount, 1);
});

test("ffplay の音量は 0..100 に丸める", () => {
  assert.deepEqual(buildPlaybackArgs("ffplay", "a.wav", 1.5).slice(4, 6), ["-volume", "100"]);
  assert.deepEqual(buildPlaybackArgs("ffplay", "a.wav", -1).slice(4, 6), ["-volume", "0"]);
});

test("SoundPlayer はシングルクォートをエスケープしてパスを埋め込む", () => {
  const args = buildPlaybackArgs("soundplayer", "C:/tmp/a'b.wav", 1);
  assert.equal(args[0], "-NoProfile");
  assert.match(args[2], /a''b\.wav/);
});
