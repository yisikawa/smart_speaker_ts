/** 文末とみなす文字（連続する「…」「!?」も 1 つの区切りとして扱う） */
const END_CHARS = new Set(["。", "．", ".", "！", "!", "？", "?", "…", "\n"]);

/** 長すぎるときに使う区切り（読点） */
const COMMA_CHARS = new Set(["、", "，", ","]);

export interface SentenceSplitterOptions {
  /** これ未満の文は次と結合する */
  minChars: number;
  /** これ超の文は読点でも分割する */
  maxChars: number;
}

/**
 * LLM のストリーミング差分を「確定した文」へ切り出す。
 *
 * 文末の直後で切り、`minChars` 未満は次の文と結合する。句点が来ないまま
 * `maxChars` を超えたら読点で切る（読点も無ければ `maxChars` で切る）。
 * 感情タグの抽出は P5 で足す（P2 ではタグを送らない）。
 */
export class SentenceSplitter {
  private buffer = "";

  constructor(private readonly options: SentenceSplitterOptions) {}

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
    for (let i = from; i < this.buffer.length; i += 1) {
      const char = this.buffer[i];
      if (!END_CHARS.has(char)) {
        continue;
      }
      // 「……」「!?」のような連続をまとめる
      let end = i + 1;
      while (end < this.buffer.length && END_CHARS.has(this.buffer[end])) {
        end += 1;
      }
      return end;
    }

    if (this.buffer.length <= this.options.maxChars) {
      return 0;
    }

    // 長すぎる: maxChars 以内の最後の読点で切る
    let lastComma = -1;
    for (let i = 0; i < Math.min(this.buffer.length, this.options.maxChars); i += 1) {
      if (COMMA_CHARS.has(this.buffer[i])) {
        lastComma = i + 1;
      }
    }
    return lastComma > 0 ? lastComma : this.options.maxChars;
  }
}
