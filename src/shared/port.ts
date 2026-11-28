/** サーバーの待受ポート（`[server] port` / `PORT` 環境変数）の解決ロジック。 */

export const DEFAULT_PORT = 3000;
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

/** ポート番号として有効な整数か */
export function isValidPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_PORT &&
    value <= MAX_PORT
  );
}

/**
 * 実効ポートを決める。
 *
 * 優先順位: `PORT` 環境変数（有効な整数のとき） > `[server] port` > 既定 3000。
 * 不正な環境変数は無視して設定値へフォールバックする。
 */
export function resolvePort(
  envValue: string | undefined,
  configValue: unknown,
  fallback: number = DEFAULT_PORT
): number {
  const env = envValue?.trim();
  if (env) {
    const parsed = Number(env);
    if (isValidPort(parsed)) {
      return parsed;
    }
  }
  return isValidPort(configValue) ? configValue : fallback;
}
