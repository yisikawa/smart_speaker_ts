# サーバー待受ポート設定化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 待受ポートを `[server] port` の設定項目にし、`PORT` 環境変数の上書きを残しつつ、start / quit / smoke / stage / HTTPS 案内が同じ値を見るようにする。

**Architecture:** 設定ファイルの `[server] port` を単一の源にする。サーバーは `PORT` 環境変数 > 設定値の順で決定し、スクリプト群は `scripts/resolve-port.js` で同じ優先順位を解決する。既定値は 3000。

**Tech Stack:** TypeScript strict / Node.js / `node:test` / 既存依存の `toml` / Windows batch / PowerShell。

**設計書:** `docs/superpowers/specs/2026-11-28-server-port-config-design.md`

## Global Constraints

- 既定値は **3000**。優先順位は **`PORT` 環境変数 > `[server] port` > 3000**。
- ポートは **1..65535 の整数**。範囲外・非整数は 3000 に補正する。
- 新しい依存パッケージを追加しない（`toml` は既存依存）。
- コメント・UI 文言・ログは日本語。
- **コミット・push・PR はユーザーの明示承認があるまで行わない。** 各タスクのコミット手順は「承認後のみ」実行する。
- リポジトリの規約では作業ブランチは `develop`。現在 `main` の場合は、実行前にユーザーへ確認して切り替える。
- 作業ツリーには設計時に作った試作変更がある。Task 1〜3 は試作と照合し、差分があればこの計画のコードに合わせる。

## 現状の作業ツリー（開始時）

`git status --short` で次を確認する。

- 変更済み: `config/settings.default.toml`, `src/backend/config/schema.ts`,
  `src/backend/config/sanitize.ts`, `src/backend/index.ts`
- 未追跡: `src/shared/port.ts`, `scripts/resolve-port.js`, `tests/port.test.ts`,
  `docs/superpowers/specs/2026-11-28-server-port-config-design.md`
- `config/settings.toml` は gitignore 対象。ローカルポートが設定済みならその値を使う。

試作が Task 1〜3 の実装をすでに含むため、Task 1/2 の「失敗確認」は再現しない。
試作をそのまま使う場合は失敗確認を省略し、Task 1 Step 6 / Task 2 Step 5 の PASS を確認する。

---

### Task 1: `[server] port` のスキーマ・既定値・検証

**Files:**
- Modify: `src/backend/config/schema.ts:326-340`（`ServerConfig`）, `src/backend/config/schema.ts:585-590`（`DEFAULT_CONFIG.server`）
- Modify: `src/backend/config/sanitize.ts:268-277`（`[server]` の検証）
- Modify: `config/settings.default.toml`（`[server]`）
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `DEFAULT_CONFIG.server.port: number`（3000）、`AppConfig["server"]["port"]: number`
- Consumes: なし

- [ ] **Step 1: 失敗するテストを追加する**

`tests/config.test.ts` の既存 `sanitizeConfig` テストの後に追加する。

```ts
test("server.port の既定値は 3000", () => {
  assert.equal(DEFAULT_CONFIG.server.port, 3000);
});

test("sanitizeConfig は server.port を 1..65535 の整数に補正する", () => {
  const config = clone();
  config.server.port = 70000;
  const warnings = sanitizeConfig(config);
  assert.equal(config.server.port, DEFAULT_CONFIG.server.port);
  assert.ok(warnings.some((w) => w.includes("server.port")));
});

test("ConfigManager は settings.toml の server.port を読む", () => {
  const dir = tempDir();
  try {
    const manager = new ConfigManager({ rootDir: dir });
    manager.update({ server: { port: 8080 } });
    assert.equal(manager.getServer().port, 8080);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run:
```powershell
npx tsc -p tsconfig.test.json
```
Expected: `Property 'port' does not exist on type 'ServerConfig'` で失敗する。

- [ ] **Step 3: スキーマと既定値を実装する**

`src/backend/config/schema.ts` の `ServerConfig` を次の形にする。

```ts
/** 配信（HTTPS・LAN 公開）の設定 */
export interface ServerConfig {
  /** 待受ポート（1..65535）。`PORT` 環境変数が設定されていればそちらを優先する */
  port: number;
  /**
   * HTTPS で待ち受ける。`certs/server.crt` と `certs/server.key` が無いときは
   * HTTP にフォールバックする（起動ログに警告を出す）。
   * ブラウザのマイク（`getUserMedia`）は secure context（https か localhost）でのみ動くため、
   * LAN の IP で開くときはこれが必要。
   */
  https: boolean;
  /** 証明書のパス（空なら `<root>/certs/server.crt`） */
  cert_path: string;
  /** 秘密鍵のパス（空なら `<root>/certs/server.key`） */
  key_path: string;
  /** 待受アドレス（空なら全インターフェース = LAN からアクセス可能） */
  host: string;
}
```

`src/backend/config/schema.ts` の `DEFAULT_CONFIG.server` を次の形にする。

```ts
  server: {
    port: 3000,
    https: true,
    cert_path: "",
    key_path: "",
    host: "",
  },
