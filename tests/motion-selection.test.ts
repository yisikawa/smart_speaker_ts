import test from "node:test";
import assert from "node:assert/strict";
import { selectMotionGroup } from "../src/shared/avatar/motionSelection";

const motions = { happy: "M05", angry: "", sad: "M04" };

test("感情キーに対応するグループを返す", () => {
  assert.equal(selectMotionGroup(motions, "happy", null), "M05");
  assert.equal(selectMotionGroup(motions, "happy", "M03"), "M05");
});

test("未設定・空文字・感情なしは再生しない", () => {
  assert.equal(selectMotionGroup(motions, "angry", null), null);
  assert.equal(selectMotionGroup(motions, "surprised", null), null);
  assert.equal(selectMotionGroup(motions, null, null), null);
  assert.equal(selectMotionGroup(motions, undefined, null), null);
});

test("再生中のグループと同じなら再スタートしない", () => {
  assert.equal(selectMotionGroup(motions, "happy", "M05"), null);
  assert.equal(selectMotionGroup(motions, "sad", "M04"), null);
});

test("前後の空白は無視する", () => {
  assert.equal(selectMotionGroup({ happy: " M05 " }, "happy", null), "M05");
});

test("文字列以外のマッピングは無視する", () => {
  const invalid = { happy: 5 } as unknown as Record<string, string>;
  assert.equal(selectMotionGroup(invalid, "happy", null), null);
});
