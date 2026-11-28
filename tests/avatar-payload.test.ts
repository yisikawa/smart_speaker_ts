import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/backend/config/schema";
import { buildAvatarPayload } from "../src/backend/server/avatarPayload";
import type { AvatarModelInfo } from "../src/shared/avatar/modelCatalog";

const model: AvatarModelInfo = {
  path: "live2d-models/hiyori/hiyori.model3.json",
  url: "/live2d-models/hiyori/hiyori.model3.json",
  label: "hiyori",
  expressions: ["exp_01"],
  motions: ["Idle"],
};

test("モデルが見つかれば live2d", () => {
  const payload = buildAvatarPayload({ ...DEFAULT_CONFIG.avatar, model_path: model.path }, [model]);
  assert.equal(payload.renderer, "live2d");
  assert.equal(payload.modelUrl, "/live2d-models/hiyori/hiyori.model3.json");
  assert.deepEqual(payload.lipSync, { sliceMs: 20, smoothing: 0.4, gain: 1 });
  assert.deepEqual(payload.emotionTags, ["happy", "angry", "sad", "surprised", "shy", "thinking"]);
});

test("モデルが無ければ sprite（CSS 立ち絵へフォールバック）", () => {
  const payload = buildAvatarPayload(DEFAULT_CONFIG.avatar, []);
  assert.equal(payload.renderer, "sprite");
  assert.equal(payload.modelUrl, "");
});

test("立ち絵画像のパスは /avatar-assets の URL になる", () => {
  const payload = buildAvatarPayload(
    { ...DEFAULT_CONFIG.avatar, sprite_image: "assets\\avatar\\sakura.png" },
    []
  );
  assert.equal(payload.spriteUrl, "/avatar-assets/sakura.png");
});

test("立ち絵画像が未設定なら空文字", () => {
  assert.equal(buildAvatarPayload(DEFAULT_CONFIG.avatar, []).spriteUrl, "");
});

test("Live2DModels のパスは /Live2DModels の URL で live2d になる", () => {
  const models: AvatarModelInfo[] = [
    {
      path: "Live2DModels/hiyori_vts/hiyori.model3.json",
      url: "/Live2DModels/hiyori_vts/hiyori.model3.json",
      label: "hiyori_vts",
      expressions: [],
      motions: [],
    },
  ];
  const payload = buildAvatarPayload(
    { ...DEFAULT_CONFIG.avatar, model_path: "Live2DModels\\hiyori_vts\\hiyori.model3.json" },
    models
  );
  assert.equal(payload.renderer, "live2d");
  assert.equal(payload.modelUrl, "/Live2DModels/hiyori_vts/hiyori.model3.json");
});

test("無効ならモデルがあっても none", () => {
  const payload = buildAvatarPayload({ ...DEFAULT_CONFIG.avatar, enabled: false }, [model]);
  assert.equal(payload.renderer, "none");
});

test("設定の path が \\ 区切りでも一致する", () => {
  const payload = buildAvatarPayload(
    { ...DEFAULT_CONFIG.avatar, model_path: "live2d-models\\hiyori\\hiyori.model3.json" },
    [model]
  );
  assert.equal(payload.renderer, "live2d");
});
