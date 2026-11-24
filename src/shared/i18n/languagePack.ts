/**
 * 言語モード（日本語 / 英語）ごとの振る舞いを 1 箇所に集約する。
 *
 * DOM にも Node にも依存しない純粋な定義だけを置き、
 * バックエンド（プロンプト・STT・TTS・文分割・破棄判定）と
 * フロントエンド（切替 UI のラベル）の双方から参照する。
 *
 * 既定（ja）の文言は従来の実装と同一に保つこと（既存テストが検証している）。
 */

export type LanguageMode = "ja" | "en";

export const LANGUAGE_MODES: LanguageMode[] = ["ja", "en"];

/** 感情推定に使う語彙（`shared/avatar/emotion.ts` のキーと一致させる） */
export interface EmotionVocabulary {
  key: "happy" | "angry" | "sad" | "surprised" | "shy" | "thinking";
  words: string[];
}

export interface LanguagePack {
  code: LanguageMode;
  /** UI・ログで使う言語名 */
  label: string;
  prompt: {
    roleLine(name: string): string;
    languageRule: string;
    languageRuleShort: string;
    retryInstruction: string;
    /** 吹き出し・字幕の言語名（例: 「日本語で生成し直しています…」） */
    speechResetNote: string;
  };
  stt: {
    /** whisper.cpp の `-l` に渡す既定値 */
    whisperLanguage: string;
    /** sherpa-onnx（SenseVoice）の言語指定 */
    sherpaLanguage: string;
  };
  text: {
    endChars: string[];
    commaChars: string[];
    /** 誤分割を避ける略語（語尾のピリオドを含めない） */
    abbreviations: string[];
    minSentenceChars: number;
    maxSentenceChars: number;
  };
  gate: {
    shortAllowlist: string[];
    extraHallucinationPatterns: RegExp[];
  };
  emotion: EmotionVocabulary[];
  ui: {
    switcherLabel: string;
    switchedToast(languageName: string): string;
    ttsFailure: string;
  };
}

/** 言語に依存しない幻聴パターン（記号のみ・英語の定型句） */
export const SHARED_HALLUCINATION_PATTERNS: RegExp[] = [
  /^[（(][^）)]{1,12}[）)]$/, // （拍手）（笑）（音楽）など効果音のみ
  /^thank you[.!\s]*$/i,
  /^thanks for watching[.!\s]*$/i,
  /^subscribe.*$/i,
  /^[\s.。…、,]+$/,
];

/** 言語に依存しない短い相槌 */
export const SHARED_SHORT_ALLOWLIST: string[] = ["ok"];

/** 文末・読点の既定セット（日英とも同じ記号を使う） */
const DEFAULT_END_CHARS = ["。", "．", ".", "！", "!", "？", "?", "…", "\n"];
const DEFAULT_COMMA_CHARS = ["、", "，", ","];

const JA: LanguagePack = {
  code: "ja",
  label: "日本語",
  prompt: {
    roleLine: (name) => `あなたは「${name}」という日本語の音声アシスタントです。`,
    languageRule:
      "【最重要】応答は必ず日本語で書くこと。ハングル（韓国語）・中国語・英語など他言語の文字を混ぜてはいけない。",
    languageRuleShort: "- 日本語以外の言語（韓国語・中国語・英語など）の文字は使わないこと",
    retryInstruction:
      "前回の応答にはハングル（韓国語）が混ざっていたため破棄しました。今度は日本語だけで書いてください。",
    speechResetNote: "日本語で生成し直しています…",
  },
  stt: { whisperLanguage: "ja", sherpaLanguage: "ja" },
  text: {
    endChars: DEFAULT_END_CHARS,
    commaChars: DEFAULT_COMMA_CHARS,
    abbreviations: [],
    minSentenceChars: 4,
    maxSentenceChars: 60,
  },
  gate: {
    shortAllowlist: [
      "はい",
      "うん",
      "ええ",
      "そう",
      "いや",
      "いいえ",
      "いえ",
      "うんうん",
      "そうだね",
      "ちがう",
      "ない",
      "ある",
    ],
    extraHallucinationPatterns: [
      /^ご視聴(いただき)?ありがとうございました[。．.!！]?$/,
      /^(チャンネル)?登録(を)?(お願いします|よろしくお願いします)[。．.!！]?$/,
      /^字幕(は)?.*$/,
      /^おやすみなさい[。．.!！]?$/,
      /^おわり[。．.!！]?$/,
    ],
  },
  emotion: [
    { key: "surprised", words: ["えっ", "まさか", "本当", "びっくり", "！？", "?!"] },
    { key: "angry", words: ["むかつ", "ふざけ", "ダメ", "だめ", "怒"] },
    { key: "sad", words: ["ごめん", "残念", "悲し", "つらい", "寂し"] },
    { key: "shy", words: ["はずかし", "恥ずかし", "照れ"] },
    { key: "happy", words: ["ありがとう", "うれし", "嬉し", "楽しい", "やった", "すごい", "いいね"] },
    { key: "thinking", words: ["どうしよ", "たぶん", "かな", "考え"] },
  ],
  ui: {
    switcherLabel: "言語",
    switchedToast: (name) => `${name}モードに切り替えました（次の発話から有効）`,
    ttsFailure: "音声合成に失敗しました",
  },
};

