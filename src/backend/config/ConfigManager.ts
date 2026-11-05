import * as fs from "fs";
import * as path from "path";
import { parse as parseToml } from "toml";
import {
  AppConfig,
  AudioConfig,
  ConversationConfig,
  DeepPartial,
  DEFAULT_CONFIG,
  GUIConfig,
  HomeAssistantConfig,
  LLMConfig,
  MusicConfig,
  ProactiveSpeechConfig,
  RAGConfig,
  RecipeDBConfig,
  STTConfig,
  TTSConfig,
  WakewordConfig,
} from "./schema";
import { stringifyToml } from "./tomlSerializer";
import { deepClone, deepMerge } from "./merge";
import { sanitizeConfig } from "./sanitize";
import { Logger } from "../core/logger";
import { ensureDir } from "../core/paths";

export interface ConfigManagerOptions {
  /** 相対パスの基準ディレクトリ（通常はプロジェクトルート） */
  rootDir: string;
  configPath?: string;
  defaultPath?: string;
  logger?: Logger;
}

export type ConfigListener = (config: AppConfig) => void;

const CONFIG_HEADER = [
  "# Sumika TypeScript 設定ファイル",
  "# このファイルはアプリ（PATCH /api/config）から自動生成・更新される場合があります。",
  "",
].join("\n");

/**
 * TOML 設定の読み込み・マージ・検証・保存を担う。
 * すべてのパスは rootDir 基準で解決するため、CWD に依存しない。
 */
export class ConfigManager {
  readonly rootDir: string;
  readonly configPath: string;
  readonly defaultPath: string;

  private readonly logger: Logger;
  private config: AppConfig = deepClone(DEFAULT_CONFIG);
  private warnings: string[] = [];
  private readonly listeners = new Set<ConfigListener>();

  constructor(options: ConfigManagerOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.configPath = path.resolve(this.rootDir, options.configPath ?? "config/settings.toml");
    this.defaultPath = path.resolve(this.rootDir, options.defaultPath ?? "config/settings.default.toml");
    this.logger = options.logger ?? new Logger("Config");
    this.reload();
  }

  /** 相対パスをプロジェクトルート基準の絶対パスへ変換する */
  resolvePath(target: string): string {
    if (!target) {
      return target;
    }
    return path.isAbsolute(target) ? target : path.resolve(this.rootDir, target);
  }

  /** 設定ファイルを読み直す（ユーザー設定 → 既定設定の順にフォールバック） */
  reload(): AppConfig {
    const source = fs.existsSync(this.configPath) ? this.configPath : this.defaultPath;

    if (!fs.existsSync(source)) {
      this.logger.warn(`設定ファイルが見つかりません: ${source}（既定値で起動します）`);
      this.config = deepClone(DEFAULT_CONFIG);
      this.warnings = ["設定ファイルが見つからないため既定値を使用しています"];
      return this.config;
    }

    try {
      const parsed = parseToml(fs.readFileSync(source, "utf-8")) as DeepPartial<AppConfig>;
      this.config = deepMerge(DEFAULT_CONFIG, parsed);
      this.warnings = sanitizeConfig(this.config);
      this.logger.info(`設定を読み込みました: ${path.relative(this.rootDir, source)}`);
      for (const warning of this.warnings) {
        this.logger.warn(warning);
      }
    } catch (error) {
      this.logger.error(`設定ファイルの解析に失敗しました: ${source}`, error);
      this.config = deepClone(DEFAULT_CONFIG);
      this.warnings = [`設定ファイルの解析に失敗したため既定値を使用しています: ${source}`];
    }
    return this.config;
  }

  /** 設定の部分更新（マージ → 検証 → 保存 → 購読者へ通知） */
  update(patch: DeepPartial<AppConfig>): AppConfig {
    this.config = deepMerge(this.config, patch);
    this.warnings = sanitizeConfig(this.config);
    this.save();
    for (const listener of this.listeners) {
      listener(this.config);
    }
    return this.config;
  }

  /** 現在の設定を settings.toml へ書き出す */
  save(): void {
    ensureDir(path.dirname(this.configPath));
    const body = stringifyToml(this.config as unknown as Record<string, unknown>);
    fs.writeFileSync(this.configPath, `${CONFIG_HEADER}${body}`, "utf-8");
    this.logger.info(`設定を保存しました: ${path.relative(this.rootDir, this.configPath)}`);
  }

  onChange(listener: ConfigListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  getAudio(): AudioConfig {
    return this.config.audio;
  }

  getWakeword(): WakewordConfig {
    return this.config.wakeword;
  }

  getConversation(): ConversationConfig {
    return this.config.conversation;
  }

  getSTT(): STTConfig {
    return this.config.stt;
  }

  getLLM(): LLMConfig {
    return this.config.llm;
  }

  getTTS(): TTSConfig {
    return this.config.tts;
  }

  getRAG(): RAGConfig {
    return this.config.rag;
  }

  getRecipeDB(): RecipeDBConfig {
    return this.config.recipe_db;
  }

  getMusic(): MusicConfig {
    return this.config.music;
  }

  getGUI(): GUIConfig {
    return this.config.gui;
  }

  getProactiveSpeech(): ProactiveSpeechConfig {
    return this.config.apps.proactive_speech;
  }

  getHomeAssistant(): HomeAssistantConfig {
    return this.config.apps.home_assistant;
  }

  get(): AppConfig {
    return this.config;
  }

  /** 秘匿情報をマスクした設定（API レスポンス用） */
  getMasked(): AppConfig {
    const masked = deepClone(this.config);
    if (masked.apps.home_assistant.token) {
      masked.apps.home_assistant.token = "***";
    }
    if (masked.music.spotify_client_id) {
      masked.music.spotify_client_id = "***";
    }
    return masked;
  }
}
