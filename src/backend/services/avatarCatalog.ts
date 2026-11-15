import * as fs from "fs";
import * as path from "path";
import {
  AvatarModelInfo,
  createAvatarModelInfo,
  parseModel3Json,
} from "../../shared/avatar/modelCatalog";

/**
 * `live2d-models/<dir>/*.model3.json` を列挙する（ディレクトリが無ければ空配列）。
 * 壊れた JSON でも候補には残す（画面で選べるようにするため）。
 */
export function listAvatarModels(rootDir: string): AvatarModelInfo[] {
  const baseDir = path.join(rootDir, "live2d-models");
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const models: AvatarModelInfo[] = [];
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

  return models.sort((a, b) => a.label.localeCompare(b.label));
}
