/**
 * config/settings.default.toml を schema.ts の DEFAULT_CONFIG と同期する。
 *
 * - 既存のコメント行・並び順はそのまま残し、**値の更新と不足キーの追加**だけを行う
 * - 未実装セクション（wakeword/rag/recipe_db/music/apps.*）は出力しない
 *
 * 使い方: npm run config:default（内部で tsc してから dist の既定値を読む）
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const targetPath = path.join(root, "config", "settings.default.toml");

const { DEFAULT_CONFIG } = require(path.join(root, "dist", "backend", "config", "schema.js"));
const { UNSUPPORTED_SECTIONS } = require(path.join(root, "dist", "backend", "config", "ConfigManager.js"));

/** 未実装セクションに属するキーか */
function isUnsupported(section) {
  return UNSUPPORTED_SECTIONS.some((name) => section === name || section.startsWith(`${name}.`));
}

function formatValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  throw new Error(`TOML へ変換できない値です: ${String(value)}`);
}

/** 行に書かれている値が既定値と「意味的に」等しいか（`3` と `3.0` を同一視する） */
function sameValue(rawLine, expected) {
  const raw = rawLine.slice(rawLine.indexOf("=") + 1).trim();
  if (typeof expected === "number") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed === expected;
  }
  if (typeof expected === "boolean") {
    return raw === String(expected);
  }
  try {
    return JSON.stringify(JSON.parse(raw)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

/** DEFAULT_CONFIG を { "audio.sample_rate": 16000 } の形へ平坦化する */
function flatten(table, prefix = [], out = new Map()) {
  for (const [key, value] of Object.entries(table)) {
    const section = [...prefix, key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      flatten(value, section, out);
    } else {
      out.set(section.join("."), value);
    }
  }
  return out;
}

/** [section] 行の位置と、そのセクションに属するキー行の範囲を求める */
function indexSections(lines) {
  const sections = new Map(); // section -> { header, lastKeyLine }
  let current = null;
  lines.forEach((line, index) => {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      current = header[1];
      sections.set(current, { header: index, lastKeyLine: index });
      return;
    }
    if (current && /^\s*[A-Za-z0-9_]+\s*=/.test(line)) {
      sections.get(current).lastKeyLine = index;
    }
  });
  return sections;
}

const original = fs.readFileSync(targetPath, "utf-8");
const usesCrlf = original.includes("\r\n");
const lines = original.replace(/\r\n/g, "\n").split("\n");
const expected = flatten(DEFAULT_CONFIG);

let updated = 0;
let added = 0;

for (const [fullKey, value] of expected) {
  const lastDot = fullKey.lastIndexOf(".");
  const section = lastDot === -1 ? "" : fullKey.slice(0, lastDot);
  const key = lastDot === -1 ? fullKey : fullKey.slice(lastDot + 1);
  if (isUnsupported(section)) {
    continue;
  }

  const sections = indexSections(lines);
  const entry = sections.get(section);
  if (!entry) {
    // セクションごと無い場合はファイル末尾へ追加する
    lines.push("", `[${section}]`, `${key} = ${formatValue(value)}`);
    added += 1;
    continue;
  }

  // セクション内の該当キー行を探す
  let found = -1;
  for (let i = entry.header + 1; i <= entry.lastKeyLine; i += 1) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=/.exec(lines[i]);
    if (match && match[1] === key) {
      found = i;
      break;
    }
  }

  const next = `${key} = ${formatValue(value)}`;
  if (found >= 0) {
    if (!sameValue(lines[found], value)) {
      lines[found] = next;
      updated += 1;
    }
  } else {
    lines.splice(entry.lastKeyLine + 1, 0, next);
    added += 1;
  }
}

const output = lines.join("\n").replace(/\n+$/, "\n");
fs.writeFileSync(targetPath, usesCrlf ? output.replace(/\n/g, "\r\n") : output, "utf-8");
console.log(`[config] settings.default.toml を同期しました（更新 ${updated} / 追加 ${added} 件）`);
