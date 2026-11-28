/**
 * 実効ポートを解決して標準出力に出す。
 *
 * 優先順位: PORT 環境変数 > config/settings.toml の [server].port
 *           > config/settings.default.toml の [server].port > 3000
 *
 * start.bat / quit.bat / start-stage.bat / setup-https.ps1 / smoke.js から使う。
 * ここだけは dist に依存せず、単体で動く（初回起動や quit でも使えるように）。
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_PORT = 3000;
const MIN_PORT = 1;
const MAX_PORT = 65535;

function isValidPort(value) {
  return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

/** TOML の [server].port を読む（無い・不正・解析失敗は undefined） */
function readPortFromToml(file) {
  try {
    const parsed = require("toml").parse(fs.readFileSync(file, "utf8"));
    const port = parsed && parsed.server ? parsed.server.port : undefined;
    return isValidPort(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 実効ポートを返す。
 * `rootDir` と `envPort` はテスト用に差し替えられる。
 */
function resolvePort(options = {}) {
  const rootDir = options.rootDir ?? path.resolve(__dirname, "..");
  const envPort = Object.prototype.hasOwnProperty.call(options, "envPort")
    ? options.envPort
    : process.env.PORT;

  if (envPort !== undefined && envPort !== null && String(envPort).trim() !== "") {
    const parsed = Number(envPort);
    if (isValidPort(parsed)) {
      return parsed;
    }
  }

  return (
    readPortFromToml(path.join(rootDir, "config", "settings.toml")) ??
    readPortFromToml(path.join(rootDir, "config", "settings.default.toml")) ??
    DEFAULT_PORT
  );
}

if (require.main === module) {
  process.stdout.write(String(resolvePort()));
}

module.exports = { DEFAULT_PORT, MIN_PORT, MAX_PORT, isValidPort, readPortFromToml, resolvePort };
