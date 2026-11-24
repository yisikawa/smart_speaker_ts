import test from "node:test";
import assert from "node:assert/strict";
import { CharacterService } from "../src/backend/services/CharacterService";
import { TtsRouter } from "../src/backend/services/TtsRouter";
import { createTempProject } from "./helpers/project";

test("既定は日本語モードで、STT は [stt] の値を使う", () => {
  const project = createTempProject();
  try {
    assert.equal(project.config.getLanguage(), "ja");
    assert.equal(project.config.getSTT().language, "ja");
  } finally {
    project.cleanup();
  }
});

test("英語モードでは [stt.en] が上書きとして合成される", () => {
  const project = createTempProject({
    patch: {
      conversation: { language: "en" },
      stt: { language: "ja", engine: "sherpa", en: { engine: "whisper", language: "en" } },
    },
  });
  try {
    const stt = project.config.getSTT();
    assert.equal(stt.engine, "whisper");
    assert.equal(stt.language, "en");
    // 未指定のキーは日本語モードの値が残る
    assert.equal(stt.sherpa_model_type, project.config.get().stt.sherpa_model_type);
    // 日本語モードへ戻すと元の値
    project.config.update({ conversation: { language: "ja" } });
    assert.equal(project.config.getSTT().engine, "sherpa");
    assert.equal(project.config.getSTT().language, "ja");
  } finally {
    project.cleanup();
  }
});

test("TtsRouter は言語モードで実装を切り替える", () => {
  const project = createTempProject({
    patch: { tts: { en: { engine: "openai_speech", model: "kokoro", voice: "af_heart" } } },
  });
  try {
    const router = new TtsRouter({ config: project.config });
    assert.match(router.describe(), /^voicevox:/);
    assert.equal(router.reconfigure(), false, "変更が無ければ作り直さない");

    project.config.update({ conversation: { language: "en" } });
    assert.equal(router.reconfigure(), true);
    assert.equal(router.describe(), "openai_speech:kokoro/af_heart");

    project.config.update({ tts: { en: { engine: "gpt_sovits", reference_wav: "assets/voices/ref.wav" } } });
    assert.equal(router.reconfigure(), true);
    assert.equal(router.describe(), "gpt_sovits:assets/voices/ref.wav");
  } finally {
    project.cleanup();
  }
});

test("CharacterService は英語用のキャラクター定義を読み分ける", () => {
  const project = createTempProject({ copyConfig: true });
  try {
    const character = new CharacterService({ config: project.config });
    assert.equal(character.get("ja").name, "さくら");
    assert.equal(character.get("en").name, "Sakura");
    assert.notEqual(character.get("en").personality, character.get("ja").personality);
  } finally {
    project.cleanup();
  }
});
