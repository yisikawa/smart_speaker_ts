import test from "node:test";
import assert from "node:assert/strict";
import { parseStageOptions } from "../src/shared/ui/stageMode";

test("既定はチャットモード", () => {
  assert.deepEqual(parseStageOptions(""), { mode: "chat", transparent: false });
  assert.deepEqual(parseStageOptions("?"), { mode: "chat", transparent: false });
});

test("mode=stage を読む", () => {
  assert.deepEqual(parseStageOptions("?mode=stage"), { mode: "stage", transparent: false });
});

test("transparent=1 を読む", () => {
  assert.deepEqual(parseStageOptions("?mode=stage&transparent=1"), { mode: "stage", transparent: true });
  assert.deepEqual(parseStageOptions("?transparent=true"), { mode: "chat", transparent: true });
});

test("未知の値は既定へ落とす", () => {
  assert.deepEqual(parseStageOptions("?mode=bogus&transparent=yes"), {
    mode: "chat",
    transparent: false,
  });
});
