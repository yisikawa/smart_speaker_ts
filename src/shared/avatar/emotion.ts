import type { EmotionVocabulary } from "../i18n/languagePack";

export type EmotionKey = "happy" | "angry" | "sad" | "surprised" | "shy" | "thinking";

/** プロンプトに出すタグ → 意味キー */
export const EMOTION_TAGS: Record<string, EmotionKey> = {
  "喜": "happy",
  "怒": "angry",
  "哀": "sad",
  "驚": "surprised",
  "照": "shy",
  "考": "thinking",
};

const TAG_PATTERN = /\[([^\]]{1,12})\]/g;

/** 推定に使う語彙（上から順に判定する）。言語パックから差し替えられる */
const HEURISTICS: EmotionVocabulary[] = [
  { key: "surprised", words: ["えっ", "まさか", "本当", "びっくり", "！？", "?!"] },
  { key: "angry", words: ["むかつ", "ふざけ", "ダメ", "だめ", "怒"] },
  { key: "sad", words: ["ごめん", "残念", "悲し", "つらい", "寂し"] },
  { key: "shy", words: ["はずかし", "恥ずかし", "照れ"] },
  { key: "happy", words: ["ありがとう", "うれし", "嬉し", "楽しい", "やった", "すごい", "いいね"] },
  { key: "thinking", words: ["どうしよ", "たぶん", "かな", "考え"] },
];


export interface EmotionExtraction {
  /** タグを除去した読み上げ用テキスト */
  text: string;
  /** 解決済みのモデル表情名（無ければ null） */
  expression: string | null;
}

/**
 * 応答文から感情タグを取り除き、モデルの表情名へ解決する。
 *
 * - `[喜]`（日本語キー）と `[happy]`（英語キー）の両方を受ける
 * - タグが無い場合は `options.heuristic` のときだけ語彙から推定する
 * - 未知のタグは落とすが表情は変えない
 */
export function extractEmotion(
  text: string,
  expressions: Record<string, string>,
  options: { heuristic?: boolean; vocabulary?: EmotionVocabulary[] } = {}
): EmotionExtraction {
  let key: EmotionKey | null = null;
  const stripped = text.replace(TAG_PATTERN, (_match, raw: string) => {
    const resolved = resolveKey(raw);
    if (resolved) {
      key = resolved;
    }
    return "";
  });

  if (!key && options.heuristic) {
    key = inferEmotion(stripped, options.vocabulary);
  }

  const expression = key ? expressions[key] || null : null;
  return { text: stripped.replace(/\s{2,}/g, " ").trim(), expression };
}

/** タグの中身（日本語 or 英語キー）を意味キーへ */
export function resolveKey(raw: string): EmotionKey | null {
  const trimmed = raw.trim();
  if (trimmed in EMOTION_TAGS) {
    return EMOTION_TAGS[trimmed];
  }
  return isEmotionKey(trimmed) ? trimmed : null;
}

/** 文から感情を推定する（見つからなければ null） */
export function inferEmotion(
  text: string,
  vocabulary: EmotionVocabulary[] = HEURISTICS
): EmotionKey | null {
  for (const rule of vocabulary) {
    if (rule.words.some((word) => text.includes(word))) {
      return rule.key;
    }
  }
  return null;
}

function isEmotionKey(value: string): value is EmotionKey {
  return ["happy", "angry", "sad", "surprised", "shy", "thinking"].includes(value);
}
