import { DeepPartial } from "./schema";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 設定を深く複製する（設定は JSON 互換値のみを想定） */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** base を patch で深く上書きした新しいオブジェクトを返す（配列は置換） */
export function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  const result = deepClone(base) as Record<string, unknown>;
  const source = patch as Record<string, unknown>;

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    const current = result[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      result[key] = deepMerge(current, value as DeepPartial<typeof current>);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
