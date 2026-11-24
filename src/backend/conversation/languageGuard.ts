/**
 * 応答言語のガード。
 *
 * 小規模モデル（例: gemma4:e2b）は「日本語で」と指示してもハングル（韓国語）を
 * 混ぜることがあるため、生成結果を検査して 1 回だけ再生成させる。
 * 英語モードでは逆に、日本語・中国語・韓国語の文字が混ざっていないかを見る。
 */

import { LanguageMode, getLanguagePack } from "../../shared/i18n/languagePack";

/** ハングル（字母・互換字母・音節）の文字コード範囲 */
const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/;

/** 日本語（ひらがな・カタカナ・漢字）と中国語（漢字）の範囲 */
const CJK = /[\u3005-\u3007\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F]/;

/** ハングルが混ざっているか */
export function containsHangul(text: string): boolean {
  return HANGUL.test(text);
}

/** 日本語・中国語の文字が混ざっているか */
export function containsCjk(text: string): boolean {
  return CJK.test(text);
}

/**
 * 目標言語以外の文字が混ざっているか。
 * - ja: ハングル（従来どおり）
 * - en: 日本語・中国語・韓国語
 */
export function containsDisallowedScript(text: string, mode: LanguageMode): boolean {
  if (mode === "en") {
    return containsCjk(text) || containsHangul(text);
  }
  return containsHangul(text);
}

/** 再生成を促す追加の system 指示（日本語モードの既定文言） */
export const LANGUAGE_RETRY_INSTRUCTION = getLanguagePack("ja").prompt.retryInstruction;

/** 言語モード別の再生成指示 */
export function languageRetryInstruction(mode: LanguageMode): string {
  return getLanguagePack(mode).prompt.retryInstruction;
}

