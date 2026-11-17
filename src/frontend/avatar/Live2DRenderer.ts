import type { AvatarConfigPayload } from "../../shared/protocol";
import type { AvatarRenderer } from "./types";

/** pixi の Application（アプリ側バンドルに pixi を取り込まないため最小限の型） */
interface PixiApplicationLike {
  view: HTMLCanvasElement;
  stage: { addChild(child: unknown): void };
  renderer: { resize(width: number, height: number): void };
  destroy(removeView?: boolean): void;
}

/** pixi-live2d-display の Live2DModel（使う API だけ） */
interface Live2DModelLike {
  width: number;
  height: number;
  scale: { set(x: number, y?: number): void };
  anchor: { set(x: number, y?: number): void };
  x: number;
  y: number;
  internalModel: {
    coreModel?: { setParameterValueById(id: string, value: number): void };
    settings?: { groups?: Array<{ Name?: string; Ids?: string[] }> };
  };
  expression(name: string): Promise<boolean>;
  motion(group: string, index?: number): Promise<boolean>;
  destroy(): void;
}

interface Live2DVendor {
  PIXI: {
    Application: new (options: Record<string, unknown>) => PixiApplicationLike;
  };
  Live2DModel: {
    from(url: string, options?: Record<string, unknown>): Promise<Live2DModelLike>;
  };
}

interface Live2DWindow {
  SumikaLive2D?: Live2DVendor | { error: string };
}

const VENDOR_URL = "live2d.js";
const VENDOR_TIMEOUT_MS = 15000;
/** ステージ下端に置く（sprite の `top: 94%` に合わせる） */
const BOTTOM_RATIO = 0.98;
/** ステージ高さに対するモデルの高さ（scale で拡大縮小する） */
const MODEL_HEIGHT_RATIO = 0.92;

function currentVendor(): Live2DVendor | { error: string } | undefined {
  return (window as unknown as Live2DWindow).SumikaLive2D;
}

function isVendor(value: Live2DVendor | { error: string }): value is Live2DVendor {
  return typeof (value as Live2DVendor).Live2DModel?.from === "function";
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL(src, document.baseURI).toString();
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Live2D ランタイムを読み込めません: ${script.src}`));
    document.head.append(script);
  });
}

/** `live2d.js` を遅延ロードし、初期化完了（SumikaLive2D）まで待つ */
async function ensureVendor(): Promise<Live2DVendor> {
  const existing = currentVendor();
  if (existing) {
    if (isVendor(existing)) {
      return existing;
    }
    throw new Error(existing.error);
  }

  await loadScript(VENDOR_URL);

  const deadline = Date.now() + VENDOR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const vendor = currentVendor();
    if (vendor) {
      if (isVendor(vendor)) {
        return vendor;
      }
      throw new Error(vendor.error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Live2D ランタイムの初期化がタイムアウトしました");
}

/**
 * Live2D（Cubism 4）の描画。
 * `live2d.js`（pixi + pixi-live2d-display）と Cubism Core が揃っているときだけ動く。
 * 何か足りなければ throw し、`AvatarStage` が sprite へフォールバックする。
 */
export class Live2DRenderer implements AvatarRenderer {
  readonly name = "live2d" as const;
  private app: PixiApplicationLike | null = null;
  private model: Live2DModelLike | null = null;
  private container: HTMLElement | null = null;
  private config: AvatarConfigPayload | null = null;
  private baseHeight = 0;
  private lipSyncIds: string[] = [];
  private readonly handleResize = (): void => this.layout();

  async mount(container: HTMLElement, config: AvatarConfigPayload): Promise<void> {
    this.destroy();
    if (!config.modelUrl) {
      throw new Error("Live2D の modelUrl が空です");
    }

    const vendor = await ensureVendor();
    this.container = container;
    this.config = config;

    const app = new vendor.PIXI.Application({
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    this.app = app;
    app.view.className = "avatar-live2d-canvas";
    container.append(app.view);

    try {
      const model = await vendor.Live2DModel.from(config.modelUrl, { autoInteract: false });
      this.model = model;
      app.stage.addChild(model);

      this.baseHeight = model.height || 1;
      model.anchor.set(0.5, 1);
      this.resolveLipSyncIds(model);
      this.layout();
      app.view.dataset.live2d = "ready";
      window.addEventListener("resize", this.handleResize);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  setMouth(level: number): void {
    const core = this.model?.internalModel.coreModel;
    if (!core) {
      return;
    }
    const value = Math.min(1, Math.max(0, level));
    for (const id of this.lipSyncIds) {
      try {
        core.setParameterValueById(id, value);
      } catch {
        // モデルに無いパラメータは無視する
      }
    }
  }

  setExpression(name: string | null): void {
    if (!name || !this.model) {
      return;
    }
    void this.model.expression(name).catch(() => false);
  }

  playMotion(group: string, index?: number): void {
    if (!this.model) {
      return;
    }
    void this.model.motion(group, index).catch(() => false);
  }

  destroy(): void {
    window.removeEventListener("resize", this.handleResize);
    try {
      this.model?.destroy();
    } catch {
      // 破棄時の失敗は無視する
    }
    try {
      this.app?.destroy(true);
    } catch {
      // 同上
    }
    this.model = null;
    this.app = null;
    this.container = null;
    this.config = null;
    this.baseHeight = 0;
    this.lipSyncIds = [];
  }

  /** ステージのサイズに合わせてモデルを下端中央へ置く */
  private layout(): void {
    if (!this.app || !this.model) {
      return;
    }
    const width = this.container?.clientWidth || window.innerWidth;
    const height = this.container?.clientHeight || window.innerHeight;
    this.app.renderer.resize(width, height);

    const scale = this.config?.scale ?? 1;
    const targetHeight = height * MODEL_HEIGHT_RATIO * scale;
    const ratio = this.baseHeight > 0 ? targetHeight / this.baseHeight : 1;
    this.model.scale.set(ratio);
    this.model.x = width * (this.config?.offsetX ?? 0.5);
    this.model.y = height * BOTTOM_RATIO;
  }

  /** `Groups[].Name = "LipSync"` の ID を使う（無ければ Cubism 4 の標準 ID） */
  private resolveLipSyncIds(model: Live2DModelLike): void {
    const groups = model.internalModel.settings?.groups ?? [];
    const ids = groups.find((group) => group.Name === "LipSync")?.Ids ?? [];
    this.lipSyncIds = ids.length > 0 ? [...ids] : ["ParamMouthOpenY"];
  }
}
