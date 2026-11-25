import test from "node:test";
import assert from "node:assert/strict";
import { VadEngine } from "../src/shared/audio/vad";
import {
  buildClientVadSettings,
  buildVadSettings,
  type VadConfigSource,
} from "../src/shared/audio/vadSettings";

/** 既定値に近い入力（秒指定の項目を含む） */
const SOURCE: VadConfigSource = {
  sample_rate: 16000,
  frame_ms: 20,
  pre_roll_ms: 200,
  silence_threshold: 0.02,
  silence_duration: 0.8,
  smoothing_alpha: 0.3,
  relative_threshold_multiplier: 3,
  silence_threshold_max: 0.06,
  calibration_duration: 0.5,
  debounce_frames: 2,
  input_gain: 1.5,
};

test("buildVadSettings は秒指定を ms に直す", () => {
  const settings = buildVadSettings(SOURCE);
  assert.equal(settings.silenceDurationMs, 800);
  assert.equal(settings.calibrationMs, 500);
  assert.equal(settings.sampleRate, 16000);
  assert.equal(settings.maxSilenceThreshold, 0.06);
});

test("hello 用の設定はサーバー用から sampleRate としきい値を除いた同値", () => {
  const server = buildVadSettings(SOURCE);
  const client = buildClientVadSettings(SOURCE);
  assert.deepEqual(client, {
    frameMs: server.frameMs,
    preRollMs: server.preRollMs,
    silenceDurationMs: server.silenceDurationMs,
    smoothingAlpha: server.smoothingAlpha,
    relativeThresholdMultiplier: server.relativeThresholdMultiplier,
    maxSilenceThreshold: SOURCE.silence_threshold_max,
    calibrationMs: server.calibrationMs,
    debounceFrames: server.debounceFrames,
    inputGain: server.inputGain,
  });
});

test("同じフレーム列ならサーバーとブラウザで同じ判定になる", () => {
  const frameSamples = Math.round((SOURCE.sample_rate * SOURCE.frame_ms) / 1000);
  const frames: Int16Array[] = [];
  for (let i = 0; i < 60; i += 1) {
    const amplitude = i >= 10 && i < 40 ? 1200 : 30;
    frames.push(new Int16Array(frameSamples).fill(amplitude));
  }

  const options = { maxDurationMs: 5000, startTimeoutMs: 1000 };
  const server = new VadEngine(buildVadSettings(SOURCE), options);
  const browser = new VadEngine(
    {
      ...buildClientVadSettings(SOURCE),
      sampleRate: SOURCE.sample_rate,
      silenceThreshold: SOURCE.silence_threshold,
    },
    options
  );

  const serverKinds = frames.map((frame) => server.push(frame).kind);
  const browserKinds = frames.map((frame) => browser.push(frame).kind);
  assert.deepEqual(browserKinds, serverKinds);
});
