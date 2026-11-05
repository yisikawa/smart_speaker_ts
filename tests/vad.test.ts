import test from "node:test";
import assert from "node:assert/strict";
import { VadSettings } from "../src/backend/core/ports";
import { VadEngine } from "../src/shared/audio/vad";

const SETTINGS: VadSettings = {
  sampleRate: 16000,
  frameMs: 20,
  preRollMs: 100,
  silenceThreshold: 0.02,
  silenceDurationMs: 200,
  smoothingAlpha: 1,
  relativeThresholdMultiplier: 3,
  calibrationMs: 0,
  debounceFrames: 1,
  inputGain: 1,
};

const FRAME_SAMPLES = Math.round((SETTINGS.sampleRate * SETTINGS.frameMs) / 1000); // 320

function silentFrame(): Int16Array {
  return new Int16Array(FRAME_SAMPLES);
}

function loudFrame(amplitude = 8000): Int16Array {
  const frame = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < frame.length; i++) {
    frame[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return frame;
}

test("無音が続くと no_speech で終了し、PCM は空になる", () => {
  const engine = new VadEngine(SETTINGS, { maxDurationMs: 5000, startTimeoutMs: 300 });

  let decision = engine.push(silentFrame());
  for (let i = 0; i < 100 && decision.kind !== "finish"; i++) {
    decision = engine.push(silentFrame());
  }

  assert.equal(decision.kind, "finish");
  assert.equal(decision.kind === "finish" ? decision.reason : "", "no_speech");
  assert.equal(engine.hasSpeech, false);
  assert.equal(engine.collectedPcm().length, 0);
});

test("発話 → 無音で silence 終了し、プリロールを含む PCM が得られる", () => {
  const engine = new VadEngine(SETTINGS, { maxDurationMs: 5000 });

  // 無音 5 フレーム（プリロール 100ms）
  for (let i = 0; i < 5; i++) {
    assert.equal(engine.push(silentFrame()).kind, "continue");
  }

  let speechStarted = false;
  for (let i = 0; i < 5; i++) {
    if (engine.push(loudFrame()).kind === "speech_start") {
      speechStarted = true;
    }
  }
  assert.ok(speechStarted, "発話開始が検出されること");

  let decision = engine.push(silentFrame());
  for (let i = 0; i < 30 && decision.kind !== "finish"; i++) {
    decision = engine.push(silentFrame());
  }

  assert.equal(decision.kind, "finish");
  assert.equal(decision.kind === "finish" ? decision.reason : "", "silence");
  assert.equal(engine.hasSpeech, true);

  const pcm = engine.collectedPcm();
  // プリロール 5 + 発話 5 + 無音 10 フレーム以上が含まれる
  assert.ok(pcm.length >= FRAME_SAMPLES * 15, `samples=${pcm.length}`);
});

test("最大録音時間を超えると max_duration で終了する", () => {
  const engine = new VadEngine(SETTINGS, { maxDurationMs: 200 });

  let decision = engine.push(loudFrame());
  for (let i = 0; i < 20 && decision.kind !== "finish"; i++) {
    decision = engine.push(loudFrame());
  }

  assert.equal(decision.kind, "finish");
  assert.equal(decision.kind === "finish" ? decision.reason : "", "max_duration");
});

test("キャリブレーション中の暗騒音より下の音は発話と判定しない", () => {
  const engine = new VadEngine(
    { ...SETTINGS, calibrationMs: 100, silenceThreshold: 0.001, relativeThresholdMultiplier: 4 },
    { maxDurationMs: 1000, startTimeoutMs: 400 }
  );

  // 暗騒音（RMS 約 0.061）
  for (let i = 0; i < 5; i++) {
    engine.push(loudFrame(2000));
  }

  // 暗騒音より小さい音（RMS 約 0.031）はしきい値を超えない
  for (let i = 0; i < 10; i++) {
    engine.push(loudFrame(1000));
  }
  assert.equal(engine.hasSpeech, false);
  assert.ok(engine.threshold > 0.061, `threshold=${engine.threshold}`);
});

test("frames / peakLevel を集計する", () => {
  const engine = new VadEngine(SETTINGS, { maxDurationMs: 1000 });

  engine.push(loudFrame());
  engine.push(silentFrame());

  assert.equal(engine.frames, 2);
  assert.ok(engine.peakLevel > 0.2, `peak=${engine.peakLevel}`);
});

test("finish は中断理由を返し、以降のフレームを無視する", () => {
  const engine = new VadEngine(SETTINGS, { maxDurationMs: 5000 });

  const decision = engine.finish("aborted");
  assert.equal(decision.kind, "finish");
  assert.equal(decision.kind === "finish" ? decision.reason : "", "aborted");

  const after = engine.push(loudFrame());
  assert.equal(after.kind, "finish");
  assert.equal(after.kind === "finish" ? after.reason : "", "aborted");
});
