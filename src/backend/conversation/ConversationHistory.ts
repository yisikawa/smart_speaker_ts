import type { ChatMessage } from "../../shared/protocol";
import { LlmMessage } from "../core/messages";

/**
 * 会話履歴。LLM へ渡す直近ターンのみを保持する。
 * 「1 ターン = user + assistant」で数え、古いものから捨てる。
 */
export class ConversationHistory {
  private messages: ChatMessage[] = [];

  constructor(private maxTurns = 6) {}

  setMaxTurns(turns: number): void {
    this.maxTurns = Math.max(0, Math.floor(turns));
    this.trim();
  }

  add(role: "user" | "assistant", content: string): ChatMessage {
    const message: ChatMessage = { role, content, at: Date.now() };
    this.messages.push(message);
    this.trim();
    return message;
  }

  all(): ChatMessage[] {
    return this.messages.map((message) => ({ ...message }));
  }

  /** プロンプト用メッセージ列（system を除く） */
  forPrompt(): LlmMessage[] {
    const trimmed = [...this.messages];
    // 先頭が assistant だとモデルによっては不正な履歴になるため落とす
    while (trimmed.length > 0 && trimmed[0].role !== "user") {
      trimmed.shift();
    }
    return trimmed
      .filter((message) => message.content.trim().length > 0)
      .map((message) => ({ role: message.role, content: message.content }));
  }

  clear(): void {
    this.messages = [];
  }

  get length(): number {
    return this.messages.length;
  }

  private trim(): void {
    const limit = this.maxTurns * 2;
    if (limit <= 0) {
      this.messages = [];
      return;
    }
    if (this.messages.length > limit) {
      this.messages = this.messages.slice(this.messages.length - limit);
    }
  }
}
