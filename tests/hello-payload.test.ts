import test from "node:test";
import assert from "node:assert/strict";
import { buildAvatarPayload } from "../src/backend/server/avatarPayload";
import { buildHelloPayload } from "../src/backend/server/helloPayload";
import { createTempProject } from "./helpers/project";

/** 値の取り違え・*1000 漏れが即座に分かる非対称な設定 */
function fixtures() {
  const project = createTempProject();
  const audio = {
    ...project.config.getAudio(),
    sample_rate: 16000,
    frame_ms: 21,
    pre_roll_ms: 300,
    silence_threshold: 0.02,
    silence_duration: 1.25,
    smoothing_alpha: 0.1,
    relative_threshold_multiplier: 3,
    silence_threshold_max: 0.06,
    calibration_duration: 0.5,
    debounce_frames: 2,
    input_gain: 1,
    no_speech_timeout: 7,
    max_record_seconds: 31,
  };
  const conversation = {
    ...project.config.getConversation(),
    followup_enabled: true,
    max_followup_turns: 4,
    followup_timeout_seconds: 9,
    followup_guard_ms: 250,
    keep_listening: true,
    barge_in_enabled: true,
    barge_in_min_score: 0.11,
  };
  return { project, audio, conversation };
}

test("hello の audio.vad は設定値から正しく換算される", () => {
  const { project, audio, conversation } = fixtures();
  try {
    const payload = buildHelloPayload({
      state: "idle",
      history: [],
      character: { name: "さくら", label: "テスト" },
      language: "ja",
      user: "あなた",
      version: "0.0.0",
      services: { llm: true, tts: true, stt: true },
      models: { stt: { engine: "whisper", label: "whisper" }, llm: { model: "test" } },
      avatar: buildAvatarPayload(project.config.getAvatar(), []),
      isPrimary: true,
      audio,
      conversation,
    });
    assert.deepEqual(payload.audio.vad, {
      frameMs: 21,
      preRollMs: 300,
      silenceDurationMs: 1250,
      smoothingAlpha: 0.1,
      relativeThresholdMultiplier: 3,
      maxSilenceThreshold: 0.06,
      calibrationMs: 500,
      debounceFrames: 2,
      inputGain: 1,
    });
  } finally {
    project.cleanup();
  }
});

test("hello の audio と トップレベルは設定値・入力値をそのまま反映する", () => {
  const { project, audio, conversation } = fixtures();
  try {
    const avatar = buildAvatarPayload(project.config.getAvatar(), []);
    const payload = buildHelloPayload({
      state: "thinking",
      history: [{ role: "user", content: "こんにちは", at: 1 }],
      character: { name: "さくら", label: "テスト" },
      language: "en",
      user: "tester",
      version: "9.9.9",
      services: { llm: false, tts: true, stt: false },
      models: { stt: { engine: "sherpa", label: "sherpa" }, llm: { model: "m" } },
      avatar,
      isPrimary: false,
      audio,
      conversation,
    });

    assert.equal(payload.state, "thinking");
    assert.equal(payload.user, "tester");
    assert.equal(payload.language, "en");
    assert.equal(payload.version, "9.9.9");
    assert.deepEqual(payload.character, { name: "さくら", label: "テスト" });
    assert.deepEqual(payload.services, { llm: false, tts: true, stt: false });
    assert.deepEqual(payload.models, {
      stt: { engine: "sherpa", label: "sherpa" },
      llm: { model: "m" },
    });
    assert.equal(payload.avatar, avatar);
    assert.equal(payload.history.length, 1);

    assert.equal(payload.audio.isPrimary, false);
    assert.equal(payload.audio.sampleRate, 16000);
    assert.equal(payload.audio.noSpeechTimeoutMs, 7000);
    assert.equal(payload.audio.maxRecordMs, 31000);
    assert.equal(payload.audio.silenceThreshold, 0.02);
    assert.deepEqual(payload.audio.followup, {
      enabled: true,
      maxTurns: 4,
      timeoutMs: 9000,
      guardMs: 250,
      keepListening: true,
    });
    assert.deepEqual(payload.audio.bargeIn, { enabled: true, minScore: 0.11 });
    assert.deepEqual(Object.keys(payload.audio).sort(), [
      "bargeIn",
      "followup",
      "inputMode",
      "isPrimary",
      "maxRecordMs",
      "noSpeechTimeoutMs",
      "outputVolume",
      "playbackTarget",
      "sampleRate",
      "silenceThreshold",
      "vad",
    ]);
  } finally {
    project.cleanup();
  }
});
