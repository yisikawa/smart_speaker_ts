import test from "node:test";
import assert from "node:assert/strict";
import { parseStageOptions } from "../src/shared/ui/stageMode";

test("既定は studio（キャラクター + 左下チャット）", () => {
  assert.deepEqual(parseStageOptions(""), { mode: "studio", transparent: false });
  assert.deepEqual(parseStageOptions("?"), { mode: "studio", transparent: false });
});

test("mode=chat / stage / studio を読む", () => {
  assert.deepEqual(parseStageOptions("?mode=chat"), { mode: "chat", transparent: false });
  assert.deepEqual(parseStageOptions("?mode=stage"), { mode: "stage", transparent: false });
  assert.deepEqual(parseStageOptions("?mode=studio"), { mode: "studio", transparent: false });
});

test("transparent=1 を読む", () => {
  assert.deepEqual(parseStageOptions("?mode=stage&transparent=1"), { mode: "stage", transparent: true });
  assert.deepEqual(parseStageOptions("?transparent=true"), { mode: "studio", transparent: true });
});

test("未知の値は既定（studio）へ落とす", () => {
  assert.deepEqual(parseStageOptions("?mode=bogus&transparent=yes"), {
    mode: "studio",
    transparent: false,
  });
});
