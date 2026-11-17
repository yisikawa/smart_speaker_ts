import * as fs from "fs";
import * as path from "path";
import {
  AvatarModelInfo,
  createAvatarModelInfo,
  parseModel3Json,
} from "../../shared/avatar/modelCatalog";

/**
 * Live2D モデルを置くディレクトリ名（プロジェクトルート直下）。
 * 旧名 `live2d-models` と、VTube Studio の書き出しでよく使う `Live2DModels` の両方を見る。
 */
export const AVATAR_MODEL_DIRS = ["live2d-models", "Live2DModels"] as const;

/**
 * `live2d-models/<dir>/*.model3.json` / `Live2DModels/<dir>/*.model3.json` を列挙する
 * （ディレクトリが無ければ空配列）。壊れた JSON でも候補には残す（画面で選べるようにするため）。
 */
export function listAvatarModels(rootDir: string): AvatarModelInfo[] {
  const models: AvatarModelInfo[] = [];

  for (const dirName of AVATAR_MODEL_DIRS) {
    const baseDir = path.join(rootDir, dirName);
    if (!fs.existsSync(baseDir)) {
      continue;
    }

    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(baseDir, entry.name);
      for (const file of fs.readdirSync(dir)) {
        if (!file.toLowerCase().endsWith(".model3.json")) {
          continue;
        }
        const full = path.join(dir, file);
        let meta = { expressions: [] as string[], motions: [] as string[] };
        try {
          meta = parseModel3Json(JSON.parse(fs.readFileSync(full, "utf-8"))) ?? meta;
        } catch {
          // 解析できなくても候補としては返す
        }
        models.push(
          createAvatarModelInfo({
            relativePath: path.relative(rootDir, full),
            label: entry.name,
            meta,
          })
        );
      }
    }
  }

  return models.sort(
    (a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path)
  );
}
