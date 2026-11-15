import test from "node:test";
import assert from "node:assert/strict";
import {
  createAvatarModelInfo,
  parseModel3Json,
  toUrlPath,
} from "../src/shared/avatar/modelCatalog";

test("Expressions と Motions を取り出す", () => {
  const meta = parseModel3Json({
    FileReferences: {
      Expressions: [{ Name: "exp_01" }, { Name: "exp_02" }, { Name: "" }],
      Motions: { Idle: [{}], TapBody: [{}] },
    },
  });
  assert.deepEqual(meta, { expressions: ["exp_01", "exp_02"], motions: ["Idle", "TapBody"] });
});

test("壊れた構造は null を返す", () => {
  assert.equal(parseModel3Json(null), null);
  assert.equal(parseModel3Json({}), null);
  assert.equal(parseModel3Json({ FileReferences: {} }), null);
});

test("Windows パスは URL 用に / 区切りへ直す", () => {
  assert.equal(
    toUrlPath("live2d-models\\hiyori\\hiyori.model3.json"),
    "live2d-models/hiyori/hiyori.model3.json"
  );
  const info = createAvatarModelInfo({
    relativePath: "live2d-models\\hiyori\\hiyori.model3.json",
    label: "hiyori",
    meta: { expressions: ["exp_01"], motions: ["Idle"] },
  });
  assert.equal(info.url, "/live2d-models/hiyori/hiyori.model3.json");
  assert.equal(info.path, "live2d-models/hiyori/hiyori.model3.json");
  assert.equal(info.label, "hiyori");
});

import * as fs from "node:fs";
import * as path from "node:path";
import { createTempDir } from "./helpers/project";
import { listAvatarModels } from "../src/backend/services/avatarCatalog";

test("live2d-models 配下の model3.json を列挙する", () => {
  const temp = createTempDir("sumika-avatar-");
  try {
    const dir = path.join(temp.dir, "live2d-models", "hiyori");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "hiyori.model3.json"),
      JSON.stringify({ FileReferences: { Expressions: [{ Name: "exp_01" }], Motions: { Idle: [{}] } } })
    );
    const models = listAvatarModels(temp.dir);
    assert.equal(models.length, 1);
    assert.equal(models[0].path, "live2d-models/hiyori/hiyori.model3.json");
    assert.equal(models[0].url, "/live2d-models/hiyori/hiyori.model3.json");
    assert.deepEqual(models[0].expressions, ["exp_01"]);
    assert.deepEqual(models[0].motions, ["Idle"]);
  } finally {
    temp.cleanup();
  }
});

test("ディレクトリが無ければ空配列", () => {
  const temp = createTempDir("sumika-avatar-");
  try {
    assert.deepEqual(listAvatarModels(temp.dir), []);
  } finally {
    temp.cleanup();
  }
});

test("壊れた JSON でも候補として残し、表情は空にする", () => {
  const temp = createTempDir("sumika-avatar-");
  try {
    const dir = path.join(temp.dir, "live2d-models", "broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken.model3.json"), "{ broken");
    const models = listAvatarModels(temp.dir);
    assert.equal(models.length, 1);
    assert.deepEqual(models[0].expressions, []);
  } finally {
    temp.cleanup();
  }
});
