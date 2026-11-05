import test from "node:test";
import assert from "node:assert/strict";
import {
  applyGain,
  bytesFromBase64,
  bytesToBase64,
  bytesToInt16,
  concatInt16,
  encodeWav,
  int16ToBytes,
  isWav,
  readWavInfo,
  resample,
  rmsLevel,
  splitInt16Frames,
  wavDurationMs,
} from "../src/shared/audio/pcm";

function sine(amplitude: number, length: number): Int16Array {
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return samples;
}

test("encodeWav は 16kHz モノラル 16bit のヘッダを付与する", () => {
  const samples = new Int16Array(16000); // 1 秒
  const wav = encodeWav(samples, 16000);

  assert.equal(wav.length, samples.length * 2 + 44);
  assert.equal(isWav(wav), true);
  assert.deepEqual(readWavInfo(wav), {
    channels: 1,
    sampleRate: 16000,
    bitsPerSample: 16,
    dataSize: samples.length * 2,
  });
  assert.equal(wavDurationMs(wav), 1000);
});

test("isWav / readWavInfo は非 WAV を拒否する", () => {
  const raw = new Uint8Array(100);
  assert.equal(isWav(raw), false);
  assert.equal(readWavInfo(raw), null);
});

test("int16ToBytes / bytesToInt16 は往復変換できる", () => {
  const samples = new Int16Array([0, 1, -1, 32767, -32768, 1234]);
  const bytes = int16ToBytes(samples);

  assert.equal(bytes.length, samples.length * 2);
  assert.deepEqual(Array.from(bytesToInt16(bytes)), Array.from(samples));
});

test("concatInt16 は順序を保って連結する", () => {
  const merged = concatInt16([new Int16Array([1, 2]), new Int16Array([3])]);
  assert.deepEqual(Array.from(merged), [1, 2, 3]);
});

test("splitInt16Frames は端数を次回へ持ち越してフレームを組み立てる", () => {
  const frameSamples = 320;

  // 128 サンプル × 10 = 1280 → 320 サンプル × 4 フレーム、端数なし
  let pending: Int16Array = new Int16Array(0);
  const frames: Int16Array[] = [];
  for (let i = 0; i < 10; i++) {
    const result = splitInt16Frames(pending, new Int16Array(128).fill(i + 1), frameSamples);
    frames.push(...result.frames);
    pending = result.remainder;
  }
  assert.equal(frames.length, 4);
  assert.equal(frames[0].length, frameSamples);
  assert.equal(frames[0][0], 1);
  assert.equal(frames[3][frameSamples - 1], 10);
  assert.equal(pending.length, 0);

  // 128 × 3 = 384 → 1 フレーム + 64 サンプルの端数
  const short = splitInt16Frames(new Int16Array(0), new Int16Array(384), frameSamples);
  assert.equal(short.frames.length, 1);
  assert.equal(short.remainder.length, 64);
});

test("rmsLevel は無音 0・最大振幅 1 になる", () => {
  assert.equal(rmsLevel(new Int16Array(320)), 0);
  assert.ok(rmsLevel(sine(32767, 320)) > 0.99);
  assert.ok(Math.abs(rmsLevel(sine(16384, 320)) - 0.5) < 0.01);
});

test("applyGain は振幅をスケーリングし、クリップする", () => {
  const samples = new Int16Array([1000, -1000, 30000]);
  const doubled = applyGain(samples, 2);

  assert.deepEqual(Array.from(doubled), [2000, -2000, 32767]);
  assert.equal(applyGain(samples, 1), samples);
});

test("resample はサンプル数を比率どおりに変換する", () => {
  const input = sine(1000, 48000); // 48kHz で 1 秒
  const output = resample(input, 48000, 16000);

  assert.equal(output.length, 16000);
  assert.ok(output[0] > 0);
});

test("Base64 は DOM/Node どちらでも往路復路が一致する", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 64]);
  const base64 = bytesToBase64(bytes);

  assert.equal(base64, Buffer.from(bytes).toString("base64"));
  assert.deepEqual(Array.from(bytesFromBase64(base64)), Array.from(bytes));
  assert.deepEqual(Array.from(bytesFromBase64("")), []);
});
