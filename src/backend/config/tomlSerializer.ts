/**
 * 依存パッケージ `toml` (v3) は parse のみを提供するため、
 * 設定ファイル保存用の最小シリアライザを自前で持つ。
 *
 * 対応する値: スカラー / スカラー配列 / ネストしたテーブル（オブジェクト）
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    // JSON 文字列リテラルは TOML のベーシック文字列としてそのまま解釈できる
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`TOML へ変換できない数値です: ${value}`);
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatValue(item)).join(", ")}]`;
  }
  throw new Error(`TOML へ変換できない値です: ${String(value)}`);
}

function hasContent(table: Record<string, unknown>): boolean {
  for (const value of Object.values(table)) {
    if (isPlainObject(value)) {
      if (hasContent(value)) {
        return true;
      }
    } else {
      return true;
    }
  }
  return false;
}

function serializeTable(
  table: Record<string, unknown>,
  pathPrefix: string[],
  lines: string[]
): void {
  const scalars: string[] = [];
  const tables: [string, Record<string, unknown>][] = [];

  for (const [key, value] of Object.entries(table)) {
    if (isPlainObject(value)) {
      // 空テーブル（例: [apps]）は出力しない
      if (hasContent(value)) {
        tables.push([key, value]);
      }
    } else {
      scalars.push(`${key} = ${formatValue(value)}`);
    }
  }

  if (pathPrefix.length > 0 && scalars.length > 0) {
    lines.push("", `[${pathPrefix.join(".")}]`);
  }
  lines.push(...scalars);

  for (const [key, value] of tables) {
    serializeTable(value, [...pathPrefix, key], lines);
  }
}

export function stringifyToml(table: Record<string, unknown>): string {
  const lines: string[] = [];
  serializeTable(table, [], lines);
  return `${lines.join("\n").replace(/^\n/, "")}\n`;
}
