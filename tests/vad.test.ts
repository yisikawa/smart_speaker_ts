import test from "node:test";
import assert from "node:assert/strict";
import { VadSettings } from "../src/backend/core/ports";
import { splitInt16Frames } from "../src/shared/audio/pcm";
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
    { ...SETTINGS, calibrationMs: 100, silenceThreshold: 0.02, relativeThresholdMultiplier: 4, maxSilenceThreshold: 0.1 },
    { maxDurationMs: 1000, startTimeoutMs: 400 }
  );

  // 暗騒音（RMS 約 0.024）: 環境音として学習され、しきい値は 0.024 × 4 = 0.096 になる
  for (let i = 0; i < 5; i++) {
    engine.push(loudFrame(800));
  }

  // 暗騒音より大きいが、しきい値より小さい音（RMS 約 0.031）は発話と判定しない
  for (let i = 0; i < 10; i++) {
    engine.push(loudFrame(1000));
  }
  assert.equal(engine.hasSpeech, false);
  assert.ok(engine.threshold > 0.031, `threshold=${engine.threshold}`);
});

test("frames / peakLevel を集計する", () => {
  const engine = new VadEngine(SETTINGS, { maxDurationMs: 1000 });

  engine.push(loudFrame());
  engine.push(silentFrame());

  assert.equal(engine.frames, 2);
  assert.ok(engine.peakLevel > 0.2, `peak=${engine.peakLevel}`);
});

test("128 サンプルずつ届いても VAD が発話を検出する（AudioWorklet 回帰テスト）", () => {
  const engine = new VadEngine(SETTINGS, { maxDurationMs: 3000 });
  const chunk = new Int16Array(128);
  for (let i = 0; i < chunk.length; i++) {
    chunk[i] = i % 2 === 0 ? 8000 : -8000;
  }

  let pending: Int16Array = new Int16Array(0);
  let speech = false;
  for (let i = 0; i < 40 && !speech; i++) {
    const { frames, remainder } = splitInt16Frames(pending, chunk, engine.frameSamples);
    pending = remainder;
    for (const frame of frames) {
      if (engine.push(frame).kind === "speech_start") {
        speech = true;
      }
    }
  }

  assert.equal(speech, true, "128 サンプル単位でも 20ms フレームを組み立てて検出できること");
  assert.ok(engine.frames > 0);
});

test("較正は中央値を使うため、一発の物音ではしきい値が跳ね上がらない", () => {
  const engine = new VadEngine(
    {
      ...SETTINGS,
      calibrationMs: 100, // 5 フレーム
      silenceThreshold: 0.02,
      relativeThresholdMultiplier: 2,
      maxSilenceThreshold: 0.06,
    },
    { maxDurationMs: 1000, startTimeoutMs: 500 }
  );

  // 4 フレーム無音 + 1 フレームだけ大きな物音（タイピング等を想定）
  for (let i = 0; i < 4; i++) {
    engine.push(silentFrame());
  }
  engine.push(loudFrame(16000));

  // 中央値は 0 なので、しきい値は絶対値の 0.02 に留まる（最大値を使うと 0.06 まで跳ね上がる）
  assert.ok(engine.threshold <= 0.021, `threshold=${engine.threshold}`);
});

test("暗騒音が大きい環境でもしきい値は上限（silence_threshold_max）を超えない", () => {
  const engine = new VadEngine(
    {
      ...SETTINGS,
      calibrationMs: 100,
      silenceThreshold: 0.02,
      relativeThresholdMultiplier: 4,
      maxSilenceThreshold: 0.06,
    },
    { maxDurationMs: 1000, startTimeoutMs: 500 }
  );

  // 環境音として妥当な範囲（RMS 約 0.024）→ 0.024 × 4 = 0.096 だが上限 0.06 でクランプされる
  for (let i = 0; i < 8; i++) {
    engine.push(loudFrame(800));
  }

  assert.ok(engine.threshold <= 0.0601, `threshold=${engine.threshold}`);
  assert.ok(engine.threshold > 0.02, `threshold=${engine.threshold}`);
});

test("較正中に発話（大きな音）が入っても、しきい値は発話レベルまで跳ね上がらない", () => {
  const engine = new VadEngine(
    {
      ...SETTINGS,
      calibrationMs: 100,
      silenceThreshold: 0.02,
      relativeThresholdMultiplier: 2,
      maxSilenceThreshold: 0.06,
    },
    { maxDurationMs: 2000, startTimeoutMs: 1000 }
  );

  // マイクを開いた瞬間から話している状態（較正がすべて発話レベル）
  for (let i = 0; i < 5; i++) {
    engine.push(loudFrame(4000)); // RMS 約 0.12
  }

  // 環境音として学習しないため、しきい値は絶対値のまま（= 発話を検出できる）
  assert.ok(engine.threshold <= 0.021, `threshold=${engine.threshold}`);
});

test("タイピングのような単発音では発話を開始しない（debounce 3 フレーム）", () => {
  const engine = new VadEngine(
    { ...SETTINGS, debounceFrames: 3, calibrationMs: 0 },
    { maxDurationMs: 2000, startTimeoutMs: 1000 }
  );

  // 単発の物音（1 フレーム = 20ms）→ 発話開始しない
  engine.push(loudFrame());
  engine.push(silentFrame());
  assert.equal(engine.hasSpeech, false);

  // 連続 3 フレーム（60ms）続けば発話と判定する
  let started = false;
  for (let i = 0; i < 5; i++) {
    if (engine.push(loudFrame()).kind === "speech_start") {
      started = true;
    }
  }
  assert.equal(started, true);
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
