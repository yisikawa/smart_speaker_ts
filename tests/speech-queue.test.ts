import test from "node:test";
import assert from "node:assert/strict";
import { SpeechQueue } from "../src/backend/conversation/SpeechQueue";
import { Logger } from "../src/backend/core/logger";
import type { PlaybackMeta, TextToSpeech } from "../src/backend/core/ports";
import { encodeWav } from "../src/backend/services/wav";

Logger.configure({ level: "error" });

const wav = encodeWav(Buffer.alloc(4800, 1), 24000);

function makeTts(calls: string[], onSynth?: (text: string) => Promise<Buffer>): TextToSpeech {
  return {
    isAvailable: async () => true,
    listSpeakers: async () => [],
    synthesize: async (text: string) => {
      calls.push(text);
      if (onSynth) {
        return onSynth(text);
      }
      if (text.includes("NG")) {
        throw new Error("tts failed");
      }
      return wav;
    },
  };
}

function makeQueue(options: {
  tts: TextToSpeech;
  played?: string[];
  playImpl?: (wav: Buffer, meta: PlaybackMeta) => Promise<Buffer | undefined>;
}) {
  const played = options.played ?? [];
  return new SpeechQueue({
    tts: options.tts,
    logger: new Logger("Test"),
    signal: new AbortController().signal,
    sampleRate: 24000,
    prefetchDepth: 1,
    play:
      options.playImpl ??
      (async (_wav, meta) => {
        played.push(meta.text);
        return undefined;
      }),
  });
}

test("文を順番に再生する", async () => {
  const calls: string[] = [];
  const played: string[] = [];
  const queue = makeQueue({ tts: makeTts(calls), played });
  queue.enqueue("一つ目です。");
  queue.enqueue("二つ目です。");
  const result = await queue.drain();
  assert.deepEqual(played, ["一つ目です。", "二つ目です。"]);
  assert.equal(result.played, 2);
  assert.equal(result.failed, 0);
});

test("1 文失敗しても残りは再生する", async () => {
  const calls: string[] = [];
  const played: string[] = [];
  const queue = makeQueue({ tts: makeTts(calls), played });
  queue.enqueue("NG です。");
  queue.enqueue("OK です。");
  const result = await queue.drain();
  assert.deepEqual(played, ["OK です。"]);
  assert.equal(result.failed, 1);
});

test("再生中に次の文を先読みする", async () => {
  const calls: string[] = [];
  const played: string[] = [];
  let release!: () => void;
  const queue = makeQueue({
    tts: makeTts(calls),
    played,
    playImpl: async (_wav, meta) => {
      played.push(meta.text);
      if (meta.text.startsWith("A")) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return undefined;
    },
  });
  queue.enqueue("A です。");
  queue.enqueue("B です。");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(calls.includes("B です。"), "B が先読みされている");
  release();
  await queue.drain();
});

test("stop したら残りを再生しない", async () => {
  const calls: string[] = [];
  const played: string[] = [];
  const queue = makeQueue({ tts: makeTts(calls), played });
  queue.enqueue("一つ目です。");
  queue.enqueue("二つ目です。");
  queue.stop();
  const result = await queue.drain();
  assert.deepEqual(played, []);
  assert.equal(result.played, 0);
});

test("バージインがあれば止めて WAV を返す", async () => {
  const calls: string[] = [];
  const played: string[] = [];
  const barge = Buffer.from([1, 2, 3]);
  const queue = makeQueue({
    tts: makeTts(calls),
    played,
    playImpl: async (_wav, meta) => {
      played.push(meta.text);
      return barge;
    },
  });
  queue.enqueue("一つ目です。");
  queue.enqueue("二つ目です。");
  const result = await queue.drain();
  assert.deepEqual(played, ["一つ目です。"]);
  assert.equal(result.played, 1);
  assert.equal(result.bargeWav, barge);
});
