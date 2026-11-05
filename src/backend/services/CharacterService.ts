import * as fs from "fs";
import { parse as parseToml } from "toml";
import { ConfigManager } from "../config/ConfigManager";
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

  constructor(private readonly deps: { config: ConfigManager; logger?: Logger }) {
    this.logger = deps.logger ? deps.logger.child("Character") : new Logger("Character");
    this.reload();
  }

  private filePath(): string {
    return this.deps.config.resolvePath(this.deps.config.getLLM().character_file);
  }

  reload(): CharacterProfile {
    const file = this.filePath();
    if (!fs.existsSync(file)) {
      this.logger.warn(`キャラクターファイルが見つかりません: ${file}（既定プロファイルを使用します）`);
      this.profile = FALLBACK;
      return this.profile;
    }

    try {
      const raw = parseToml(fs.readFileSync(file, "utf-8")) as RawCharacter;
      this.profile = {
        name: raw.name?.trim() || FALLBACK.name,
        label: raw.label?.trim() || FALLBACK.label,
        personality: raw.personality?.trim() || FALLBACK.personality,
        responseRules: raw.response_rules?.trim() || FALLBACK.responseRules,
        catchphrases: Array.isArray(raw.catchphrases)
          ? raw.catchphrases.filter((phrase): phrase is string => typeof phrase === "string")
          : [],
      };
      this.logger.info(`キャラクターを読み込みました: ${this.profile.name}`);
    } catch (error) {
      this.logger.error(`キャラクターファイルの解析に失敗しました: ${file}`, error);
      this.profile = FALLBACK;
    }
    return this.profile;
  }

  get(): CharacterProfile {
    return this.profile;
  }
}
