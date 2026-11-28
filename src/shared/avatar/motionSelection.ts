import type { EmotionKey } from "./emotion";

/**
 * 感情キーからモーショングループを選ぶ。
 * 未設定・空文字・現在再生中のグループと同じ場合は null（再生しない）。
 */
export function selectMotionGroup(
  motions: Record<string, string>,
  emotion: EmotionKey | null | undefined,
  current: string | null
): string | null {
  if (!emotion) {
    return null;
  }
  const value = motions[emotion];
  if (typeof value !== "string") {
    return null;
  }
  const group = value.trim();
  if (!group || group === current) {
    return null;
  }
  return group;
}
