import test from "node:test";
import assert from "node:assert/strict";
import { ConversationHistory } from "../src/backend/conversation/ConversationHistory";

test("maxTurns を超えた履歴は古いものから捨てられる", () => {
  const history = new ConversationHistory(2);

  history.add("user", "u1");
  history.add("assistant", "a1");
  history.add("user", "u2");
  history.add("assistant", "a2");
  history.add("user", "u3");
  history.add("assistant", "a3");

  assert.equal(history.length, 4);
  assert.deepEqual(
    history.all().map((message) => message.content),
    ["u2", "a2", "u3", "a3"]
  );
});

test("forPrompt は先頭の assistant を落とし、role と content のみ返す", () => {
  const history = new ConversationHistory(10);
  history.add("assistant", "最初の挨拶");
  history.add("user", "こんにちは");
  history.add("assistant", "やあ");

  assert.deepEqual(history.forPrompt(), [
    { role: "user", content: "こんにちは" },
    { role: "assistant", content: "やあ" },
  ]);
});

test("空文字のメッセージはプロンプトに含めない", () => {
  const history = new ConversationHistory(10);
  history.add("user", "テスト");
  history.add("assistant", "   ");

  assert.deepEqual(history.forPrompt(), [{ role: "user", content: "テスト" }]);
});

test("setMaxTurns(0) は履歴を空にする", () => {
  const history = new ConversationHistory(3);
  history.add("user", "a");
  history.add("assistant", "b");

  history.setMaxTurns(0);
  assert.equal(history.length, 0);
});
