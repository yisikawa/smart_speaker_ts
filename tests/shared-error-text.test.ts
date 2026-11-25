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
