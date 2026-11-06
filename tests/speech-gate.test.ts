import test from "node:test";
import assert from "node:assert/strict";
import { SpeechGate } from "../src/backend/conversation/SpeechGate";

test("SpeechGate は幻聴・短断片を破棄する", () => {
  const gate = new SpeechGate();

  const hallucination = gate.evaluate("ご視聴ありがとうございました。");
  assert.equal(hallucination.kind, "skip");
  assert.equal(hallucination.kind === "skip" ? hallucination.reason : "", "hallucination");

  const short = gate.evaluate("ただ");
  assert.equal(short.kind, "skip");
  assert.equal(short.kind === "skip" ? short.reason : "", "short");

  assert.equal(gate.evaluate("今日はいい天気ですね").kind, "accept");
});

test("SpeechGate は読み上げた応答のエコーを破棄する", () => {
  const gate = new SpeechGate();
  gate.rememberReply("今日はいい天気だよ、散歩でもどう？");

  const echo = gate.evaluate("今日はいい天気だよ");
  assert.equal(echo.kind, "skip");
  assert.equal(echo.kind === "skip" ? echo.reason : "", "echo");

  // 無関係な発話は通す
  assert.equal(gate.evaluate("明日の予定を教えて").kind, "accept");
});

test("SpeechGate は破棄理由ごとの回数と直近の破棄を記録する", () => {
  const gate = new SpeechGate();
  gate.evaluate("ご視聴ありがとうございました。"); // 幻聴
  gate.evaluate("ただ"); // 短断片
  gate.evaluate("今日はいい天気ですね"); // 受理

  assert.deepEqual(gate.stats, { hallucination: 1, short: 1, echo: 0, repeat: 0 });
  assert.equal(gate.lastSkip?.reason, "short");
  assert.match(gate.lastSkip?.text ?? "", /ただ/);

  gate.rememberReply("今日はいい天気だよ、散歩でもどう？");
  gate.evaluate("今日はいい天気だよ");
  assert.equal(gate.stats.echo, 1, "エコーも数える");
});

test("SpeechGate は同じ発話が 3 回続くと破棄し、resetRepeat で解除される", () => {
  const gate = new SpeechGate();

  assert.equal(gate.evaluate("もう一度お願いします").kind, "accept", "1 回目");
  assert.equal(gate.evaluate("もう一度お願いします").kind, "accept", "2 回目");
  const third = gate.evaluate("もう一度お願いします");
  assert.equal(third.kind, "skip", "3 回目は破棄");
  assert.equal(third.kind === "skip" ? third.reason : "", "repeat");

  // 応答が成立したら解除され、同じ発話でも通る
  gate.resetRepeat();
  assert.equal(gate.evaluate("もう一度お願いします").kind, "accept");
});
