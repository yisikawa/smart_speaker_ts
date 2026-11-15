export interface StageOptions {
  mode: "chat" | "stage";
  transparent: boolean;
}

/** `location.search` からレイアウトの指定を読む（`?mode=stage&transparent=1`） */
export function parseStageOptions(search: string): StageOptions {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const mode = params.get("mode") === "stage" ? "stage" : "chat";
  const flag = params.get("transparent");
  const transparent = flag === "1" || flag === "true";
  return { mode, transparent };
}
