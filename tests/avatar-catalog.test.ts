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
