import test from "node:test";
import assert from "node:assert/strict";
import { extractEmotion, inferEmotion } from "../src/shared/avatar/emotion";

const expressions = { happy: "exp_01", sad: "exp_03", angry: "" };

test("タグを取り除き、設定から表情名へ解決する", () => {
  assert.deepEqual(extractEmotion("おはよう！[喜] いい天気だね。", expressions), {
    text: "おはよう！ いい天気だね。",
    expression: "exp_01",
    emotion: "happy",
  });
});

test("設定が空文字なら表情は変えないが感情キーは返す", () => {
  assert.deepEqual(extractEmotion("もう！[怒]", expressions), {
    text: "もう！",
    expression: null,
    emotion: "angry",
  });
});

test("未知のタグは落とすが表情も感情も変えない", () => {
  assert.deepEqual(extractEmotion("えっ[謎] 本当？", expressions), {
    text: "えっ 本当？",
    expression: null,
    emotion: null,
  });
});

test("複数タグは最後を採用し、全部取り除く", () => {
  assert.deepEqual(extractEmotion("[喜]やった[哀]", expressions), {
    text: "やった",
    expression: "exp_03",
    emotion: "sad",
  });
});

test("タグが無ければ推定する（heuristic=true）", () => {
  assert.deepEqual(extractEmotion("ありがとう！", expressions, { heuristic: true }), {
    text: "ありがとう！",
    expression: "exp_01",
    emotion: "happy",
  });
  assert.deepEqual(extractEmotion("ありがとう！", expressions), {
    text: "ありがとう！",
    expression: null,
    emotion: null,
  });
});

test("推定の語彙", () => {
  assert.equal(inferEmotion("ありがとう！"), "happy");
  assert.equal(inferEmotion("ごめんなさい…"), "sad");
  assert.equal(inferEmotion("えっ、本当！？"), "surprised");
  assert.equal(inferEmotion("はずかしいな"), "shy");
  assert.equal(inferEmotion("たぶんね"), "thinking");
  assert.equal(inferEmotion("ああ"), null);
});
