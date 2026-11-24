import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "../src/backend/config/schema";
import { loadTls, resolveTlsPaths } from "../src/backend/server/tls";
import { createTempDir } from "./helpers/project";

test("resolveTlsPaths は空なら certs/server.crt|key を使う", () => {
  const base = path.join("root");
  const { certPath, keyPath } = resolveTlsPaths(base, { ...DEFAULT_CONFIG.server, https: true });
  assert.equal(certPath, path.join(base, "certs", "server.crt"));
  assert.equal(keyPath, path.join(base, "certs", "server.key"));
});

test("resolveTlsPaths は設定のパスを優先する", () => {
  const { certPath, keyPath } = resolveTlsPaths("root", {
    ...DEFAULT_CONFIG.server,
    cert_path: "C:\\x\\a.crt",
    key_path: "C:\\x\\a.key",
  });
  assert.equal(certPath, "C:\\x\\a.crt");
  assert.equal(keyPath, "C:\\x\\a.key");
});

test("loadTls は https=false なら disabled（HTTP で起動）", () => {
  const result = loadTls("root", { ...DEFAULT_CONFIG.server, https: false });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "disabled");
  }
});

test("loadTls は証明書が無ければ missing（HTTP にフォールバック）", () => {
  const temp = createTempDir();
  try {
    const result = loadTls(temp.dir, { ...DEFAULT_CONFIG.server, https: true });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "missing");
      assert.match(result.message, /setup-https/);
    }
  } finally {
    temp.cleanup();
  }
});

test("loadTls は証明書と鍵を読む", () => {
  const temp = createTempDir();
  try {
    const certDir = path.join(temp.dir, "certs");
    fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(path.join(certDir, "server.crt"), "dummy-cert");
    fs.writeFileSync(path.join(certDir, "server.key"), "dummy-key");
    const result = loadTls(temp.dir, { ...DEFAULT_CONFIG.server, https: true });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.tls.cert.toString(), "dummy-cert");
      assert.equal(result.tls.key.toString(), "dummy-key");
      assert.equal(result.tls.certPath, path.join(certDir, "server.crt"));
    }
  } finally {
    temp.cleanup();
  }
});

test("loadTls は証明書だけあるときも missing（鍵が要る）", () => {
  const temp = createTempDir();
  try {
    fs.mkdirSync(path.join(temp.dir, "certs"), { recursive: true });
    fs.writeFileSync(path.join(temp.dir, "certs", "server.crt"), "only-cert");
    const result = loadTls(temp.dir, { ...DEFAULT_CONFIG.server, https: true });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "missing");
    }
  } finally {
    temp.cleanup();
  }
});
