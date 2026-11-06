/**
 * 認識結果の検証ユーティリティ。
 *
 * Whisper 系モデルは無音・雑音・BGM に対して定型句（「ご視聴ありがとうございました」等）を
 * 出力する「幻聴（hallucination）」を起こす。ここではテキスト側からそれを判定する。
 * 音響側の判定（no_speech_prob / avg_logprob）は WhisperSttService が行う。
 */

/** 日本語 Whisper が無音・雑音に対して出しがちな定型句（会話では意味を持たないもの） */
const HALLUCINATION_PATTERNS: RegExp[] = [
  /^ご視聴(いただき)?ありがとうございました[。．.!！]?$/,
  /^(チャンネル)?登録(を)?(お願いします|よろしくお願いします)[。．.!！]?$/,
  /^字幕(は)?.*$/,
  /^おやすみなさい[。．.!！]?$/,
  /^おわり[。．.!！]?$/,
  /^[（(][^）)]{1,12}[）)]$/, // （拍手）（笑）（音楽）など効果音のみ
  /^thank you[.!\s]*$/i,
  /^thanks for watching[.!\s]*$/i,
  /^subscribe.*$/i,
  /^[\s.。…、,]+$/,
];

/** 比較用の正規化（全角/半角・記号・空白の揺れを吸収する） */
export function normalizeTranscript(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\s\u3000]/g, "")
    .replace(/[。．.!！?？、,，・…「」『』（）()\[\]【】~〜ー`'"ー-]/g, "")
    .toLowerCase();
}

/**
 * 定型句の幻聴か。
 * 空文字・記号のみ・同じ文の単純な繰り返しも「幻聴」として扱う。
 */
export function isHallucination(text: string): boolean {
  const trimmed = text.normalize("NFKC").trim();
  if (!trimmed || !normalizeTranscript(trimmed)) {
    return true;
  }
  if (HALLUCINATION_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return true;
  }
  // 「ありがとうございました。ありがとうございました。」のような単純な 2 回繰り返し
  const normalized = normalizeTranscript(trimmed);
  if (normalized.length >= 4 && normalized.length % 2 === 0) {
    const half = normalized.slice(0, normalized.length / 2);
    if (half === normalized.slice(normalized.length / 2)) {
      return true;
    }
  }
  return false;
}

/**
 * 直前に自分（アシスタント）が読み上げた内容のエコーか。
 *
 * スピーカー出力をマイクが拾うと「自分の声をユーザーの発話として認識」してしまい、
 * 1 人で会話し続けるループになる。短い相槌は誤判定しやすいので一定長以上のみ判定する。
 */
export function isEchoOfReply(text: string, lastReply: string): boolean {
  const target = normalizeTranscript(text);
  if (target.length < 6) {
    return false;
  }
  const reply = normalizeTranscript(lastReply);
  return reply.length > 0 && reply.includes(target);
}

/** 同じ発話の繰り返しか（連続して同一結果が返る幻聴・エコーの抑制） */
export function isRepeatedTranscript(text: string, previous: string): boolean {
  const target = normalizeTranscript(text);
  if (target.length < 4) {
    return false;
  }
  return target === normalizeTranscript(previous);
}

/** whisper.cpp の JSON 出力（-ojf）の 1 区間 */
export interface WhisperSegment {
  text?: string;
  no_speech_prob?: number;
  avg_logprob?: number;
}

export interface SegmentFilterOptions {
  /** この確率以上の区間は「無音」とみなして捨てる */
  noSpeechProb: number;
  /** この平均対数確率未満の区間は「低信頼」として捨てる */
  avgLogprob: number;
}

/**
 * 信頼度の低い区間を落として本文を組み立てる。
 * しきい値を設定していない（undefined）区間はそのまま採用する。
 */
export function joinSegments(
  segments: WhisperSegment[],
  options: SegmentFilterOptions
): { text: string; dropped: number } {
  const kept: string[] = [];
  let dropped = 0;

  for (const segment of segments) {
    const noSpeech = typeof segment.no_speech_prob === "number" ? segment.no_speech_prob : 0;
    const logprob = typeof segment.avg_logprob === "number" ? segment.avg_logprob : 0;
    if (noSpeech >= options.noSpeechProb || logprob < options.avgLogprob) {
      dropped += 1;
      continue;
    }
    const text = segment.text?.trim();
    if (text) {
      kept.push(text);
    }
  }

  return { text: kept.join("").trim(), dropped };
}
