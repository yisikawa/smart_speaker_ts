import test from "node:test";
import assert from "node:assert/strict";
import { buildAvatarPayload } from "../src/backend/server/avatarPayload";
import { buildHelloPayload } from "../src/backend/server/helloPayload";
import { buildClientVadSettings } from "../src/shared/audio/vadSettings";
import { createTempProject } from "./helpers/project";

test("hello の audio.vad は buildClientVadSettings と一致する", () => {
  const project = createTempProject();
  try {
    const audio = project.config.getAudio();
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
      conversation: project.config.getConversation(),
    });
    assert.deepEqual(payload.audio.vad, buildClientVadSettings(audio));
  } finally {
    project.cleanup();
  }
});

test("hello の audio は従来と同じキーを持つ", () => {
  const project = createTempProject();
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
      isPrimary: false,
      audio: project.config.getAudio(),
      conversation: project.config.getConversation(),
    });
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
    assert.equal(payload.audio.isPrimary, false);
  } finally {
    project.cleanup();
  }
});