```

- [ ] **Step 4: 設定検証を実装する**

`src/backend/config/sanitize.ts` の `[server]` の `else` ブロックの先頭に追加する。

```ts
    if (!Number.isInteger(srv.port) || srv.port < 1 || srv.port > 65535) {
      warnings.push(
        `server.port=${String(srv.port)} は 1..65535 の整数ではないため ${DEFAULT_CONFIG.server.port} を使用します`
      );
      srv.port = DEFAULT_CONFIG.server.port;
    }
```

- [ ] **Step 5: `settings.default.toml` に既定値を追加する**

`config/settings.default.toml` の `[server]` の先頭に追加する。

```toml
[server]
# 待受ポート（PORT 環境変数が設定されていればそちらが優先）
port = 3000
https = true
cert_path = ""
key_path = ""
host = ""
```

- [ ] **Step 5b: ローカル設定にポートを追加する（環境ごと・任意）**

`config/settings.toml`（gitignore 対象）の `[server]` に、その環境で使うポートを追加する。既に設定済みなら変更しない。

```toml
[server]
port = 8080
```

- [ ] **Step 6: テストを通す**

Run:
```powershell
npx tsc -p tsconfig.test.json
node --test --test-timeout=30000 "dist-test/tests/config.test.js"
node --test --test-timeout=30000 "dist-test/tests/config-defaults.test.js"
```
Expected: すべて `fail 0`。

- [ ] **Step 7: コミット（ユーザーの明示承認がある場合のみ）**

```powershell
git add src/backend/config/schema.ts src/backend/config/sanitize.ts config/settings.default.toml tests/config.test.ts
git commit -m "feat(config): add server.port with default 3000"
```

---

### Task 2: ポート解決ロジックと CLI

**Files:**
- Create: `src/shared/port.ts`
- Create: `scripts/resolve-port.js`
- Test: `tests/port.test.ts`

**Interfaces:**
- Produces:
  - `resolvePort(envValue: string | undefined, configValue: unknown, fallback?: number): number`
  - `isValidPort(value: unknown): value is number`
  - `DEFAULT_PORT = 3000`
  - CLI `node scripts/resolve-port.js` が標準出力へポート番号だけを出す
- Consumes: なし

- [ ] **Step 1: 失敗するテストを追加する**

`tests/port.test.ts` を作成する。

```ts
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { DEFAULT_PORT, isValidPort, resolvePort } from "../src/shared/port";
import { PROJECT_ROOT, createTempDir } from "./helpers/project";

const resolverPath = path.join(PROJECT_ROOT, "scripts", "resolve-port.js");
const resolver = require(resolverPath) as {
  resolvePort(options?: { rootDir?: string; envPort?: string }): number;
  readPortFromToml(file: string): number | undefined;
  isValidPort(value: unknown): boolean;
};

test("isValidPort は 1..65535 の整数だけを受け付ける", () => {
  assert.equal(isValidPort(3000), true);
  assert.equal(isValidPort(1), true);
  assert.equal(isValidPort(65535), true);
  assert.equal(isValidPort(0), false);
  assert.equal(isValidPort(65536), false);
  assert.equal(isValidPort(3000.5), false);
  assert.equal(isValidPort("3000"), false);
  assert.equal(isValidPort(undefined), false);
});

test("resolvePort は PORT 環境変数を設定より優先する", () => {
  assert.equal(resolvePort("3011", 3000), 3011);
});

test("resolvePort は不正な PORT を無視して設定値を使う", () => {
  assert.equal(resolvePort("abc", 3000), 3000);
  assert.equal(resolvePort("0", 3010), 3010);
  assert.equal(resolvePort("70000", 3010), 3010);
});

