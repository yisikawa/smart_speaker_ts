import test from "node:test";
import assert from "node:assert/strict";
import { buildVolumeEnvelope } from "../src/shared/audio/envelope";
import { encodeWav } from "../src/shared/audio/pcm";

function wavOf(samples: number[], sampleRate = 24000): Uint8Array {
  return encodeWav(Int16Array.from(samples), sampleRate);
}

test("無音は空配列", () => {
  assert.deepEqual(buildVolumeEnvelope(wavOf(new Array(2400).fill(0))), []);
});

test("20ms スライスに分かれ最大が 1 に正規化される", () => {
  // 100ms / 24kHz = 2400 サンプル、20ms = 480 サンプル → 5 スライス
  const env = buildVolumeEnvelope(wavOf(new Array(2400).fill(1000)));
  assert.equal(env.length, 5);
  assert.equal(Math.max(...env), 1);
});

test("後半だけ大きい音はスライスごとに差が出る", () => {
  const samples = [...new Array(1200).fill(200), ...new Array(1200).fill(2000)];
  const env = buildVolumeEnvelope(wavOf(samples));
  assert.equal(env.length, 5);
  assert.ok(env[0] < env[4]);
  assert.equal(env[4], 1);
});

test("壊れた WAV は空配列", () => {
  assert.deepEqual(buildVolumeEnvelope(new Uint8Array([1, 2, 3])), []);
});
