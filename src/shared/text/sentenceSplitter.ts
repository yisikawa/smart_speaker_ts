import { isAbbreviationAt } from "../i18n/languagePack";

/** 文末とみなす文字（連続する「…」「!?」も 1 つの区切りとして扱う） */
const END_CHARS = new Set(["。", "．", ".", "！", "!", "？", "?", "…", "\n"]);

/** 長すぎるときに使う区切り（読点） */
const COMMA_CHARS = new Set(["、", "，", ","]);

export interface SentenceSplitterOptions {
  /** これ未満の文は次と結合する */
  minChars: number;
  /** これ超の文は読点でも分割する */
  maxChars: number;
  /** 文末とみなす文字（未指定なら日本語・英語の既定セット） */
  endChars?: string[];
  /** 長すぎるときに使う区切り（未指定なら読点・カンマ） */
  commaChars?: string[];
  /** 誤分割を避ける略語（例: "mr", "e.g"。英語モードのみ指定する） */
  abbreviations?: string[];
}

/**
 * LLM のストリーミング差分を「確定した文」へ切り出す。
 *
 * 文末の直後で切り、`minChars` 未満は次の文と結合する。句点が来ないまま
 * `maxChars` を超えたら読点で切る（読点も無ければ `maxChars` で切る）。
 * 英語の `Mr.` などの略語は `abbreviations` を渡すと分割しない。
 */
export class SentenceSplitter {
  private buffer = "";
  private readonly endChars: Set<string>;
  private readonly commaChars: Set<string>;
  private readonly abbreviations: string[];

  constructor(private readonly options: SentenceSplitterOptions) {
    this.endChars = new Set(options.endChars ?? [...END_CHARS]);
    this.commaChars = new Set(options.commaChars ?? [...COMMA_CHARS]);
    this.abbreviations = options.abbreviations ?? [];
  }

  /** 差分を食わせ、確定した文だけを返す（未確定は内部バッファに残る） */
  push(delta: string): string[] {
    this.buffer += delta;
    const pieces: string[] = [];

    let searchFrom = 0;
    for (;;) {
      const cut = this.findCut(searchFrom);
      if (cut <= 0) {
        break;
      }
      const piece = this.buffer.slice(0, cut).trim();

      if (piece.length < this.options.minChars) {
        // 短すぎる文は次と結合する（次の区切りまで伸ばす）
        searchFrom = cut;
        continue;
      }

      this.buffer = this.buffer.slice(cut);
      if (piece) {
        pieces.push(piece);
      }
      searchFrom = 0;
    }

    return pieces;
  }

  /** ストリーム終端で残りを吐く */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }

  private findCut(from: number): number {
    const limit = from + this.options.maxChars;
    for (let i = from; i < this.buffer.length; i += 1) {
      const char = this.buffer[i];
      if (!this.endChars.has(char)) {
        continue;
      }
      // 英語の略語（Mr. / e.g. など）は文末として扱わない
      if (char === "." && isAbbreviationAt(this.buffer, i, this.abbreviations)) {
        continue;
      }
      // 「……」「!?」のような連続をまとめる
      let end = i + 1;
      while (end < this.buffer.length && this.endChars.has(this.buffer[end])) {
        end += 1;
      }
      // 文末が遠すぎるときは手前の読点で切る（1 文目が長いと初声が遅くなるため）
      if (end - from > this.options.maxChars) {
        const comma = this.lastCommaWithin(from, limit);
        if (comma > 0) {
          return comma;
        }
      }
      return end;
    }

    if (this.buffer.length - from <= this.options.maxChars) {
      return 0;
    }

    // 長すぎる: maxChars 以内の最後の読点で切る（読点も無ければ maxChars で切る）
    return this.lastCommaWithin(from, limit) || limit;
  }

  /** [from, limit) にある最後の読点の直後（無ければ -1） */
  private lastCommaWithin(from: number, limit: number): number {
    let last = -1;
    for (let i = from; i < Math.min(this.buffer.length, limit); i += 1) {
      if (this.commaChars.has(this.buffer[i])) {
        last = i + 1;
      }
    }
    return last;
  }

}
