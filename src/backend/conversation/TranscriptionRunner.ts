import type { AssistantState, PipelineEvent } from "../../shared/protocol";
import { Logger } from "../core/logger";
import { SpeechToText } from "../core/ports";
import { SpeechGate } from "./SpeechGate";

/** 認識結果の扱い（会話に載せる／破棄する） */
export type TranscriptionOutcome =
  | { kind: "text"; text: string }
  /** 認識できなかった（聞き取りを終了する） */
  | { kind: "empty" }
  /** 幻聴・エコー・重複として破棄した（聞き取りは続ける） */
  | { kind: "ignored"; reason: string };

export interface TranscribeHooks {
  setState(state: AssistantState): void;
  emit(event: PipelineEvent): void;
  onError(scope: string, error: unknown): void;
  /** ターンループが継続中か */
  isActive(): boolean;
}

/**
 * 1 回分の音声認識と採否判定（`SpeechGate`）。
 *
 * 「STT を呼ぶ → 空・破棄を判定する → イベントで通知する」を 1 箇所にまとめ、
 * 破棄した場合は必ず `ignored`（＝呼び出し側が `turn_skipped` を出す）を返す。
 */
export class TranscriptionRunner {
  constructor(
    private readonly deps: {
      stt: SpeechToText;
      gate: SpeechGate;
      logger: Logger;
    }
  ) {}

  async run(wav: Buffer, options: { signal: AbortSignal; hooks: TranscribeHooks }): Promise<TranscriptionOutcome> {
    const { hooks } = options;
    hooks.setState("transcribing");
    hooks.emit({ type: "stt_started" });

    try {
      const transcript = await this.deps.stt.transcribe(wav, { signal: options.signal });
      if (!hooks.isActive()) {
        return { kind: "empty" };
      }

      const text = transcript.text.trim();
      if (!text) {
        // 認識結果が空のときは UI に空の吹き出しを出さない
        hooks.emit({
          type: "error",
          scope: "stt",
          message: "音声を認識できませんでした。もう一度お話しください。",
        });
        return { kind: "empty" };
      }

      const decision = this.deps.gate.evaluate(text);
      if (decision.kind === "skip") {
        this.deps.logger.warn(decision.message);
        return { kind: "ignored", reason: decision.reason };
      }

      hooks.emit({
        type: "stt_complete",
        text,
        language: transcript.language,
        elapsedMs: transcript.elapsedMs,
      });
      return { kind: "text", text };
    } catch (error) {
      if (options.signal.aborted) {
        return { kind: "empty" };
      }
      hooks.onError("stt", error);
      return { kind: "empty" };
    }
  }
}
