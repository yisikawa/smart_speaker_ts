/** 画面レイアウト（chat: チャットのみ / stage: 配信向け / split: チャット + ステージ） */
export type StageMode = "chat" | "stage" | "split";

export interface StageOptions {
  mode: StageMode;
  transparent: boolean;
}

const MODES: StageMode[] = ["chat", "stage", "split"];

/**
 * `location.search` からレイアウトの指定を読む（`?mode=split&transparent=1`）。
 * `mode` が無い場合は 2 画面（split）を既定にする。
 */
export function parseStageOptions(search: string): StageOptions {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw = params.get("mode");
  const mode: StageMode = raw && (MODES as string[]).includes(raw) ? (raw as StageMode) : "split";
  const flag = params.get("transparent");
  const transparent = flag === "1" || flag === "true";
  return { mode, transparent };
}
