/**
 * Live2D ランタイムの別バンドル（`dist/frontend/live2d.js`）。
 *
 * - Cubism Core は `vendor/live2d/live2dcubismcore.min.js` を `/live2d-core/` で配信する
 * - Core が無い環境でもこのスクリプトは例外を投げず、`window.SumikaLive2D.error` に理由を残す
 *   （アプリ側は sprite へフォールバックする）
 * - pixi は静的 import、`pixi-live2d-display/cubism4` は Core の存在を確認してから動的 import する
 *   （モジュール初期化時に `window.Live2DCubismCore` を参照するため）
 */
import * as PIXI from "pixi.js";

export interface Live2DVendor {
  PIXI: typeof PIXI;
  Live2DModel: typeof import("pixi-live2d-display/cubism4").Live2DModel;
}

interface Live2DWindow {
  Live2DCubismCore?: unknown;
  PIXI?: typeof PIXI;
  SumikaLive2D?: Live2DVendor | { error: string };
}

const CORE_URL = "/live2d-core/live2dcubismcore.min.js";

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`スクリプトを読み込めません: ${src}`));
    document.head.append(script);
  });
}

(async (): Promise<void> => {
  const global = window as unknown as Live2DWindow;
  try {
    if (!global.Live2DCubismCore) {
      await loadScript(CORE_URL);
    }
    // pixi-live2d-display は window.PIXI.Ticker を自動更新に使う
    global.PIXI = PIXI;
    const cubism4 = await import("pixi-live2d-display/cubism4");
    const { Live2DModel } = cubism4;
    // `cubism4` サブパスの ambient 型宣言（src/frontend/types/）は Live2DModel しか
    // 公開していないため narrow cast する（実行時は CubismConfig が export されている）
    const { CubismConfig } = cubism4 as unknown as {
      CubismConfig: { setOpacityFromMotion: boolean };
    };
    // pixi-live2d-display の既定（false）ではモーションの PartOpacity カーブを
    // パラメータとして解釈して無視するため、パーツ表示切替（hiyori の PartArmA/B）を有効にする
    CubismConfig.setOpacityFromMotion = true;
    Live2DModel.registerTicker(PIXI.Ticker);
    global.SumikaLive2D = { PIXI, Live2DModel };
    console.info("[Avatar] Live2D ランタイムを読み込みました");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    global.SumikaLive2D = { error: message };
    console.warn("[Avatar] Live2D を初期化できません。CSS 立ち絵で表示します:", message);
  }
})();
