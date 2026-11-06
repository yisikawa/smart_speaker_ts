import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "toml";
import { ConfigManager } from "../src/backend/config/ConfigManager";
import { deepMerge } from "../src/backend/config/merge";
import { sanitizeConfig } from "../src/backend/config/sanitize";
import { AppConfig, DEFAULT_CONFIG } from "../src/backend/config/schema";
import { stringifyToml } from "../src/backend/config/tomlSerializer";
import { createTempDir } from "./helpers/project";

function tempDir(): string {
  return createTempDir("sumika-cfg-").dir;
}

function clone(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
}

test("deepMerge はネスト設定を部分上書きし、配列は置換する", () => {
  const merged = deepMerge(DEFAULT_CONFIG, {
    tts: { speaker_id: 14 },
    wakeword: { wakeword_path: ["models/a.rpw"] },
  });

  assert.equal(merged.tts.speaker_id, 14);
  assert.equal(merged.tts.speed, DEFAULT_CONFIG.tts.speed, "未指定の項目は既定値のまま");
  assert.deepEqual(merged.wakeword.wakeword_path, ["models/a.rpw"]);
  assert.equal(DEFAULT_CONFIG.tts.speaker_id, 2, "元の設定は変更されない");
});

test("stringifyToml は DEFAULT_CONFIG を往復変換できる", () => {
  const text = stringifyToml(DEFAULT_CONFIG as unknown as Record<string, unknown>);
  // toml パーサは null プロトタイプのオブジェクトを返すため JSON 経由で正規化して比較する
  const parsed = JSON.parse(JSON.stringify(parseToml(text))) as unknown;

  assert.deepEqual(parsed, JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as unknown);
});

test("stringifyToml は空テーブルを出力しない", () => {
  const text = stringifyToml({
    apps: {
      proactive_speech: {
        categories: { briefing: { enabled: true } },
      },
    },
    empty: { nested: {} },
  });

  assert.equal(/^\[apps\]$/m.test(text), false);
  assert.equal(/^\[apps\.proactive_speech\]$/m.test(text), false);
  assert.equal(/^\[apps\.proactive_speech\.categories\.briefing\]$/m.test(text), true);
  assert.equal(/^\[empty\]$/m.test(text), false);
});

test("sanitizeConfig は範囲外の値を補正し、警告を返す", () => {
  const config = clone();
  config.audio.sample_rate = 999999;
  config.tts.speed = 0;
  config.audio.player = "unknown" as typeof config.audio.player;

  const warnings = sanitizeConfig(config);

  assert.equal(config.audio.sample_rate, 48000);
  assert.equal(config.tts.speed, 0.25);
  assert.equal(config.audio.player, "auto");
  assert.equal(warnings.length, 3, warnings.join(" / "));
});

test("ConfigManager はユーザー設定が無ければ既定値で起動する", () => {
  const dir = tempDir();
  try {
    const manager = new ConfigManager({ rootDir: dir });
    assert.equal(manager.getTTS().speaker_id, DEFAULT_CONFIG.tts.speaker_id);
    assert.equal(manager.getWarnings().length > 0, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update は settings.toml へ保存し、再読み込みで復元できる", () => {
  const dir = tempDir();
  try {
    const manager = new ConfigManager({ rootDir: dir });
    manager.update({
      tts: { speaker_id: 8 },
      conversation: { followup_enabled: false },
    });

    const saved = fs.readFileSync(path.join(dir, "config", "settings.toml"), "utf-8");
    assert.match(saved, /speaker_id = 8/);
    assert.match(saved, /\[conversation\]/);

    const reloaded = new ConfigManager({ rootDir: dir });
    assert.equal(reloaded.getTTS().speaker_id, 8);
    assert.equal(reloaded.getConversation().followup_enabled, false);
    assert.equal(reloaded.getTTS().engine, "voicevox");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePath は rootDir 基準の絶対パスを返す", () => {
  const dir = tempDir();
  try {
    const manager = new ConfigManager({ rootDir: dir });
    assert.equal(manager.resolvePath("models/x.bin"), path.resolve(dir, "models/x.bin"));
    assert.equal(manager.resolvePath(""), "");
    const absolute = path.resolve(dir, "abs.bin");
    assert.equal(manager.resolvePath(absolute), absolute);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getMasked は秘匿情報をマスクする", () => {
  const dir = tempDir();
  try {
    const manager = new ConfigManager({ rootDir: dir });
    manager.update({
      apps: { home_assistant: { base_url: "http://ha.local", token: "secret-token" } },
    });

    const masked = manager.getMasked();
    assert.equal(masked.apps.home_assistant.token, "***");
    assert.equal(masked.apps.home_assistant.base_url, "http://ha.local");
    assert.equal(manager.get().apps.home_assistant.token, "secret-token", "実体は変更されない");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
