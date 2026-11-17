/**
 * `pixi-live2d-display` の `exports` サブパス（`/cubism4`）は
 * `moduleResolution: "node"` では解決できないため、型だけルートへ委譲する。
 * 実行時の解決は esbuild が行う（`exports` の `import` 条件を使う）。
 */
declare module "pixi-live2d-display/cubism4" {
  export { Live2DModel } from "pixi-live2d-display";
}
