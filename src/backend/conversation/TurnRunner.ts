import { randomUUID } from "node:crypto";
import type { AssistantState, PipelineEvent } from "../../shared/protocol";
import { buildVolumeEnvelope } from "../../shared/audio/envelope";
import { ConfigManager } from "../config/ConfigManager";
import { Logger } from "../core/logger";
import { LlmMessage } from "../core/messages";
import { LanguageModel, PlaybackMeta, TextToSpeech } from "../core/ports";
import { wavDurationMs } from "../services/wav";
import { ConversationHistory } from "./ConversationHistory";
import { containsHangul, LANGUAGE_RETRY_INSTRUCTION } from "./languageGuard";
import { PromptBuilder } from "./PromptBuilder";
import { SpeechQueue } from "./SpeechQueue";
import { SentenceSplitter } from "../../shared/text/sentenceSplitter";
import { extractEmotion } from "../../shared/avatar/emotion";

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
  play(wav: Buffer, meta: PlaybackMeta, options?: { announce?: boolean }): Promise<Buffer | undefined>;
  /** 進行中の再生だけを止める（ターンは続ける） */
  stopPlayback(): void;
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
    const startedAt = Date.now();

    if (!this.deps.config.getTTS().split_sentences) {
      return this.runWholeText(hooks, signal, startedAt);
    }
    return this.runStreaming(hooks, signal, startedAt);
  }

  /** 全文をまとめて 1 回だけ合成する（`tts.split_sentences=false`） */
  private async runWholeText(
    hooks: TurnHooks,
    signal: AbortSignal,
    llmStartedAt: number
  ): Promise<Buffer | undefined> {
    let reply = "";
    try {
      reply = await this.deps.llm.chatStream(
        this.buildMessages(),
        (delta) => hooks.emit({ type: "llm_delta", content: delta }),
        { signal }
      );
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
    return hooks.play(wav, this.meta(wav, reply));
  }

  /** 文単位で合成・再生する（既定） */
  private async runStreaming(
    hooks: TurnHooks,
    signal: AbortSignal,
    llmStartedAt: number
  ): Promise<Buffer | undefined> {
    const ttsConfig = this.deps.config.getTTS();
    const avatarConfig = this.deps.config.getAvatar();
    const splitter = new SentenceSplitter({
      minChars: ttsConfig.min_sentence_chars,
      maxChars: ttsConfig.max_sentence_chars,
    });

    let announced = false;
    let resetRequested = false;
    let queue: SpeechQueue | null = this.createQueue(hooks, signal);

    const enqueue = (raw: string): void => {
      const { text, expression } = extractEmotion(raw, avatarConfig.expressions, {
        heuristic: avatarConfig.emotion_heuristic_enabled,
      });
      if (!text || !queue) {
        return;
      }
      if (containsHangul(text)) {
        if (!resetRequested) {
          resetRequested = true;
          this.logger.warn("応答にハングルが混入したため読み直します");
          queue.stop();
          queue = null;
          hooks.stopPlayback();
        }
        return;
      }
      if (!announced) {
        announced = true;
        hooks.setState("speaking");
        hooks.emit({ type: "speaking_started" });
      }
      queue.enqueue(text, expression ?? undefined);
    };

    let reply = "";
    try {
      reply = await this.deps.llm.chatStream(
        this.buildMessages(),
        (delta) => {
          hooks.emit({ type: "llm_delta", content: delta });
          for (const piece of splitter.push(delta)) {
            enqueue(piece);
          }
        },
        { signal }
      );
    } catch (error) {
      queue?.stop();
      if (signal.aborted) {
        return undefined;
      }
      hooks.onError("llm", error);
      return undefined;
    }

    reply = reply.trim();
    for (const piece of splitter.flush()) {
      enqueue(piece);
    }

    // 言語ガード: ハングルを検出したら 1 回だけ生成し直して最初から読み上げる
    if (resetRequested) {
      queue?.stop();
      queue = null;
      hooks.emit({ type: "speech_reset" });
      try {
        reply = (
          await this.deps.llm.chatStream(this.buildMessages({ languageRetry: true }), () => undefined, { signal })
        ).trim();
      } catch (error) {
        if (signal.aborted) {
          return undefined;
        }
        hooks.onError("llm", error);
        return undefined;
      }
      announced = false;
      resetRequested = false;
      const retrySplitter = new SentenceSplitter({
        minChars: ttsConfig.min_sentence_chars,
        maxChars: ttsConfig.max_sentence_chars,
      });
      queue = this.createQueue(hooks, signal);
      for (const piece of [...retrySplitter.push(reply), ...retrySplitter.flush()]) {
        enqueue(piece);
      }
    }

    hooks.emit({ type: "llm_complete", text: reply, elapsedMs: Date.now() - llmStartedAt });
    if (!reply) {
      queue?.stop();
      hooks.emit({ type: "error", scope: "llm", message: "LLM の応答が空でした" });
      return undefined;
    }
    this.deps.history.add("assistant", reply);
    hooks.onReply(reply);
    hooks.onHistoryChanged();

    hooks.emit({ type: "tts_started" });
    const started = Date.now();
    const result = await queue?.drain();
    hooks.emit({ type: "tts_complete", elapsedMs: Date.now() - started });
    if (announced) {
      hooks.emit({ type: "speaking_finished" });
    }
    if (!result || (result.played === 0 && result.failed > 0)) {
      hooks.emit({ type: "error", scope: "tts", message: "音声合成に失敗しました" });
    }
    return result?.bargeWav;
  }

  /** 文単位再生のキュー（先読み・直列・中断） */
  private createQueue(hooks: TurnHooks, signal: AbortSignal): SpeechQueue {
    return new SpeechQueue({
      tts: this.deps.tts,
      logger: this.logger,
      signal,
      sampleRate: this.deps.config.getAudio().sample_rate,
      prefetchDepth: this.deps.config.getTTS().prefetch_depth,
      play: (wav, meta) => hooks.play(wav, meta, { announce: false }),
    });
  }

  /** 表示・口パク用のメタ情報 */
  private meta(wav: Buffer, text: string): PlaybackMeta {
    return {
      utteranceId: randomUUID(),
      text,
      volumes: buildVolumeEnvelope(wav),
      sliceMs: 20,
      durationMs: wavDurationMs(wav, this.deps.config.getAudio().sample_rate),
    };
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
