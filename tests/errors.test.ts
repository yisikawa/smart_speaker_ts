import test from "node:test";
import assert from "node:assert/strict";
import { abortError, describeTransportError, errorMessage, isAborted } from "../src/backend/core/errors";

test("isAborted は AbortSignal の状態だけで判定する", () => {
  const controller = new AbortController();
  assert.equal(isAborted(controller.signal), false);
  assert.equal(isAborted(undefined), false);

  controller.abort();
  assert.equal(isAborted(controller.signal), true);
});

test("abortError は AbortError 名のエラーを作る", () => {
  const error = abortError();
  assert.equal(error.name, "AbortError");
  assert.match(error.message, /中断/);

  const custom = abortError("STT が中断されました");
  assert.equal(custom.message, "STT が中断されました");
});

test("errorMessage は Error 以外も文字列化する", () => {
  assert.equal(errorMessage(new Error("失敗")), "失敗");
  assert.equal(errorMessage("失敗"), "失敗");
  assert.equal(errorMessage(42), "42");
});

test("describeTransportError は接続断・接続不可を原因付きメッセージへ変換する", () => {
  const aborted = describeTransportError(new Error("aborted"), "Ollama");
  assert.match(aborted.message, /Ollama との接続が中断されました/);
  assert.match(aborted.message, /aborted/);

  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
    code: "ECONNREFUSED",
  });
  assert.match(describeTransportError(refused, "Ollama").message, /Ollama に接続できません/);

  // 対象外のエラーはそのまま返す
  const other = new Error("想定外");
  assert.equal(describeTransportError(other, "Ollama"), other);
});
