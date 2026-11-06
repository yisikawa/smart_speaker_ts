import test from "node:test";
import assert from "node:assert/strict";
import { Logger } from "../src/backend/core/logger";
import { LanguageModel, SpeechToText, TextToSpeech } from "../src/backend/core/ports";
import { ServiceMonitor } from "../src/backend/server/ServiceMonitor";

Logger.configure({ level: "error" });

const okLlm = { isAvailable: async () => true } as unknown as LanguageModel;
const okTts = { isAvailable: async () => true } as unknown as TextToSpeech;
const okStt = { isAvailable: async () => true } as unknown as SpeechToText;
const failTts = {
  isAvailable: async () => {
    throw new Error("VOICEVOX に接続できません");
  },
} as unknown as TextToSpeech;

test("ServiceMonitor は 3 サービスの疎通をまとめて返す", async () => {
  const monitor = new ServiceMonitor({ llm: okLlm, tts: okTts, stt: okStt });
  const status = await monitor.refresh();

  assert.deepEqual(status, { llm: true, tts: true, stt: true });
  assert.deepEqual(monitor.current, status, "current は直近の結果を返す");
});

test("ServiceMonitor は確認が失敗したサービスだけ false にする", async () => {
  const monitor = new ServiceMonitor({ llm: okLlm, tts: failTts, stt: okStt });
  const status = await monitor.refresh();

  assert.equal(status.llm, true);
  assert.equal(status.tts, false, "例外は false として扱う");
  assert.equal(status.stt, true);
});

test("ServiceMonitor の start / stop は二重起動しない", () => {
  const monitor = new ServiceMonitor({ llm: okLlm, tts: okTts, stt: okStt, intervalMs: 10 });
  monitor.start();
  monitor.start(); // 二重起動しても例外にならない
  monitor.stop();
  monitor.stop();
});
