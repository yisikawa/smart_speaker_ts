import * as fs from "fs";
import * as path from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerOptions {
  level?: LogLevel;
  /** ログファイルパス（null で無効） */
  file?: string | null;
}

/**
 * 依存ライブラリを増やさない軽量ロガー。
 * コンソール出力と任意のファイル追記を同時に行う。
 */
export class Logger {
  private static level: LogLevel = "info";
  private static file: string | null = null;

  static configure(options: LoggerOptions): void {
    if (options.level) {
      Logger.level = options.level;
    }
    if (options.file !== undefined) {
      Logger.file = options.file;
    }
  }

  static isEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[Logger.level];
  }

  constructor(private readonly scope: string) {}

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`);
  }

  debug(message: string, meta?: unknown): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (!Logger.isEnabled(level)) {
      return;
    }
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}${
      meta === undefined ? "" : ` ${safeStringify(meta)}`
    }`;

    const sink = level === "error" || level === "warn" ? console.error : console.log;
    sink(line);

    if (Logger.file) {
      try {
        fs.mkdirSync(path.dirname(Logger.file), { recursive: true });
        fs.appendFileSync(Logger.file, `${line}\n`, "utf-8");
      } catch {
        // ログ出力の失敗でアプリを止めない
      }
    }
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
