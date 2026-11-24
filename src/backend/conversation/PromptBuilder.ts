import { ConfigManager } from "../config/ConfigManager";
import type { LanguageMode } from "../config/schema";
import { CharacterProfile } from "../services/CharacterService";
import { getLanguagePack } from "../../shared/i18n/languagePack";

/**
 * LLM に渡す system プロンプトを組み立てる。
 * キャラクター定義（人格・応答ルール・口癖）とユーザー設定、
 * 言語モード（ja / en）のルールを反映する。
 *
 * 言語ルールを先頭と末尾の両方に置くのは、小規模モデル（gemma4:e2b 等）が
 * 韓国語・中国語・英語へ流れやすいため。
 */
export class PromptBuilder {
  constructor(
    private readonly deps: {
      config: ConfigManager;
      character: { get(language?: LanguageMode): CharacterProfile };
    }
  ) {}

  build(language?: LanguageMode): string {
    const mode: LanguageMode = language ?? this.deps.config.getLanguage();
    const pack = getLanguagePack(mode);
    const character = this.deps.character.get(mode);
    const gui = this.deps.config.getGUI();
    const llm = this.deps.config.getLLM();
    const now = new Date();

    const lines: string[] = [
      pack.prompt.roleLine(character.name),
      pack.prompt.languageRule,
      character.personality,
      "",
      mode === "en" ? `User name: ${gui.user_name}` : `ユーザー名: ${gui.user_name}`,
      mode === "en" ? `Current date/time: ${formatDateTime(now)}` : `現在の日時: ${formatDateTime(now)}`,
      "",
      mode === "en" ? "Response rules:" : "応答ルール:",
      character.responseRules,
      mode === "en"
        ? "- The reply is read aloud, so avoid symbols and bullet lists and write natural spoken English."
        : "- 音声で読み上げられるため、記号や箇条書きを多用せず自然な話し言葉にすること",
      mode === "en"
        ? `- Keep the reply to about ${Math.min(5, Math.max(1, Math.round(llm.max_tokens / 100)))} sentences.`
        : `- 出力は最大 ${Math.min(5, Math.max(1, Math.round(llm.max_tokens / 100)))} 文程度に収めること`,
    ];

    if (character.catchphrases.length > 0) {
      const phrases = character.catchphrases
        .slice(0, 4)
        .map((phrase) => `「${phrase}」`)
        .join(" ");
      lines.push(
        "",
        mode === "en"
          ? `Example phrases (use naturally, not every time): ${phrases}`
          : `口癖の例（自然に使える場合のみ・毎回は使わない）: ${phrases}`
      );
    }

    const avatar = this.deps.config.getAvatar();
    if (avatar.emotion_tags_enabled) {
      if (mode === "en") {
        lines.push(
          "",
          "Emotion:",
          "Put exactly one tag out of [happy] [angry] [sad] [surprised] [shy] [thinking] at a sentence boundary.",
          'Example: "Good morning! [happy] Nice weather today."',
          "Use only these six tags. Never write them as ordinary words."
        );
      } else {
        lines.push(
          "",
          "感情表現:",
          "文中に [喜] [怒] [哀] [驚] [照] [考] のいずれかを、文の区切りに 1 つだけ置くこと。",
          "例: 「おはよう！[喜] 今日もいい天気だね。」",
          "使えるのはこの 6 つだけ。文中の単語として書かないこと。"
        );
      }
    }

    // 末尾の指示は小規模モデルに効きやすいため、言語指定を最後にもう一度置く
    lines.push(pack.prompt.languageRuleShort);

    return lines.join("\n");
  }
}

function formatDateTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())} (${weekdayJa(date.getDay())})`;
}

function weekdayJa(day: number): string {
  return ["日", "月", "火", "水", "木", "金", "土"][day] ?? "";
}

