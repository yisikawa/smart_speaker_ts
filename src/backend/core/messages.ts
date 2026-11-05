/** LLM へ渡すメッセージ（Ollama / OpenAI 互換のチャット形式） */
export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmMessage {
  role: LlmRole;
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

/** LLM のツール定義（現状は将来拡張用に型のみ用意） */
export interface LlmTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
