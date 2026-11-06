/**
 * 応答言語のガード。
 *
 * 小規模モデル（例: gemma4:e2b）は「日本語で」と指示してもハングル（韓国語）を
 * 混ぜることがあるため、生成結果を検査して 1 回だけ再生成させる。
 */

/** ハングル（字母・互換字母・音節）の文字コード範囲 */
const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/;

/** ハングルが混ざっているか */
export function containsHangul(text: string): boolean {
  return HANGUL.test(text);
}

/** 再生成を促す追加の system 指示 */
export const LANGUAGE_RETRY_INSTRUCTION =
  "前回の応答にはハングル（韓国語）が混ざっていたため破棄しました。今度は日本語だけで書いてください。";
