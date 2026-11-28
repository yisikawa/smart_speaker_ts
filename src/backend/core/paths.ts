import * as fs from "fs";
import * as path from "path";

/**
 * package.json を持つディレクトリをプロジェクトルートとして返す。
 * 実行時 CWD に依存しないパス解決のために使う。
 */
export function findProjectRoot(startDir: string = __dirname): string {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 10; depth++) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return process.cwd();
}

/** ディレクトリを再帰的に作成する（既存なら何もしない） */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * 実行時の一時ファイル置き場（プロジェクト配下の `tmp/`）。
 *
 * C: の `%TEMP%` は使わない。Windows のセキュリティソフトが子プロセス
 * （whisper.cpp など）の C: への書き込みをブロックし、出力ファイルが作れず
 * STT が空になる環境があるため、アプリが書き込みを確認できるプロジェクト内に置く。
 */
export function runtimeTempDir(rootDir: string): string {
  const dir = path.join(rootDir, "tmp");
  ensureDir(dir);
  return dir;
}
