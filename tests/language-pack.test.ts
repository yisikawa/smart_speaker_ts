import test from "node:test";
import assert from "node:assert/strict";
import { getLanguagePack, isAbbreviationAt, languageLabel } from "../src/shared/i18n/languagePack";
import { SentenceSplitter } from "../src/shared/text/sentenceSplitter";
import { PromptBuilder } from "../src/backend/conversation/PromptBuilder";
import { containsDisallowedScript } from "../src/backend/conversation/languageGuard";
import type { CharacterProfile } from "../src/backend/services/CharacterService";
import { createTempProject } from "./helpers/project";

const CHARACTER: CharacterProfile = {
  name: "さくら",
  label: "明るい",
  personality: "明るく好奇心旺盛。",
  responseRules: "- 3 文以内で答える",
  catchphrases: ["うんうん、なるほどね"],
};

function buildPrompt(mode: "ja" | "en"): string {
  const project = createTempProject();
  try {
    const builder = new PromptBuilder({
      config: project.config,
      character: { get: () => CHARACTER },
    });
    return builder.build(mode);
  } finally {
    project.cleanup();
  }
}

test("日本語プロンプトは従来の文言を保つ（既存挙動の回帰）", () => {
  const prompt = buildPrompt("ja");
  assert.match(prompt, /あなたは「さくら」という日本語の音声アシスタントです。/);
  assert.match(prompt, /【最重要】応答は必ず日本語で書くこと/);
  assert.ok(
    prompt
      .trimEnd()
      .endsWith(getLanguagePack("ja").prompt.languageRuleShort),
    "末尾は日本語以外を使わない指示で終わる"
  );
});

test("英語プロンプトは英語ルールへ切り替わる", () => {
  const prompt = buildPrompt("en");
  assert.match(prompt, /Respond in English only/);
  assert.match(prompt, /User name:/);
  assert.doesNotMatch(prompt, /必ず日本語で書くこと/);
  assert.ok(prompt.trimEnd().endsWith(getLanguagePack("en").prompt.languageRuleShort));
});

test("言語パックの相槌・幻聴パターンは言語ごとに異なる", () => {
  assert.ok(getLanguagePack("ja").gate.shortAllowlist.includes("うん"));
  assert.ok(getLanguagePack("en").gate.shortAllowlist.includes("yes"));
  assert.equal(languageLabel("en"), "English");
  assert.equal(languageLabel("unknown"), "日本語");
});

test("SentenceSplitter は英語の略語では分割しない", () => {
  const splitter = new SentenceSplitter({
    minChars: 5,
    maxChars: 200,
    abbreviations: getLanguagePack("en").text.abbreviations,
  });
  const pieces = splitter.push("Mr. Smith went to Washington. He arrived at 9 a.m. today.");
  assert.deepEqual(pieces, ["Mr. Smith went to Washington.", "He arrived at 9 a.m. today."]);
  assert.deepEqual(splitter.flush(), []);
});

test("isAbbreviationAt は語尾の略語だけを検出する", () => {
  const abbreviations = getLanguagePack("en").text.abbreviations;
  const text = "Ask Dr. Brown.";
  assert.equal(isAbbreviationAt(text, text.indexOf("Dr.") + 2, abbreviations), true);
  assert.equal(isAbbreviationAt(text, text.length - 1, abbreviations), false);
});

test("isAbbreviationAt は数字に続く語尾を略語扱いしない", () => {
  const text = "He finished 1st. Then he left.";
  const dot = text.indexOf("st.") + 2;
  assert.equal(isAbbreviationAt(text, dot, ["st"]), false);
});

test("isAbbreviationAt は実パックでも序数・小数を略語扱いしない", () => {
  const abbreviations = getLanguagePack("en").text.abbreviations;
  const ordinal = "It was his 21st. He left.";
  assert.equal(isAbbreviationAt(ordinal, ordinal.indexOf("st.") + 2, abbreviations), false);
  const decimal = "Pi is 3.5 today.";
  assert.equal(isAbbreviationAt(decimal, decimal.indexOf("3.5") + 1, abbreviations), false);
});

test("isAbbreviationAt は Saint の St. を略語として扱う", () => {
  const abbreviations = getLanguagePack("en").text.abbreviations;
  const text = "He met St. Mary.";
  assert.equal(isAbbreviationAt(text, text.indexOf("St.") + 2, abbreviations), true);
});

test("SentenceSplitter は序数のピリオドで分割する", () => {
  const splitter = new SentenceSplitter({
    minChars: 5,
    maxChars: 200,
    abbreviations: getLanguagePack("en").text.abbreviations,
  });
  assert.deepEqual(splitter.push("He finished 1st. Then he left the room."), [
    "He finished 1st.",
    "Then he left the room.",
  ]);
  assert.deepEqual(splitter.flush(), []);
});

test("SentenceSplitter は Saint の St. では分割しない", () => {
  const splitter = new SentenceSplitter({
    minChars: 5,
    maxChars: 200,
    abbreviations: getLanguagePack("en").text.abbreviations,
  });
  assert.deepEqual(splitter.push("Mr. Smith met St. Mary at 9 a.m. today. He left."), [
    "Mr. Smith met St. Mary at 9 a.m. today.",
    "He left.",
  ]);
  assert.deepEqual(splitter.flush(), []);
});

test("言語ガードはモードに応じて禁止文字が変わる", () => {
  assert.equal(containsDisallowedScript("こんにちは", "ja"), false);
  assert.equal(containsDisallowedScript("안녕하세요", "ja"), true);
  assert.equal(containsDisallowedScript("Hello there", "en"), false);
  assert.equal(containsDisallowedScript("Hello こんにちは", "en"), true);
  assert.equal(containsDisallowedScript("Hello 안녕", "en"), true);
});
