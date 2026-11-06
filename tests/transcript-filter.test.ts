import test from "node:test";
import assert from "node:assert/strict";
import {
  isEchoOfReply,
  isHallucination,
  isTooShortFragment,
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

test("isEchoOfReply は自分が読み上げた内容のエコーを検出する（直近の複数応答・断片も）", () => {
  const replies = ["今日はいい天気だよ、散歩でもどう？", "そうなんだ、見つかるのもワクワクするんだ！"];
  assert.equal(isEchoOfReply("今日はいい天気だよ、散歩でもどう", replies), true);
  assert.equal(isEchoOfReply("散歩でもどう", replies), true);
  // 断片（4 文字）でもバイグラムの一致率が高ければエコーとみなす
  assert.equal(isEchoOfReply("ワクワクする", replies), true);
  // 短すぎる相槌・無関係な発話は対象外
  assert.equal(isEchoOfReply("はい", replies), false);
  assert.equal(isEchoOfReply("明日の予定を教えて", replies), false);
  // 1 件だけ渡す従来の使い方も維持する
  assert.equal(isEchoOfReply("散歩でもどう", replies[0]), true);
});

test("isTooShortFragment は意味のない断片だけを弾く", () => {
  // 環境音・自分の声の拾いで出やすい断片
  for (const text of ["ただ", "し込", "あっ", "ん", "。。。", ""]) {
    assert.equal(isTooShortFragment(text), true, `破棄すべき: ${text}`);
  }
  // 正当な相槌は許可
  for (const text of ["はい", "うん", "そう", "いいえ", "そうだね", "明日の予定を教えて"]) {
    assert.equal(isTooShortFragment(text), false, `許可すべき: ${text}`);
  }
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