test("resolvePort は設定値が無効なら既定値を使う", () => {
  assert.equal(resolvePort(undefined, 0), DEFAULT_PORT);
  assert.equal(resolvePort(undefined, undefined), DEFAULT_PORT);
});

test("resolve-port.js は settings.toml > settings.default.toml > 3000 の順で解決する", () => {
  const { dir, cleanup } = createTempDir("sumika-port-");
  try {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "settings.default.toml"), "[server]\nport = 3000\n");
    assert.equal(resolver.resolvePort({ rootDir: dir, envPort: undefined }), 3000);

    fs.writeFileSync(path.join(dir, "config", "settings.toml"), "[server]\nport = 3010\n");
    assert.equal(resolver.resolvePort({ rootDir: dir, envPort: undefined }), 3010);
    assert.equal(resolver.resolvePort({ rootDir: dir, envPort: "3011" }), 3011);

    fs.writeFileSync(path.join(dir, "config", "settings.toml"), "[server]\nport = 70000\n");
    assert.equal(resolver.resolvePort({ rootDir: dir, envPort: undefined }), 3000);
  } finally {
    cleanup();
  }
});

test("resolve-port.js は CLI でポートだけを出力する", () => {
  const output = execFileSync(process.execPath, [resolverPath], {
    env: { ...process.env, PORT: "3012" },
    encoding: "utf8",
  }).trim();
  assert.equal(output, "3012");
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run:
```powershell
npx tsc -p tsconfig.test.json
```
Expected: `Cannot find module '../src/shared/port'` または `Cannot find module '.../scripts/resolve-port.js'` で失敗する。

- [ ] **Step 3: 共有ロジックを実装する**

`src/shared/port.ts` を作成する。

```ts
/** サーバーの待受ポート（`[server] port` / `PORT` 環境変数）の解決ロジック。 */

export const DEFAULT_PORT = 3000;
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

/** ポート番号として有効な整数か */
export function isValidPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_PORT &&
    value <= MAX_PORT
  );
}

/**
 * 実効ポートを決める。
 *
 * 優先順位: `PORT` 環境変数（有効な整数のとき） > `[server] port` > 既定 3000。
 * 不正な環境変数は無視して設定値へフォールバックする。
 */
export function resolvePort(
  envValue: string | undefined,
  configValue: unknown,
  fallback: number = DEFAULT_PORT
): number {
  const env = envValue?.trim();
  if (env) {
    const parsed = Number(env);
    if (isValidPort(parsed)) {
      return parsed;
    }
  }
  return isValidPort(configValue) ? configValue : fallback;
}
```

- [ ] **Step 4: CLI を実装する**

`scripts/resolve-port.js` を作成する。

```js
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
```

- [ ] **Step 5: テストを通す**

Run:
```powershell
npx tsc -p tsconfig.test.json
node --test --test-timeout=30000 "dist-test/tests/port.test.js"
```
Expected: `fail 0`。

- [ ] **Step 6: コミット（ユーザーの明示承認がある場合のみ）**

```powershell
git add src/shared/port.ts scripts/resolve-port.js tests/port.test.ts
git commit -m "feat: add port resolution helper and CLI"
```

---

### Task 3: サーバーが設定値を使う

**Files:**
- Modify: `src/backend/index.ts:11`（import）, `src/backend/index.ts:93`（ポート決定）

**Interfaces:**
- Consumes: `resolvePort(envValue, configValue, fallback?)`（Task 2）
- Produces: サーバーが `PORT` > `[server] port` > 3000 で待ち受ける

- [ ] **Step 1: import を追加する**

`src/backend/index.ts` の `import { loadTls } from "./server/tls";` の直後に追加する。

```ts
import { resolvePort } from "../shared/port";
```

- [ ] **Step 2: ポート決定を置き換える**

`src/backend/index.ts:93` を次のように変更する。

```ts
  const port = resolvePort(process.env.PORT, config.getServer().port);
```

- [ ] **Step 3: 型チェックとテストを通す**

Run:
```powershell
npm run typecheck
npm test
```
Expected: 型エラーなし、`fail 0`。

- [ ] **Step 4: コミット（ユーザーの明示承認がある場合のみ）**

```powershell
git add src/backend/index.ts
git commit -m "feat(server): resolve listen port from config with PORT override"
```

---

### Task 4: `start.bat` が設定値を使う

**Files:**
- Modify: `start.bat:9`（既定ポート行を削除）, `start.bat:28`（`APP_URL` 行を削除）,
  `start.bat:74` の直後に解決ブロックを追加

**Interfaces:**
- Consumes: `node scripts/resolve-port.js`（Task 2）
- Produces: `PORT` が解決済みになり、`APP_URL` とポート確認が同じ値を使う

- [ ] **Step 1: 先頭の既定ポート行を削除する**

`start.bat:9` の次の行を削除する。

```bat
if not defined PORT set "PORT=3000"
```

- [ ] **Step 2: `APP_URL` の行を削除する**

`start.bat:28` の次の行を削除する。

```bat
set "APP_URL=%SCHEME%://localhost:%PORT%/?mode=%LAYOUT%"
```

- [ ] **Step 3: ビルド後にポートを解決する**

`start.bat` のビルドブロック（`[3/6] ビルド成果物: OK` の `)` の後）に追加する。

```bat
:: ---------------------------------------------------------------
:: 3.5. ポートの解決（PORT 環境変数 > [server] port > 3000）
:: ---------------------------------------------------------------
for /f "usebackq delims=" %%p in (`node "scripts\resolve-port.js"`) do set "PORT=%%p"
if not defined PORT set "PORT=3000"
set "APP_URL=%SCHEME%://localhost:%PORT%/?mode=%LAYOUT%"
```

- [ ] **Step 3b: 一時上書きを使う場合（任意）**

`start.bat` の先頭に `set "PORT=8080"` を追加すると、その起動だけ設定値より優先される。
書かなければ `[server] port` が使われる。

- [ ] **Step 4: 解決値を確認する**

Run:
```powershell
node scripts\resolve-port.js
cmd /c "set PORT=8080&& node scripts\resolve-port.js"
```
Expected: 1 行目はローカル設定の値、2 行目は `8080`。

- [ ] **Step 5: 起動確認（手動）**

別ターミナルで:
```powershell
cmd /c "set PORT=8080&& start.bat /nobrowser"
```
Expected: `アプリを起動します: http://localhost:8080/?mode=studio` が表示される。
別ターミナルで:
```powershell
curl.exe -s http://127.0.0.1:8080/api/health
```
Expected: JSON が返る。確認後、起動中のウィンドウで Ctrl+C。

- [ ] **Step 6: コミット（ユーザーの明示承認がある場合のみ）**

```powershell
git add start.bat
git commit -m "feat(start): resolve port from config in launcher"
```

---

### Task 5: `quit.bat` が同じポートを見る

**Files:**
- Modify: `quit.bat:9`

**Interfaces:**
- Consumes: `node scripts/resolve-port.js`（Task 2）
- Produces: `quit.bat` が解決値を `quit.ps1 -Port` に渡す

- [ ] **Step 1: 既定ポート行を置き換える**

`quit.bat:9` の次の行を置き換える。

```bat
for /f "usebackq delims=" %%p in (`node "scripts\resolve-port.js"`) do set "PORT=%%p"
if not defined PORT set "PORT=3000"
```

> `scripts/quit.ps1` の既定値 3000 は直接実行時のみ。`quit.bat` は解決値を `-Port` で渡すため、`quit.ps1` は変更しない。

- [ ] **Step 2: 解決値を確認する**

Run:
```powershell
cmd /c "set PORT=8080&& node scripts\resolve-port.js"
```
Expected: `8080`。

- [ ] **Step 3: 終了確認（手動）**

Task 4 でアプリを 8080 で起動した状態で:
```powershell
cmd /c "set PORT=8080&& quit.bat /yes"
```
Expected: アプリが停止し、`[ok] port 8080 released` が表示される。
`port 3000` の `[busy]` が出ないこと。

- [ ] **Step 4: コミット（ユーザーの明示承認がある場合のみ）**

```powershell
git add quit.bat
git commit -m "feat(quit): resolve port from config"
```

---

### Task 6: `start-stage.bat` が同じポートを使う

**Files:**
- Modify: `scripts/start-stage.bat`

**Interfaces:**
- Consumes: `node scripts/resolve-port.js`（Task 2）
- Produces: `npm start` に `PORT` を継承し、Edge の URL も同じ値になる

- [ ] **Step 1: プロジェクトルートへ移動し、ポートを解決する**

`scripts/start-stage.bat` を次の形にする。

```bat
@echo off
rem サーバーを別ウィンドウで起動し、Edge のアプリ窓でステージを開く
cd /d "%~dp0.."
for /f "usebackq delims=" %%p in (`node "scripts\resolve-port.js"`) do set "PORT=%%p"
if not defined PORT set "PORT=3000"
start "sumika-server" cmd /c "npm start"
timeout /t 6 /nobreak > nul
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
start "" "%EDGE%" --app="http://localhost:%PORT%/?mode=stage&role=display" --window-size=960,720
```

- [ ] **Step 2: 静的確認**

Run:
```powershell
findstr /C:"resolve-port.js" scripts\start-stage.bat
findstr /C:"localhost:%PORT%" scripts\start-stage.bat
```
Expected: 両方の行が見つかる。

- [ ] **Step 3: 起動確認（手動）**

```powershell
cmd /c "set PORT=8080&& scripts\start-stage.bat"
```
Expected: サーバーが 8080 で起動し、Edge のアプリ窓が
`http://localhost:8080/?mode=stage&role=display` を開く。確認後、サーバーを停止する。

- [ ] **Step 4: コミット（ユーザーの明示承認がある場合のみ）**

```powershell
git add scripts/start-stage.bat
git commit -m "feat(stage): use resolved port in stage launcher"
```

---

### Task 7: `setup-https.ps1` の案内が同じポートを使う

**Files:**
- Modify: `scripts/setup-https.ps1:16-17`（解決処理を追加）, `scripts/setup-https.ps1:87-88`（案内文）

**Interfaces:**
- Consumes: `node scripts/resolve-port.js`（Task 2）
- Produces: 案内文の URL が実効ポートになる

- [ ] **Step 1: ポート解決を追加する**

`scripts/setup-https.ps1` の `Set-Location $root` の直後に追加する。

```powershell
$appPort = 3000
try {
    $portText = (& node (Join-Path $PSScriptRoot "resolve-port.js") 2>$null | Out-String).Trim()
    if ($portText -match '^\d+$') { $appPort = [int]$portText }
} catch {
}
```

- [ ] **Step 2: 案内文を置き換える**

`scripts/setup-https.ps1:87-88` を次のように変更する。

```powershell
Write-Host "  1. .\start.bat で起動（https://localhost:$appPort が開きます）"
Write-Host "  2. 他の PC / スマホからは https://<このPCのIP>:$appPort で開く"
```

- [ ] **Step 3: 解決値を確認する**

Run:
```powershell
node scripts\resolve-port.js
```
Expected: ローカル設定のポート番号。

- [ ] **Step 4: 案内文の確認（任意・mkcert がある場合のみ）**

```powershell
npm run https:setup
```
Expected: 表示される URL が `https://localhost:<解決値>` になっている。
証明書を作り直したくない場合はこの手順をスキップする。

- [ ] **Step 5: コミット（ユーザーの明示承認がある場合のみ）**

```powershell
git add scripts/setup-https.ps1
git commit -m "feat(https): show resolved port in setup guidance"
```

---

### Task 8: `smoke.js` が同じポートを見る

**Files:**
- Modify: `scripts/smoke.js:1-8`

**Interfaces:**
- Consumes: `resolve-port.js` の `resolvePort()`（Task 2）
- Produces: `SMOKE_BASE` 未指定時の接続先が解決値になる

- [ ] **Step 1: 解決ロジックを読み込む**

`scripts/smoke.js` の先頭を次の形にする。

```js
/**
 * 起動中サーバーに対する簡易スモークテスト。
 * 使い方: サーバーを起動した状態で `node scripts/smoke.js`
 * 接続先: SMOKE_BASE > PORT 環境変数 > config/settings.toml の [server] port > 3000
 */
const WebSocket = require("ws");
const { resolvePort } = require("./resolve-port");

const BASE = process.env.SMOKE_BASE ?? `http://127.0.0.1:${resolvePort()}`;
```

- [ ] **Step 2: 疎通確認（手動）**

Task 4 でアプリを 8080 で起動した状態で、別ターミナル:
```powershell
$env:PORT = "8080"
$env:SMOKE_NO_PATCH = "1"
npm run smoke
```
Expected: `[smoke] OK`。

`SMOKE_BASE` の上書きも確認する:
```powershell
$env:SMOKE_BASE = "http://127.0.0.1:8080"
Remove-Item Env:PORT -ErrorAction SilentlyContinue
npm run smoke
```
Expected: `[smoke] OK`。

- [ ] **Step 3: コミット（ユーザーの明示承認がある場合のみ）**

```powershell
git add scripts/smoke.js
git commit -m "feat(smoke): default to resolved port"
```

---

### Task 9: README / AGENTS.md の更新

**Files:**
- Modify: `README.md:332`（`[server]` の表）, `README.md:333` の後に節を追加
- Modify: `AGENTS.md`（環境前提の節）

**Interfaces:**
- Consumes: なし
- Produces: 利用者向けのポート変更手順

- [ ] **Step 1: `[server]` の表を更新する**

`README.md:332` を次の行に置き換える。

```markdown
| `[server]` | `port`（既定 3000。`PORT` 環境変数が最優先）, `https`（既定 true。`certs/` が無ければ HTTP）, `cert_path`, `key_path`, `host`（空=全インターフェース。LAN 公開用） |
```

- [ ] **Step 2: 変更方法の節を追加する**

`README.md` の表の直後（「設定の反映:」の前）に追加する。

~~~markdown
### 待受ポートを変える

`config/settings.toml` の `[server] port` で変更できます（既定 3000）。`PORT` 環境変数を設定した場合はそちらが優先されます。

```toml
[server]
port = 8080
```

`start.bat` の先頭に `set "PORT=8080"` を書けば、その起動だけの一時上書きになります。
`start.bat` / `quit.bat` / `npm run smoke` / `scripts\start-stage.bat` / HTTPS の案内は
`scripts/resolve-port.js` で同じ値を解決します。
~~~

- [ ] **Step 3: AGENTS.md に運用メモを追加する**

`AGENTS.md` の「5. 環境前提（この PC）」の箇条書きに追加する。

```markdown
- **待受ポートは `[server] port`（既定 3000）**。`PORT` 環境変数が最優先。
  `start.bat` / `quit.bat` / `scripts/start-stage.bat` / `scripts/setup-https.ps1` / `npm run smoke` は
  `scripts/resolve-port.js` で同じ値を解決する。
```

- [ ] **Step 4: ドキュメントの整合を確認する**

Run:
```powershell
git diff --check
```
Expected: 出力なし。

- [ ] **Step 5: コミット（ユーザーの明示承認がある場合のみ）**

```powershell
git add README.md AGENTS.md
git commit -m "docs: document server port setting"
```

---

### Task 10: 最終検証

**Files:** なし（検証のみ）

- [ ] **Step 1: 一括検証**

Run:
```powershell
npm run verify
```
Expected: typecheck 成功、テスト `fail 0`、build 成功。

- [ ] **Step 2: 解決の優先順位を確認する**

Run:
```powershell
node scripts\resolve-port.js
cmd /c "set PORT=8080&& node scripts\resolve-port.js"
cmd /c "set PORT=abc&& node scripts\resolve-port.js"
```
Expected:
- 1 行目: ローカル設定のポート
- 2 行目: `8080`
- 3 行目: 1 行目と同じ（不正な `PORT` は無視）

- [ ] **Step 3: エンドツーエンド確認（手動）**

```powershell
cmd /c "set PORT=8080&& start.bat /nobrowser"
```
別ターミナル:
```powershell
$env:PORT = "8080"
$env:SMOKE_NO_PATCH = "1"
npm run smoke
```
Expected: `[smoke] OK`。確認後:
```powershell
cmd /c "set PORT=8080&& quit.bat /yes"
```
Expected: `[ok] port 8080 released`。

- [ ] **Step 3b: 既定値の一括変更が残っていないことを確認する**

Run:
```powershell
git grep -n "3010" -- src scripts start.bat quit.bat README.md AGENTS.md
```
Expected: 出力なし（環境固有の値は gitignore された `config/settings.toml` にだけ置く）。

- [ ] **Step 4: 差分を確認する**

Run:
```powershell
git status --short
git diff
```
Expected: 設計書・計画・実装の変更だけが表示される。想定外のファイルが無いこと。

- [ ] **Step 5: ユーザー確認**

変更内容を報告し、ユーザーの確認を待つ。**コミットはまだ行わない。**

- [ ] **Step 6: コミット（ユーザーの明示承認がある場合のみ）**

```powershell
git add -A
git commit -m "feat: make server port configurable ([server] port)"
```
