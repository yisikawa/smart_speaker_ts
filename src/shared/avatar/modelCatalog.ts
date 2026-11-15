/**
 * Live2D モデル（model3.json）の解析と URL 化（純粋ロジック）。
 * ファイル走査は `src/backend/services/avatarCatalog.ts` が担う。
 */

export interface AvatarModelInfo {
  /** プロジェクトルート基準のパス（`/` 区切り） */
  path: string;
  /** ブラウザから取得する URL */
  url: string;
  /** 表示名（フォルダ名） */
  label: string;
  /** モデルの表情名 */
  expressions: string[];
  /** モーションのグループ名 */
  motions: string[];
}

/** Windows の `\` を `/` に直し、先頭の `/` を落とす */
export function toUrlPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** model3.json から表情名とモーショングループ名を取り出す（不正なら null） */
export function parseModel3Json(raw: unknown): { expressions: string[]; motions: string[] } | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const refs = (raw as { FileReferences?: unknown }).FileReferences;
  if (!refs || typeof refs !== "object") {
    return null;
  }
  const { Expressions, Motions } = refs as { Expressions?: unknown; Motions?: unknown };
  const expressions = Array.isArray(Expressions)
    ? Expressions.map((entry) =>
        entry && typeof entry === "object" ? (entry as { Name?: unknown }).Name : undefined
      ).filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];
  const motions =
    Motions && typeof Motions === "object" ? Object.keys(Motions as Record<string, unknown>) : [];

  // 表情もモーションも無い model3.json は「使えるモデル」とみなさない
  if (expressions.length === 0 && motions.length === 0) {
    return null;
  }
  return { expressions, motions };
}

/** 表示用のモデル情報を組み立てる */
export function createAvatarModelInfo(options: {
  relativePath: string;
  label: string;
  meta: { expressions: string[]; motions: string[] };
}): AvatarModelInfo {
  const path = toUrlPath(options.relativePath);
  return {
    path,
    url: `/${path}`,
    label: options.label,
    expressions: options.meta.expressions,
    motions: options.meta.motions,
  };
}
