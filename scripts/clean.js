/** ビルド成果物（dist / dist-test）を削除する */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

for (const dir of ["dist", "dist-test"]) {
  const target = path.join(root, dir);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[clean] 削除: ${dir}`);
  }
}
