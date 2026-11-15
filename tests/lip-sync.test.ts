import test from "node:test";
import assert from "node:assert/strict";
import { mouthLevelAt } from "../src/shared/avatar/lipSync";

test("音量列が空なら 0", () => {
  assert.equal(mouthLevelAt([], 20, 100), 0);
});

test("再生時刻のスライス値を返す", () => {
  const volumes = [0.2, 0.6, 1];
  assert.equal(mouthLevelAt(volumes, 20, 0), 0.2);
  assert.equal(mouthLevelAt(volumes, 20, 20), 0.6);
  assert.equal(mouthLevelAt(volumes, 20, 40), 1);
});

test("スライスの間は線形補間する", () => {
  const volumes = [0, 1];
  assert.equal(mouthLevelAt(volumes, 20, 10), 0.5);
});

test("末尾を超えたら 0（口を閉じる）", () => {
  assert.equal(mouthLevelAt([1, 1], 20, 1000), 0);
});

test("smoothing で前回値から追従する", () => {
  assert.equal(mouthLevelAt([1], 20, 0, { previous: 0, smoothing: 0.5 }), 0.5);
  assert.equal(mouthLevelAt([1], 20, 0, { previous: 0.5, smoothing: 1 }), 1);
  assert.equal(mouthLevelAt([1], 20, 0, { previous: 0.5, smoothing: 0 }), 0.5);
});

test("値は 0..1 に収まる", () => {
  assert.equal(mouthLevelAt([2], 20, 0), 1);
  assert.equal(mouthLevelAt([-1], 20, 0), 0);
});
