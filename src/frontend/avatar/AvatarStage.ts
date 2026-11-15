import type { AvatarConfigPayload } from "../../shared/protocol";
import { NullRenderer } from "./NullRenderer";
import { SpriteRenderer } from "./SpriteRenderer";
import type { AvatarRenderer } from "./types";

/**
 * 設定に応じてレンダラを選ぶ。
 * P3 では `live2d` を要求されても sprite へフォールバックする（P4 で本実装）。
 */
export class AvatarStage {
  private renderer: AvatarRenderer = new NullRenderer();

  async mount(container: HTMLElement, config: AvatarConfigPayload): Promise<void> {
    this.destroy();
    if (!config.enabled) {
      this.renderer = new NullRenderer();
    } else {
      if (config.renderer === "live2d") {
        console.info("[Avatar] Live2D は P4 で実装予定のため CSS 立ち絵で表示します");
      }
      this.renderer = new SpriteRenderer();
    }
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
