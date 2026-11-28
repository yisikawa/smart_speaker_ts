import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runtimeTempDir } from "../src/backend/core/paths";
import { PROJECT_ROOT } from "./helpers/project";

test("runtimeTempDir は C: の %TEMP% ではなくプロジェクト配下の tmp を返す", () => {
  const dir = runtimeTempDir(PROJECT_ROOT);
  assert.equal(dir, path.join(PROJECT_ROOT, "tmp"));
  assert.equal(fs.existsSync(dir), true);
  // 呼び直しても同じ場所（存在していても失敗しない）
  assert.equal(runtimeTempDir(PROJECT_ROOT), dir);
});
