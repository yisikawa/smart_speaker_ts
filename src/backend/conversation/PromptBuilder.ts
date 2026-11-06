import { ConfigManager } from "../config/ConfigManager";
import { CharacterProfile } from "../services/CharacterService";

/**
 * 応答言語の指定。
 *
 * 小規模モデル（例: gemma4:e2b）は日本語の指示だけだと韓国語（ハングル）や
 * 中国語へ流れることがあるため、先頭と末尾の両方に強い制約を置く。
 */
const LANGUAGE_RULE =
  "【最重要】応答は必ず日本語で書くこと。ハングル（韓国語）・中国語・英語など他言語の文字を混ぜてはいけない。";
const LANGUAGE_RULE_SHORT = "- 日本語以外の言語（韓国語・中国語・英語など）の文字は使わないこと";

/**
 * LLM に渡す system プロンプトを組み立てる。
 * キャラクター定義（人格・応答ルール・口癖）とユーザー設定を反映する。
 */
export class PromptBuilder {
  constructor(
    private readonly deps: {
      config: ConfigManager;
      character: { get(): CharacterProfile };
    }
  ) {}

  build(): string {
    const character = this.deps.character.get();
    const gui = this.deps.config.getGUI();
    const llm = this.deps.config.getLLM();
    const now = new Date();

    const lines: string[] = [
      `あなたは「${character.name}」という日本語の音声アシスタントです。`,
      LANGUAGE_RULE,
      character.personality,
      "",
      `ユーザー名: ${gui.user_name}`,
      `現在の日時: ${formatDateTime(now)}`,
      "",
      "応答ルール:",
      character.responseRules,
      "- 音声で読み上げられるため、記号や箇条書きを多用せず自然な話し言葉にすること",
      `- 出力は最大 ${Math.min(5, Math.max(1, Math.round(llm.max_tokens / 100)))} 文程度に収めること`,
    ];

    if (character.catchphrases.length > 0) {
      lines.push(
        "",
        `口癖の例（自然に使える場合のみ・毎回は使わない）: ${character.catchphrases
          .slice(0, 4)
          .map((phrase) => `「${phrase}」`)
          .join(" ")}`
      );
    }

    // 末尾の指示は小規模モデルに効きやすいため、言語指定を最後にもう一度置く
    lines.push(LANGUAGE_RULE_SHORT);

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
