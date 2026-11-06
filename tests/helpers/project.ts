/**
 * テスト共通ヘルパ。
 *
 * 一時プロジェクト（rootDir + settings.toml）の作成と後始末を 1 箇所にまとめ、
 * 各テストで `mkdtempSync` + `ConfigManager` + `config.update` を書き写さないようにする。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigManager } from "../../src/backend/config/ConfigManager";
import type { AppConfig, DeepPartial } from "../../src/backend/config/schema";
import { encodeWav } from "../../src/backend/services/wav";

/** リポジトリのルート（dist-test/tests/helpers → 3 階層上） */
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

export interface TempProject {
  rootDir: string;
  config: ConfigManager;
  /** 一時ディレクトリを削除する */
  cleanup(): void;
}

export interface TempProjectOptions {
  /** 一時ディレクトリ名の接頭辞（既定 `sumika-test-`） */
  prefix?: string;
  /** `settings.toml` に書き込む設定（ConfigManager.update 経由） */
  patch?: DeepPartial<AppConfig>;
  /** リポジトリの `config/` をコピーする（キャラクター定義を読むテスト用） */
  copyConfig?: boolean;
}

/** 一時プロジェクトを作る（呼び出し側で必ず cleanup すること） */
export function createTempProject(options: TempProjectOptions = {}): TempProject {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? "sumika-test-"));
  if (options.copyConfig) {
    fs.cpSync(path.join(PROJECT_ROOT, "config"), path.join(rootDir, "config"), { recursive: true });
  }
  const config = new ConfigManager({ rootDir });
  if (options.patch) {
    config.update(options.patch);
  }
  return {
    rootDir,
    config,
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
  };
}

/** 設定だけが目的の一時ディレクトリ（ConfigManager を作らない） */
export function createTempDir(prefix = "sumika-test-"): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** テスト用の WAV（既定: 16kHz / モノラル / 16bit / 100ms） */
export function makeWav(options: { ms?: number; sampleRate?: number; value?: number } = {}): Buffer {
  const sampleRate = options.sampleRate ?? 16000;
  const ms = options.ms ?? 100;
  const samples = Math.round((sampleRate * ms) / 1000);
  return encodeWav(Buffer.alloc(samples * 2, options.value ?? 1), sampleRate);
}