const EN: LanguagePack = {
  code: "en",
  label: "English",
  prompt: {
    roleLine: (name) => `You are "${name}", a friendly voice assistant that speaks English.`,
    languageRule:
      "[IMPORTANT] Respond in English only. Do not mix Japanese, Chinese, Korean, or any other script into the reply.",
    languageRuleShort: "- Never use non-English characters (Japanese, Chinese, Korean, etc.).",
    retryInstruction:
      "The previous reply contained non-English characters and was discarded. Reply again using English only.",
    speechResetNote: "Regenerating the reply in English…",
  },
  stt: { whisperLanguage: "en", sherpaLanguage: "en" },
  text: {
    endChars: DEFAULT_END_CHARS,
    commaChars: DEFAULT_COMMA_CHARS,
    abbreviations: [
      "mr",
      "mrs",
      "ms",
      "dr",
      "prof",
      "sr",
      "jr",
      "st",
      "vs",
      "etc",
      "e.g",
      "i.e",
      "a.m",
      "p.m",
      "u.s",
    ],
    minSentenceChars: 12,
    maxSentenceChars: 120,
  },
  gate: {
    shortAllowlist: ["yes", "yeah", "no", "nope", "sure", "hi", "hey", "wow", "hmm"],
    extraHallucinationPatterns: [
      /^thanks? for watching.*$/i,
      /^please subscribe.*$/i,
      /^subtitles? by.*$/i,
      /^\[?music\]?$/i,
      /^\[?applause\]?$/i,
    ],
  },
  emotion: [
    { key: "surprised", words: ["wow", "really", "no way", "unbelievable", "?!"] },
    { key: "angry", words: ["angry", "annoying", "stop it"] },
    { key: "sad", words: ["sorry", "unfortunately", "sad", "miss you"] },
    { key: "shy", words: ["embarrass", "shy", "blush"] },
    { key: "happy", words: ["thank", "glad", "happy", "great", "nice", "awesome", "love"] },
    { key: "thinking", words: ["maybe", "perhaps", "let me think", "hmm"] },
  ],
  ui: {
    switcherLabel: "Language",
    switchedToast: (name) => `Switched to ${name} mode (applies from the next utterance).`,
    ttsFailure: "Speech synthesis failed",
  },
};

export const LANGUAGE_PACKS: Record<LanguageMode, LanguagePack> = { ja: JA, en: EN };

export function isLanguageMode(value: unknown): value is LanguageMode {
  return value === "ja" || value === "en";
}

export function getLanguagePack(mode: LanguageMode): LanguagePack {
  return LANGUAGE_PACKS[mode] ?? JA;
}

/** 表示用の言語名（不明値は日本語扱い） */
export function languageLabel(mode: string): string {
  return isLanguageMode(mode) ? LANGUAGE_PACKS[mode].label : JA.label;
}

/**
 * 文末記号の直後が略語（Mr. など）なら区切りとして扱わないための判定。
 * `SentenceSplitter` から呼ばれる純粋関数。
 */
export function isAbbreviationAt(text: string, endIndex: number, abbreviations: string[]): boolean {
  if (abbreviations.length === 0) {
    return false;
  }
  // endIndex はピリオドの位置。前後に連続する英字・ピリオドを含めた「語」を作る
  // （"a.m." のように語中にピリオドを持つ略語も 1 語として扱う）
  let start = endIndex;
  while (start > 0 && /[A-Za-z.]/.test(text[start - 1])) {
    start -= 1;
  }
  let end = endIndex + 1;
  while (end < text.length && /[A-Za-z.]/.test(text[end])) {
    end += 1;
  }
  const segment = text
    .slice(start, end)
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
  if (!segment) {
    return false;
  }
  if (abbreviations.includes(segment)) {
    return true;
  }
  // 末尾のピリオドが文末記号として重なった場合（例: "e.g.."）に備えて先頭語でも照合する
  const head = segment.split(".")[0];
  return abbreviations.includes(head);
}
