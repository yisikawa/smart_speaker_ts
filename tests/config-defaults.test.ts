import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "toml";
import { UNSUPPORTED_SECTIONS } from "../src/backend/config/ConfigManager";
import { AppConfig, DEFAULT_CONFIG } from "../src/backend/config/schema";
import { PROJECT_ROOT } from "./helpers/project";

/** DEFAULT_CONFIG を { "audio.sample_rate": 16000 } の形へ平坦化する */
function flatten(table: Record<string, unknown>, prefix: string[] = [], out = new Map<string, unknown>()) {
  for (const [key, value] of Object.entries(table)) {
    const keyPath = [...prefix, key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      flatten(value as Record<string, unknown>, keyPath, out);
    } else {
      out.set(keyPath.join("."), value);
    }
  }
  return out;
}

function isUnsupported(keyPath: string): boolean {
  return UNSUPPORTED_SECTIONS.some(
    (section) => keyPath === section || keyPath.startsWith(`${section}.`)
  );
}

/**
 * `config/settings.default.toml` が schema.ts と同期しているか検証する。
 *
 * 以前は手で同期していたため、既定値の変更（`silence_threshold_max` 追加など）が
 * ファイルへ反映されずに陳腐化した。ここで乖離を検出する。
 * 直すときは `npm run config:default`（コメントを保ったまま同期）を実行する。
 */
test("settings.default.toml は schema.ts の既定値と一致する", () => {
  const file = path.join(PROJECT_ROOT, "config", "settings.default.toml");
  const parsed = parseToml(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  const actual = flatten(parsed);
  const expected = flatten(DEFAULT_CONFIG as unknown as Record<string, unknown>);

  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const [keyPath, value] of expected) {
    if (isUnsupported(keyPath)) {
      continue; // 未実装セクションは既定ファイルに書かない
    }
    if (!actual.has(keyPath)) {
      missing.push(keyPath);
    } else if (JSON.stringify(actual.get(keyPath)) !== JSON.stringify(value)) {
      mismatched.push(`${keyPath}: file=${JSON.stringify(actual.get(keyPath))} schema=${JSON.stringify(value)}`);
    }
  }

  assert.deepEqual(missing, [], `settings.default.toml に不足: ${missing.join(", ")}（npm run config:default）`);
  assert.deepEqual(mismatched, [], `settings.default.toml の値が既定値と不一致: ${mismatched.join(" / ")}`);
});

test("未実装セクションは README / DESIGN と一致する一覧で公開される", () => {
  const config = DEFAULT_CONFIG as AppConfig;
  // 一覧に載っているセクションは schema に存在する
  assert.ok(config.wakeword);
  assert.ok(config.rag);
  assert.ok(config.recipe_db);
  assert.ok(config.music);
  assert.ok(config.apps.proactive_speech);
  assert.ok(config.apps.home_assistant);
  assert.deepEqual([...UNSUPPORTED_SECTIONS], [
    "wakeword",
    "rag",
    "recipe_db",
    "music",
    "apps.proactive_speech",
    "apps.home_assistant",
  ]);
});
