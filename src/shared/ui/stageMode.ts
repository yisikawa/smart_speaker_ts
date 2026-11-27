/** 画面レイアウト（chat: チャットのみ / stage: 配信向け / split: チャット + ステージ / studio: キャラクター + 左下チャット） */
export type StageMode = "chat" | "stage" | "split" | "studio";

export interface StageOptions {
  mode: StageMode;
  transparent: boolean;
}

const MODES: StageMode[] = ["chat", "stage", "split", "studio"];

/**
 * `location.search` からレイアウトの指定を読む（`?mode=studio&transparent=1`）。
 * `mode` が無い場合は studio（キャラクター + 左下チャット）を既定にする。
 */
export function parseStageOptions(search: string): StageOptions {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw = params.get("mode");
  const mode: StageMode = raw && (MODES as string[]).includes(raw) ? (raw as StageMode) : "studio";
  const flag = params.get("transparent");
  const transparent = flag === "1" || flag === "true";
  return { mode, transparent };
}
