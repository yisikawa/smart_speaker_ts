import type { AssistantState, PipelineEvent } from "../../shared/protocol";
import { ConfigManager } from "../config/ConfigManager";
import { Logger } from "../core/logger";
import { LlmMessage } from "../core/messages";
import { LanguageModel, TextToSpeech } from "../core/ports";
import { ConversationHistory } from "./ConversationHistory";
import { containsHangul, LANGUAGE_RETRY_INSTRUCTION } from "./languageGuard";
import { PromptBuilder } from "./PromptBuilder";

export interface TurnDeps {
  config: ConfigManager;
  history: ConversationHistory;
  promptBuilder: PromptBuilder;
  llm: LanguageModel;
  tts: TextToSpeech;
  logger: Logger;
}

/**
 * パイプライン（状態機械）と 1 ターン実行の橋渡し。
 * 状態・イベント・履歴・再生は呼び出し側が持ち、ここは「何をどの順で行うか」だけを担う。
 */
export interface TurnHooks {
  setState(state: AssistantState): void;
  emit(event: PipelineEvent): void;
  onError(scope: string, error: unknown): void;
  /** 履歴が変わったので UI へ通知する */
  onHistoryChanged(): void;
  /** 応答文が確定した（エコー判定用の記憶などに使う） */
  onReply(reply: string): void;
  /** 読み上げ（バージイン監視込み）。次のターンの発話 WAV を返す */
  play(wav: Buffer): Promise<Buffer | undefined>;
}

/**
 * 1 ターン分の実行（LLM → 読み上げ → 再生）。
 *
 * 中断は呼び出し側が渡した `AbortSignal` で行い、
 * signal が abort されている場合はエラーを通知せず静かに終了する。
 */
export class TurnRunner {
  private readonly logger: Logger;

  constructor(private readonly deps: TurnDeps) {
    this.logger = deps.logger;
  }

  async run(userText: string, hooks: TurnHooks, signal: AbortSignal): Promise<Buffer | undefined> {
    this.deps.history.add("user", userText);
    hooks.onHistoryChanged();

    hooks.setState("thinking");
    hooks.emit({ type: "llm_started" });
    const llmStartedAt = Date.now();

    let reply = "";
    try {
      reply = await this.deps.llm.chatStream(
        this.buildMessages(),
        (delta) => hooks.emit({ type: "llm_delta", content: delta }),
        { signal }
      );

      // 日本語の指示を無視してハングルを混ぜるモデルがあるため、1 回だけ再生成する。
      // 画面は llm_complete の全文で上書きされるので、再生成中の差分は送出しない。
      if (containsHangul(reply)) {
        this.logger.warn("応答にハングルが混入したため日本語で再生成します");
        reply = await this.deps.llm.chatStream(
          this.buildMessages({ languageRetry: true }),
          () => undefined,
          { signal }
        );
        if (containsHangul(reply)) {
          this.logger.warn("再生成してもハングルが残りました");
        }
      }
    } catch (error) {
      if (signal.aborted) {
        return undefined;
      }
      hooks.onError("llm", error);
      return undefined;
    }

    reply = reply.trim();
    hooks.emit({ type: "llm_complete", text: reply, elapsedMs: Date.now() - llmStartedAt });
    if (!reply) {
      hooks.emit({ type: "error", scope: "llm", message: "LLM の応答が空でした" });
      return undefined;
    }
    this.deps.history.add("assistant", reply);
    hooks.onReply(reply);
    hooks.onHistoryChanged();

    hooks.setState("speaking");
    hooks.emit({ type: "tts_started" });
    const ttsStartedAt = Date.now();
    let wav: Buffer;
    try {
      wav = await this.deps.tts.synthesize(reply, { signal });
    } catch (error) {
      if (signal.aborted) {
        return undefined;
      }
      hooks.onError("tts", error);
      return undefined;
    }
    hooks.emit({ type: "tts_complete", elapsedMs: Date.now() - ttsStartedAt });

    return hooks.play(wav);
  }

  /** LLM へ渡すメッセージ（言語再生成時は追加の system 指示を末尾に足す） */
  buildMessages(options: { languageRetry?: boolean } = {}): LlmMessage[] {
    const messages: LlmMessage[] = [
      { role: "system", content: this.deps.promptBuilder.build() },
      ...this.deps.history.forPrompt(),
    ];
    if (options.languageRetry) {
      messages.push({ role: "system", content: LANGUAGE_RETRY_INSTRUCTION });
    }
    return messages;
  }
}
