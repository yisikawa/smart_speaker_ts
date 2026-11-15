import type { AvatarConfigPayload } from "../../shared/protocol";
import type { AvatarConfig } from "../config/schema";
import { toUrlPath, type AvatarModelInfo } from "../../shared/avatar/modelCatalog";

/**
 * `hello.avatar` を組み立てる。
 * P0 では「モデルがあれば live2d、無ければ none」。P3 で sprite フォールバックを足す。
 */
export function buildAvatarPayload(
  config: AvatarConfig,
  models: AvatarModelInfo[]
): AvatarConfigPayload {
  const normalized = toUrlPath(config.model_path);
  const model = models.find((entry) => entry.path === normalized);

  return {
    enabled: config.enabled,
    renderer: config.enabled ? (model ? "live2d" : "sprite") : "none",
    modelUrl: model?.url ?? "",
    spriteUrl: toSpriteUrl(config.sprite_image),
    scale: config.scale,
    offsetX: config.offset_x,
    offsetY: config.offset_y,
    background: config.background,
    expressions: { ...config.expressions },
    motions: { ...config.motions },
    emotionStyles: { ...config.emotion_styles },
    idleMotionIntervalSeconds: config.idle_motion_interval_seconds,
    lipSync: { sliceMs: 20, smoothing: config.lip_sync_smoothing, gain: config.lip_sync_gain },
    emotionTags: Object.keys(config.expressions),
  };
}

/** 立ち絵画像のパスを `/avatar-assets/<file>` の URL へ（空なら空文字） */
function toSpriteUrl(imagePath: string): string {
  const normalized = toUrlPath(imagePath).trim();
  if (!normalized) {
    return "";
  }
  const file = normalized.split("/").pop() ?? "";
  return file ? `/avatar-assets/${file}` : "";
}
