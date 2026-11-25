import test from "node:test";
import assert from "node:assert/strict";
import { AudioPlayer } from "../src/frontend/AudioPlayer";
import type { PipelineEvent } from "../src/shared/protocol";

interface FakeSource {
  buffer: unknown;
  onended: (() => void) | null;
  connect(): void;
  start(): void;
  stop(): void;
}

type AudioEvent = Extract<PipelineEvent, { type: "tts_audio" }>;

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const started: string[] = [];
  const stopped: number[] = [];
  const acks: string[] = [];
  const sources: FakeSource[] = [];
  const decodes: { resolve: (buffer: unknown) => void; reject: (error: unknown) => void }[] = [];

  const context = {
    currentTime: 0,
    state: "running",
    destination: {},
    createGain: () => ({ gain: { value: 1 }, connect: () => undefined }),
    createBufferSource: () => {
      const source: FakeSource = {
        buffer: null,
        onended: null,
        connect: () => undefined,
        start: () => started.push("start"),
        stop: () => stopped.push(1),
      };
      sources.push(source);
      return source;
    },
    decodeAudioData: () =>
      new Promise<unknown>((resolve, reject) => {
        decodes.push({ resolve, reject });
      }),
    close: async () => undefined,
  };

  const player = new AudioPlayer({
    send: (command) => {
      if (command.type === "audio_playback_done") {
        acks.push(command.utteranceId);
      }
    },
    createContext: () => context as unknown as AudioContext,
  });
  return { player, started, stopped, acks, sources, decodes };
}

function ttsAudio(utteranceId: string): AudioEvent {
  return {
    type: "tts_audio",
    utteranceId,
    text: "テスト",
    audio: "",
    volumes: [],
    sliceMs: 20,
    durationMs: 10,
  };
}

test("デコード解決前に stop したら再生しない（ack も送らない）", async () => {
  const fakes = setup();
  fakes.player.enqueue(ttsAudio("u1"));
  fakes.player.stop();
  fakes.decodes[0].resolve({});
  await flush();
  assert.deepEqual(fakes.started, []);
  assert.deepEqual(fakes.acks, []);
});

test("再生中の stop は source を止め、遅れて来た onended で二重 ack しない", async () => {
  const fakes = setup();
  fakes.player.enqueue(ttsAudio("u1"));
  fakes.decodes[0].resolve({});
  await flush();
  assert.deepEqual(fakes.started, ["start"]);

  fakes.player.stop();
  fakes.sources[0].onended?.();
  await flush();
  assert.equal(fakes.stopped.length, 1);
  assert.deepEqual(fakes.acks, []);
});

test("stop 後の次の enqueue は再生される", async () => {
  const fakes = setup();
  fakes.player.enqueue(ttsAudio("u1"));
  fakes.decodes[0].resolve({});
  await flush();
  fakes.player.stop();

  fakes.player.enqueue(ttsAudio("u2"));
  fakes.decodes[1].resolve({});
  await flush();
  assert.equal(fakes.started.length, 2);
});

test("デコード失敗（停止していない）は ack を送る", async () => {
  const fakes = setup();
  fakes.player.enqueue(ttsAudio("u1"));
  fakes.decodes[0].reject(new Error("bad wav"));
  await flush();
  assert.deepEqual(fakes.started, []);
  assert.deepEqual(fakes.acks, ["u1"]);
});

test("停止後のデコード失敗は ack も送らない", async () => {
  const fakes = setup();
  fakes.player.enqueue(ttsAudio("u1"));
  fakes.player.stop();
  fakes.decodes[0].reject(new Error("bad wav"));
  await flush();
  assert.deepEqual(fakes.started, []);
  assert.deepEqual(fakes.acks, []);
});
