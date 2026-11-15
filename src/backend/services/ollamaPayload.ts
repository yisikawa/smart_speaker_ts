import type { LLMConfig } from "../config/schema";
import type { LlmMessage } from "../core/messages";
import type { ChatOptions } from "../core/ports";

/**
 * Ollama のリクエスト body を組み立てる（純粋関数）。
 * `keep_alive` と `num_ctx` は VRAM 使用量に直結するため設定で変えられるようにする。
 */
export function buildChatPayload(
  cfg: LLMConfig,
  messages: LlmMessage[],
  options: ChatOptions = {}
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: true,
    think: false,
    keep_alive: cfg.keep_alive,
    options: {
      temperature: options.temperature ?? cfg.temperature,
      num_predict: cfg.max_tokens,
      num_ctx: cfg.num_ctx,
    },
  };
  if (options.tools && options.tools.length > 0) {
    payload.tools = options.tools;
  }
  return payload;
}

/** `/api/generate` に空プロンプトを投げてモデルを読み込ませる body */
export function buildPreparePayload(cfg: LLMConfig, model?: string): Record<string, unknown> {
  return { model: model ?? cfg.model, prompt: "", stream: false, keep_alive: cfg.keep_alive };
}
