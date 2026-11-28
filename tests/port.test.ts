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
