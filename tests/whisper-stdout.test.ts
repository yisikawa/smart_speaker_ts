import test from "node:test";
import assert from "node:assert/strict";
import { parseWhisperStdout } from "../src/backend/services/WhisperSttService";

test("whisper の stdout から区間テキストを復元する（英語）", () => {
  const stdout = "\n[00:00:00.000 --> 00:00:02.180]   Hello. How are you today?\n\n";
  assert.equal(parseWhisperStdout(stdout, "en"), "Hello. How are you today?");
});

test("複数区間は英語なら空白、日本語ならそのまま連結する", () => {
  const en =
    "[00:00:00.000 --> 00:00:01.000]   Hello.\n" +
    "[00:00:01.000 --> 00:00:02.000]   How are you?\n";
  assert.equal(parseWhisperStdout(en, "en"), "Hello. How are you?");

  const ja =
    "[00:00:00.000 --> 00:00:01.000]   こんにちは。\n" +
    "[00:00:01.000 --> 00:00:02.000]   元気ですか？\n";
  assert.equal(parseWhisperStdout(ja, "ja"), "こんにちは。元気ですか？");
});

test("区間以外のログ行と空区間は無視する", () => {
  const stdout = [
    "main: processing 'input.wav' ...",
    "[00:00:00.000 --> 00:00:01.000]   ",
    "whisper_print_timings: total time = 1.0",
  ].join("\n");
  assert.equal(parseWhisperStdout(stdout, "ja"), "");
});

test("BLANK_AUDIO は無視する", () => {
  assert.equal(
    parseWhisperStdout("[00:00:00.000 --> 00:00:01.000]   [BLANK_AUDIO]\n", "ja"),
    ""
  );
});
