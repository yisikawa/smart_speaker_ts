import test from "node:test";
import assert from "node:assert/strict";
import {
  isEchoOfReply,
  isHallucination,
  joinSegments,
  normalizeTranscript,
} from "../src/backend/services/transcriptFilter";

test("normalizeTranscript は記号・空白・大文字小文字の揺れを吸収する", () => {
  assert.equal(normalizeTranscript("今日は、いい天気！？"), "今日はいい天気");
  assert.equal(normalizeTranscript("ＡＢＣ です。"), "abcです");
});

test("isHallucination は Whisper の定型句・記号のみ・単純な繰り返しを検出する", () => {
  for (const text of [
    "ご視聴ありがとうございました。",
    "ご視聴いただきありがとうございました",
    "チャンネル登録お願いします。",
    "字幕はこちら",
    "おやすみなさい",
    "（拍手）",
    "Thank you.",
    "。。。",
    "",
    "ありがとうございました。ありがとうございました。",
  ]) {
    assert.equal(isHallucination(text), true, `幻聴と判定すべき: ${text}`);
  }
});

test("isHallucination は通常の日本語を幻聴と判定しない", () => {
  for (const text of [
    "今日の天気は？",
    "ありがとう",
    "ありがとうございました", // 単発の感謝は会話として成立するので許可
    "おやすみなさい、また明日ね",
    "チャンネル登録の方法を教えて",
  ]) {
    assert.equal(isHallucination(text), false, `幻聴と判定してはいけない: ${text}`);
  }
});

test("isEchoOfReply は自分が読み上げた内容のエコーだけを検出する", () => {
  const reply = "今日はいい天気だよ、散歩でもどう？";
  assert.equal(isEchoOfReply("今日はいい天気だよ、散歩でもどう", reply), true);
  assert.equal(isEchoOfReply("散歩でもどう", reply), true);
  // 短い相槌は誤判定しやすいので対象外
  assert.equal(isEchoOfReply("はい", reply), false);
  assert.equal(isEchoOfReply("今日の天気は？", reply), false);
});

test("joinSegments は no_speech_prob / avg_logprob で低信頼の区間を落とす", () => {
  const result = joinSegments(
    [
      { text: "こんにちは", no_speech_prob: 0.01, avg_logprob: -0.2 },
      { text: " ご視聴ありがとうございました。", no_speech_prob: 0.92, avg_logprob: -0.1 },
      { text: "今日は晴れです", no_speech_prob: 0.05, avg_logprob: -1.6 },
      { text: "いい天気ですね", no_speech_prob: 0.1, avg_logprob: -0.3 },
    ],
    { noSpeechProb: 0.75, avgLogprob: -1.0 }
  );

  assert.equal(result.text, "こんにちはいい天気ですね");
  assert.equal(result.dropped, 2);
});

test("joinSegments は信頼度が無い区間をそのまま採用する", () => {
  const result = joinSegments([{ text: "テスト" }], { noSpeechProb: 0.75, avgLogprob: -1 });
  assert.equal(result.text, "テスト");
  assert.equal(result.dropped, 0);
});
