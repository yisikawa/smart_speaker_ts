import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigManager } from "../src/backend/config/ConfigManager";
import { PromptBuilder } from "../src/backend/conversation/PromptBuilder";
import { CharacterService } from "../src/backend/services/CharacterService";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/** 実際の設定・キャラクター定義をコピーした一時プロジェクトを作る */
function withTempProject(): { rootDir: string; cleanup: () => void } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumika-char-"));
  fs.cpSync(path.join(PROJECT_ROOT, "config"), path.join(rootDir, "config"), { recursive: true });
  return { rootDir, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

test("CharacterService は TOML の人格・応答ルール・口癖を読み込む", () => {
  const project = withTempProject();
  try {
    const config = new ConfigManager({ rootDir: project.rootDir });
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
  const project = withTempProject();
  try {
    const config = new ConfigManager({ rootDir: project.rootDir });
    config.update({ llm: { character_file: "config/characters/missing.toml" } });

    const character = new CharacterService({ config }).get();
    assert.equal(character.name, "アシスタント");
    assert.deepEqual(character.catchphrases, []);
  } finally {
    project.cleanup();
  }
});

test("PromptBuilder は人格・応答ルール・ユーザー名・日時を含む", () => {
  const project = withTempProject();
  try {
    const config = new ConfigManager({ rootDir: project.rootDir });
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
  } finally {
    project.cleanup();
  }
});
