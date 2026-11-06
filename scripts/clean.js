/**
 * ビルド成果物を削除する。
 *
 *   node scripts/clean.js          … dist と dist-test の両方
 *   node scripts/clean.js --tests  … dist-test のみ（テスト実行前の掃除）
 *   node scripts/clean.js --dist   … dist のみ
 *
 * テスト前に dist-test を消さないと、削除したテストの古い成果物が実行されて
 * 「存在しないテストが失敗する」ような誤判定が起きる。
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const targets = args.includes("--tests")
  ? ["dist-test"]
  : args.includes("--dist")
    ? ["dist"]
    : ["dist", "dist-test"];

for (const dir of targets) {
  const target = path.join(root, dir);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[clean] 削除: ${dir}`);
  }
}
