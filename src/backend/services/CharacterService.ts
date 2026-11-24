import * as fs from "fs";
import { parse as parseToml } from "toml";
import { ConfigManager } from "../config/ConfigManager";
import type { LanguageMode } from "../config/schema";
import { Logger } from "../core/logger";

export interface CharacterProfile {
  name: string;
  label: string;
  personality: string;
  responseRules: string;
  catchphrases: string[];
}

const FALLBACK: CharacterProfile = {
  name: "アシスタント",
  label: "標準",
  personality: "親切で簡潔に答える日本語のアシスタント。",
  responseRules: "- 3 文以内で簡潔に答える",
  catchphrases: [],
};

interface RawCharacter {
  name?: string;
  label?: string;
  personality?: string;
  response_rules?: string;
  catchphrases?: string[];
}

/**
 * キャラクター定義（TOML）を読み込む。
 * 旧実装は正規表現で name と personality だけを抽出していたが、
 * response_rules / catchphrases も含めて TOML パーサで正しく読み込む。
 */
export class CharacterService {
  private readonly logger: Logger;
  private profile: CharacterProfile = FALLBACK;
  /** 言語別のプロファイル（en は `llm.character_file_en`。未指定なら ja を共有） */
  private profiles: Record<LanguageMode, CharacterProfile> = { ja: FALLBACK, en: FALLBACK };

  constructor(private readonly deps: { config: ConfigManager; logger?: Logger }) {
    this.logger = deps.logger ?? new Logger("Character");
    this.reload();
  }

  private filePath(language: LanguageMode = "ja"): string {
    const llm = this.deps.config.getLLM();
    const configured = language === "en" ? llm.character_file_en.trim() : "";
    return this.deps.config.resolvePath(configured || llm.character_file);
  }

  /** TOML を読み込む（見つからない・壊れている場合は null） */
  private loadFile(file: string): CharacterProfile | null {
    if (!fs.existsSync(file)) {
      this.logger.warn(`キャラクターファイルが見つかりません: ${file}`);
      return null;
    }
    try {
      const raw = parseToml(fs.readFileSync(file, "utf-8")) as RawCharacter;
      return {
        name: raw.name?.trim() || FALLBACK.name,
        label: raw.label?.trim() || FALLBACK.label,
        personality: raw.personality?.trim() || FALLBACK.personality,
        responseRules: raw.response_rules?.trim() || FALLBACK.responseRules,
        catchphrases: Array.isArray(raw.catchphrases)
          ? raw.catchphrases.filter((phrase): phrase is string => typeof phrase === "string")
          : [],
      };
    } catch (error) {
      this.logger.error(`キャラクターファイルの解析に失敗しました: ${file}`, error);
      return null;
    }
  }

  reload(): CharacterProfile {
    const jaFile = this.filePath("ja");
    const ja = this.loadFile(jaFile);
    if (!ja) {
      this.logger.warn(`既定プロファイルを使用します: ${jaFile}`);
    }
    this.profiles.ja = ja ?? FALLBACK;

    const enFile = this.filePath("en");
    // 英語用が未指定なら日本語のプロファイルを共有する（プロンプトの言語ルールは別途上書き）
    const en = enFile === jaFile ? this.profiles.ja : this.loadFile(enFile) ?? this.profiles.ja;
    this.profiles.en = en;

    this.profile = this.profiles.ja;
    this.logger.info(
      `キャラクターを読み込みました: ${this.profiles.ja.name}` +
        (this.profiles.en !== this.profiles.ja ? ` / ${this.profiles.en.name} (en)` : "")
    );
    return this.profile;
  }

  /** 言語別のプロファイル（既定は日本語） */
  get(language: LanguageMode = "ja"): CharacterProfile {
    return this.profiles[language] ?? this.profile;
  }

  /** 表示用のファイルパス（診断用） */
  getFilePath(language: LanguageMode = "ja"): string {
    return this.filePath(language);
  }
}

