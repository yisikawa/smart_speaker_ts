import test from "node:test";
import assert from "node:assert/strict";
import { PromptBuilder } from "../src/backend/conversation/PromptBuilder";
import { CharacterService } from "../src/backend/services/CharacterService";
import { createTempProject } from "./helpers/project";

test("CharacterService は TOML の人格・応答ルール・口癖を読み込む", () => {
  const project = createTempProject({ prefix: "sumika-char-", copyConfig: true });
  try {
    const config = project.config;
    const character = new CharacterService({ config }).get();

    assert.equal(character.name, "さくら");
    assert.ok(character.personality.includes("明るく"));
    assert.ok(character.responseRules.includes("3文以内"));
    assert.ok(character.catchphrases.length > 0);
  } finally {
    project.cleanup();
  }
});

test("キャラクターファイルが無い場合は既定プロファイルにフォールバックする", () => {
  const project = createTempProject({ prefix: "sumika-char-", copyConfig: true });
  try {
    const config = project.config;
    config.update({ llm: { character_file: "config/characters/missing.toml" } });

    const character = new CharacterService({ config }).get();
    assert.equal(character.name, "アシスタント");
    assert.deepEqual(character.catchphrases, []);
  } finally {
    project.cleanup();
  }
});

test("PromptBuilder は人格・応答ルール・ユーザー名・日時を含む", () => {
  const project = createTempProject({ prefix: "sumika-char-", copyConfig: true });
  try {
    const config = project.config;
    const prompt = new PromptBuilder({
      config,
      character: {
        get: () => ({
          name: "テストちゃん",
          label: "テスト",
          personality: "とても元気な性格。",
          responseRules: "- ひとことで答える",
          catchphrases: ["やっほー"],
        }),
      },
    }).build();

    assert.match(prompt, /テストちゃん/);
    assert.match(prompt, /とても元気な性格。/);
    assert.match(prompt, /- ひとことで答える/);
    assert.match(prompt, /やっほー/);
    assert.match(prompt, /ユーザー名: /);
    assert.match(prompt, /現在の日時: \d{4}\/\d{2}\/\d{2}/);
    assert.match(prompt, /日本語/);
    // 言語の固定（先頭と末尾の両方に置く）
    assert.match(prompt, /【最重要】応答は必ず日本語で書くこと/);
    assert.match(prompt, /ハングル/);
    assert.ok(
      prompt.trimEnd().endsWith("- 日本語以外の言語（韓国語・中国語・英語など）の文字は使わないこと"),
      "末尾にも言語指定が必要"
    );
  } finally {
    project.cleanup();
  }
});
