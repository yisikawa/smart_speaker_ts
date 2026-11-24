import test from "node:test";
import assert from "node:assert/strict";
import {
  applyGain,
  encodeWav,
  ensureWav,
  isWav,
  rmsLevel,
  wavDurationMs,
} from "../src/backend/services/wav";
import { readWavInfo } from "../src/shared/audio/pcm";

test("encodeWav は 44 バイトのヘッダを付与する", () => {
  const pcm = Buffer.alloc(3200, 1); // 100ms @16kHz / 16bit / モノラル
  const wav = encodeWav(pcm, 16000);

  assert.equal(wav.length, pcm.length + 44);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1, "モノラル");
  assert.equal(wav.readUInt32LE(24), 16000, "サンプリングレート");
  assert.equal(wav.readUInt32LE(40), pcm.length, "data サイズ");
});

test("ensureWav は既存 WAV に二重ヘッダを付けない（再生破損バグの回帰テスト）", () => {
  const once = encodeWav(Buffer.alloc(320, 0), 24000);
  const twice = ensureWav(once, 16000);

  assert.equal(twice.length, once.length);
  assert.ok(isWav(twice));
  assert.deepEqual(twice.subarray(0, 4).toString("ascii"), "RIFF");
});

test("isWav は PCM を WAV と判定しない", () => {
  assert.equal(isWav(Buffer.alloc(320, 0)), false);
  assert.equal(isWav(Buffer.alloc(0)), false);
});

test("rmsLevel は無音で 0、最大振幅で 1 になる", () => {
  assert.equal(rmsLevel(Buffer.alloc(320)), 0);

  const loud = Buffer.alloc(320);
  for (let i = 0; i < loud.length; i += 2) {
    loud.writeInt16LE(32767, i);
  }
  assert.ok(rmsLevel(loud) > 0.99);

  const half = Buffer.alloc(320);
  for (let i = 0; i < half.length; i += 2) {
    half.writeInt16LE(16384, i);
  }
  const level = rmsLevel(half);
  assert.ok(level > 0.49 && level < 0.51, `level=${level}`);
});

test("wavDurationMs は byteRate と data サイズから長さを求める", () => {
  const oneSecond = encodeWav(Buffer.alloc(16000 * 2), 16000);
  assert.equal(wavDurationMs(oneSecond), 1000);

  const rawPcm = Buffer.alloc(16000 * 2);
  assert.equal(wavDurationMs(rawPcm, 16000), 1000);
});

test("readWavInfo は fact チャンクが挟まっても data を読める（ffmpeg 対策）", () => {
  const base = encodeWav(Buffer.alloc(640, 1), 16000);
  // data チャンクの直前に fact（12 バイト）を挿入した WAV を作る
  const fact = Buffer.alloc(12);
  fact.write("fact", 0, "ascii");
  fact.writeUInt32LE(4, 4);
  const shifted = Buffer.concat([base.subarray(0, 36), fact, base.subarray(36)]);
  shifted.writeUInt32LE(shifted.length - 8, 4);

  const info = readWavInfo(new Uint8Array(shifted));
  assert.ok(info, "WAV として読める");
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.dataSize, 640, "320 サンプル × 2 バイト");
  assert.equal(wavDurationMs(shifted), 20, "長さが 1ms に壊れない");
});

test("applyGain は振幅をスケーリングし、クリップする", () => {
  const pcm = Buffer.alloc(6);
  pcm.writeInt16LE(1000, 0);
  pcm.writeInt16LE(-1000, 2);
  pcm.writeInt16LE(30000, 4);

  const doubled = applyGain(pcm, 2);
  assert.equal(doubled.readInt16LE(0), 2000);
  assert.equal(doubled.readInt16LE(2), -2000);
  assert.equal(doubled.readInt16LE(4), 32767, "上限でクリップされる");

  assert.equal(applyGain(pcm, 1), pcm, "ゲイン 1 のときは同一バッファを返す");
});
