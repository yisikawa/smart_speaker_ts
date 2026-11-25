// このテストは「手写しの復活」だけを検出する。別名 import 等で偽陽性になったら実装に合わせて直す。
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("AudioService は buildVadSettings を使う", () => {
  const source = read("src/backend/services/AudioService.ts");
  assert.match(source, /buildVadSettings/);
  assert.doesNotMatch(source, /silenceDurationMs:\s*cfg\.silence_duration\s*\*\s*1000/);
  // VadOptions への素通し（silenceDurationMs: options.silenceDurationMs）は正当なので除外する
  assert.doesNotMatch(source, /silenceDurationMs:\s*(?!\s*options\.)/);
});

test("helloPayload は buildClientVadSettings を使う", () => {
  const source = read("src/backend/server/helloPayload.ts");
  assert.match(source, /buildClientVadSettings/);
  assert.doesNotMatch(source, /calibrationMs:\s*audio\.calibration_duration/);
});

test("BrowserMic は hello の vad 設定をそのまま使う", () => {
  const source = read("src/frontend/mic.ts");
  assert.match(source, /buildBrowserVadSettings/);
  assert.doesNotMatch(source, /silenceDurationMs:\s*/);
});
