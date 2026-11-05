/**
 * フロントエンドのビルド。
 * 1) src/frontend の html / css を dist/frontend へコピー
 * 2) app.ts（と src/shared の共有モジュール）を esbuild で 1 ファイルに束ねる
 *
 * tsc を CommonJS で出力すると `exports`、ES2020 で出力すると `export {}` や
 * 拡張子なし import がブラウザで問題になるため、配信物は esbuild の IIFE バンドルとする。
 */
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src", "frontend");
const outDir = path.join(root, "dist", "frontend");
const STATIC_EXTENSIONS = new Set([".html", ".css"]);

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

esbuild.buildSync({
  entryPoints: [path.join(srcDir, "app.ts")],
  outfile: path.join(outDir, "app.js"),
  bundle: true,
  format: "iife",
  target: ["es2020"],
  platform: "browser",
  sourcemap: true,
  logLevel: "warning",
});

console.log(
  `[build] 静的ファイル ${copied} 件をコピーし、app.js をバンドルしました -> ${path.relative(root, outDir)}`
);
