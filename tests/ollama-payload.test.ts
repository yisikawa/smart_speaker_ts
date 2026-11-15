import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/backend/config/schema";
import { buildChatPayload, buildPreparePayload } from "../src/backend/services/ollamaPayload";

test("keep_alive と num_ctx が body に入る", () => {
  const cfg = { ...DEFAULT_CONFIG.llm, keep_alive: "45m", num_ctx: 2048 };
  const payload = buildChatPayload(cfg, [{ role: "user", content: "こんにちは" }]);
  assert.equal(payload.keep_alive, "45m");
  assert.deepEqual(payload.options, { temperature: 0.7, num_predict: 512, num_ctx: 2048 });
});

test("温度の上書きと tools の付与", () => {
  const cfg = DEFAULT_CONFIG.llm;
  const tools = [
    { type: "function" as const, function: { name: "x", description: "", parameters: {} } },
  ];
  const payload = buildChatPayload(cfg, [], { temperature: 0.1, tools });
  assert.equal((payload.options as Record<string, unknown>).temperature, 0.1);
  assert.deepEqual(payload.tools, tools);
});

test("事前読み込みの body", () => {
  const cfg = DEFAULT_CONFIG.llm;
  assert.deepEqual(buildPreparePayload(cfg), {
    model: cfg.model,
    prompt: "",
    stream: false,
    keep_alive: "30m",
  });
  assert.equal(buildPreparePayload(cfg, "other:latest").model, "other:latest");
});
