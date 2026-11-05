import { ConfigManager } from "../config/ConfigManager";
import { CharacterProfile } from "../services/CharacterService";

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
