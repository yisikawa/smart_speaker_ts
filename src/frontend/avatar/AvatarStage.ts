import type { AvatarConfigPayload } from "../../shared/protocol";
import { Live2DRenderer } from "./Live2DRenderer";
import { NullRenderer } from "./NullRenderer";
import { SpriteRenderer } from "./SpriteRenderer";
import type { AvatarRenderer } from "./types";

/**
 * 設定に応じてレンダラを選ぶ。
 * Live2D は pixi / Cubism Core / モデルが揃っているときだけ使い、
 * 失敗したら CSS 立ち絵（sprite）へフォールバックする。
 */
export class AvatarStage {
  private renderer: AvatarRenderer = new NullRenderer();

  async mount(container: HTMLElement, config: AvatarConfigPayload): Promise<void> {
    this.destroy();
    if (!config.enabled) {
      this.renderer = new NullRenderer();
      return;
    }

    if (config.renderer === "live2d" && config.modelUrl) {
      const live2d = new Live2DRenderer();
      try {
        await live2d.mount(container, config);
        this.renderer = live2d;
        return;
      } catch (error) {
        console.warn("[Avatar] Live2D を表示できないため CSS 立ち絵に切り替えます", error);
        live2d.destroy();
      }
    }

    this.renderer = new SpriteRenderer();
    await this.renderer.mount(container, config);
  }

  setMouth(level: number): void {
    this.renderer.setMouth(level);
  }

  setExpression(name: string | null): void {
    this.renderer.setExpression(name);
  }

  playMotion(group: string, index?: number): void {
    this.renderer.playMotion(group, index);
  }

  destroy(): void {
    this.renderer.destroy();
    this.renderer = new NullRenderer();
  }
}
