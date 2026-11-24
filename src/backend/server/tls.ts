import * as fs from "node:fs";
import * as path from "node:path";
import type { ServerConfig } from "../config/schema";

/** 読み込んだ TLS 証明書 */
export interface LoadedTls {
  key: Buffer;
  cert: Buffer;
  certPath: string;
  keyPath: string;
}

export type TlsLoadResult =
  | { ok: true; tls: LoadedTls }
  | {
      ok: false;
      reason: "disabled" | "missing" | "unreadable";
      message: string;
      certPath: string;
      keyPath: string;
    };

/**
 * 証明書と鍵のパスを解決する（設定が空なら `<root>/certs/server.crt|key`）。
 * 生成は `scripts\setup-https.ps1`（mkcert）が行う。
 */
export function resolveTlsPaths(
  rootDir: string,
  cfg: ServerConfig
): { certPath: string; keyPath: string } {
  const certPath = cfg.cert_path.trim() || path.join(rootDir, "certs", "server.crt");
  const keyPath = cfg.key_path.trim() || path.join(rootDir, "certs", "server.key");
  return { certPath, keyPath };
}

/**
 * 証明書を読み込む。無効・未配置・読めない場合は**理由つきで返す**
 * （呼び出し側は HTTP にフォールバックし、警告を出す）。
 */
export function loadTls(rootDir: string, cfg: ServerConfig): TlsLoadResult {
  const { certPath, keyPath } = resolveTlsPaths(rootDir, cfg);
  if (!cfg.https) {
    return {
      ok: false,
      reason: "disabled",
      message: "server.https=false のため HTTP で起動します",
      certPath,
      keyPath,
    };
  }
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    return {
      ok: false,
      reason: "missing",
      message: `証明書が見つかりません（scripts\\setup-https.ps1 で生成してください）: ${certPath}`,
      certPath,
      keyPath,
    };
  }
  try {
    return {
      ok: true,
      tls: {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
        certPath,
        keyPath,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: "unreadable",
      message: `証明書を読めません（${certPath}）: ${(error as Error).message}`,
      certPath,
      keyPath,
    };
  }
}
