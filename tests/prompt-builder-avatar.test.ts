import test from "node:test";
import assert from "node:assert/strict";
import { PromptBuilder } from "../src/backend/conversation/PromptBuilder";
import { createTempProject } from "./helpers/project";

function build(emotionTags: boolean): string {
  const project = createTempProject({ patch: { avatar: { emotion_tags_enabled: emotionTags } } });
  try {
    return new PromptBuilder({
      config: project.config,
      character: {
        get: () => ({
          name: "さくら",
          label: "さくら",
          personality: "明るい",
          responseRules: "- 簡潔に",
          catchphrases: [],
        }),
      },
    }).build();
  } finally {
    project.cleanup();
  }
}

test("感情タグの語彙を入れる（有効時）", () => {
  const prompt = build(true);
  assert.ok(prompt.includes("[喜]"));
  assert.ok(prompt.includes("感情表現"));
});

test("無効時は語彙を入れない", () => {
  const prompt = build(false);
  assert.ok(!prompt.includes("[喜]"));
  assert.ok(!prompt.includes("感情表現"));
});
