/**
 * src/frontend の静的ファイル（html / css など）を dist/frontend へコピーする。
 * tsc は .ts しか出力しないため、ビルドの最終段で実行する。
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src", "frontend");
const outDir = path.join(root, "dist", "frontend");
const STATIC_EXTENSIONS = new Set([".html", ".css", ".js.map"]);

fs.mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
  if (!entry.isFile()) {
    continue;
  }
  const ext = path.extname(entry.name).toLowerCase();
  if (!STATIC_EXTENSIONS.has(ext)) {
    continue;
  }
  fs.copyFileSync(path.join(srcDir, entry.name), path.join(outDir, entry.name));
  copied += 1;
}

console.log(`[build] 静的ファイルをコピーしました: ${copied} 件 -> ${path.relative(root, outDir)}`);
