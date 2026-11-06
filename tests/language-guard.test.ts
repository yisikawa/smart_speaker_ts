import test from "node:test";
import assert from "node:assert/strict";
import { containsHangul, LANGUAGE_RETRY_INSTRUCTION } from "../src/backend/conversation/languageGuard";

test("containsHangul はハングルだけを検出する", () => {
  assert.equal(containsHangul("음, 당연히 잘 돌아가고 있지!"), true);
  assert.equal(containsHangul("日本語の応答です。"), false);
  assert.equal(containsHangul("漢字とひらがなとカタカナ、OK!"), false);
  assert.equal(containsHangul(""), false);
});

test("再生成用の指示は日本語を明示する", () => {
  assert.match(LANGUAGE_RETRY_INSTRUCTION, /日本語/);
  assert.match(LANGUAGE_RETRY_INSTRUCTION, /ハングル/);
});
