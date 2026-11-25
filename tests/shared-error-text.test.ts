import test from "node:test";
import assert from "node:assert/strict";
import { errorText } from "../src/shared/errorText";

test("Error は message を返す", () => {
  assert.equal(errorText(new Error("マイクを開けませんでした")), "マイクを開けませんでした");
});

test("Error 以外は String 化する", () => {
  assert.equal(errorText("そのまま"), "そのまま");
  assert.equal(errorText(undefined), "undefined");
  assert.equal(errorText(42), "42");
});

test("Error 以外のオブジェクト・null・サブクラスの扱いを固定する", () => {
  // 旧実装（?.message を優先）からの意図的な差分。表示は Error のみを想定する
  assert.equal(errorText({ message: "x" }), "[object Object]");
  assert.equal(errorText(null), "null");

  class MicError extends Error {}
  assert.equal(errorText(new MicError("マイク失敗")), "マイク失敗");
});
