import test from "node:test";
import assert from "node:assert/strict";
import { SentenceSplitter } from "../src/shared/text/sentenceSplitter";

const options = { minChars: 4, maxChars: 40 };

test("句点で文を切り出す", () => {
  const splitter = new SentenceSplitter(options);
  assert.deepEqual(splitter.push("こんにちは。元気"), ["こんにちは。"]);
  assert.deepEqual(splitter.push("ですか？"), ["元気ですか？"]);
});

test("最小文字数未満は次の文と結合する", () => {
  const splitter = new SentenceSplitter(options);
  assert.deepEqual(splitter.push("はい。"), []);
  assert.deepEqual(splitter.push("そうですね。"), ["はい。そうですね。"]);
});

test("最大文字数を超えたら読点で切る", () => {
  const splitter = new SentenceSplitter(options);
  const text = `${"あ".repeat(30)}、${"い".repeat(30)}`;
  const pieces = splitter.push(text);
  assert.equal(pieces.length, 1);
  assert.ok(pieces[0].endsWith("、"));
  assert.equal(pieces[0].length, 31);
});

test("flush は残りを 1 文として返す", () => {
  const splitter = new SentenceSplitter(options);
  splitter.push("まだ途中の文");
  assert.deepEqual(splitter.flush(), ["まだ途中の文"]);
  assert.deepEqual(splitter.flush(), []);
});

test("チャンク境界が文の途中でも壊れない", () => {
  const splitter = new SentenceSplitter(options);
  const pieces = [
    ...splitter.push("今日は"),
    ...splitter.push("いい天気"),
    ...splitter.push("ですね。"),
  ];
  assert.deepEqual(pieces, ["今日はいい天気ですね。"]);
});

test("文末が maxChars を超えるときは手前の読点で切る（初声を短くする）", () => {
  const splitter = new SentenceSplitter({ minChars: 4, maxChars: 24 });
  const pieces = splitter.push("今日はとても良い天気なので、近くの公園まで一緒に散歩しに行きませんか。");
  assert.deepEqual(pieces, [
    "今日はとても良い天気なので、",
    "近くの公園まで一緒に散歩しに行きませんか。",
  ]);
  assert.deepEqual(splitter.flush(), []);
});

test("maxChars 以内に読点が無ければ文末で切る（分割しすぎない）", () => {
  const splitter = new SentenceSplitter({ minChars: 4, maxChars: 10 });
  const sentence = `${"あ".repeat(30)}。`;
  assert.deepEqual(splitter.push(sentence), [sentence]);
});
