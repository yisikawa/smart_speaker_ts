import { ConfigManager } from "../config/ConfigManager";
import { abortError, isAborted } from "../core/errors";
import { Logger } from "../core/logger";
import { SpeechToText, Transcript } from "../core/ports";
import { isHallucination } from "./transcriptFilter";

/** 認識結果（フィルタ前） */
export interface RecognizeResult {
  /** エンジンが返した生テキスト */
  text: string;
  /** ログに付ける補足（例: "低信頼の区間 2 件を破棄"） */
  note?: string;
}

/**
 * STT 実装の共通部分。
 *
 * 具象クラスは `recognize()`（エンジン固有の処理）だけを実装する。
 * 共通化しているのは以下で、これらを各実装が個別に持つことで
 * 「片方のエンジンだけ幻聴フィルタが効かない」といった漏れを防ぐ。
 *
 * - 中断の判定（`AbortSignal` の状態のみで判断する）
 * - 幻聴（`stt.filter_hallucinations`）の破棄
 * - 経過時間の計測と `認識完了` ログ
 */
export abstract class BaseSttService implements SpeechToText {
  protected readonly logger: Logger;

  constructor(protected readonly deps: { config: ConfigManager; logger?: Logger }) {
    this.logger = deps.logger ?? new Logger("STT");
  }

  abstract isAvailable(): Promise<boolean>;

  /** エンジン固有の認識処理（フィルタ前の生テキストを返す） */
  protected abstract recognize(
    wav: Buffer,
    options: { signal?: AbortSignal }
  ): Promise<RecognizeResult>;

  /** 認識結果に付ける言語（既定は `stt.language`） */
  protected language(): string {
    return this.deps.config.getSTT().language;
  }

  async transcribe(wav: Buffer, options: { signal?: AbortSignal } = {}): Promise<Transcript> {
    if (isAborted(options.signal)) {
      throw abortError("STT が中断されました");
    }

    const started = Date.now();
    const result = await this.recognize(wav, options);

    if (isAborted(options.signal)) {
      throw abortError("STT が中断されました");
    }

    const text = this.filterText(result.text);
    const elapsedMs = Date.now() - started;
    const note = result.note ? `, ${result.note}` : "";
    this.logger.info(`認識完了 (${elapsedMs}ms${note}): ${text || "(空)"}`);
    return { text, language: this.language(), elapsedMs };
  }

  /** 幻聴（無音に対する定型句）を破棄する */
  private filterText(raw: string): string {
    const text = raw.trim();
    if (!text) {
      return "";
    }
    if (this.deps.config.getSTT().filter_hallucinations && isHallucination(text)) {
      this.logger.warn(`幻聴と判定したため破棄します: ${text}`);
      return "";
    }
    return text;
  }
}
