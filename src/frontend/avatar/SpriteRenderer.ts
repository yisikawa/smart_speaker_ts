import type { AvatarConfigPayload } from "../../shared/protocol";
import type { AvatarRenderer } from "./types";

/**
 * CSS 立ち絵のフォールバック。画像アセットが無くても必ず表示できるよう、
 * 顔・目・口を DOM で描く（Live2D / 画像が用意できたら差し替える）。
 */
export class SpriteRenderer implements AvatarRenderer {
  readonly name = "sprite" as const;
  private root: HTMLElement | null = null;
  private mouth: HTMLElement | null = null;
  private expression: HTMLElement | null = null;

  async mount(container: HTMLElement, config: AvatarConfigPayload): Promise<void> {
    this.destroy();
    const root = document.createElement("div");
    root.className = "avatar-sprite";
    root.style.setProperty?.("--avatar-scale", String(config.scale));
    root.style.background = config.background;
    root.style.left = `${config.offsetX * 100}%`;
    root.style.top = `${config.offsetY * 100}%`;

    const face = document.createElement("div");
    face.className = "avatar-face";

    const eyeLeft = document.createElement("div");
    eyeLeft.className = "avatar-eye avatar-eye-left";
    const eyeRight = document.createElement("div");
    eyeRight.className = "avatar-eye avatar-eye-right";

    const mouth = document.createElement("div");
    mouth.className = "avatar-mouth";

    const expression = document.createElement("div");
    expression.className = "avatar-expression";

    face.append(eyeLeft, eyeRight, mouth, expression);
    root.append(face);
    container.append(root);

    this.root = root;
    this.mouth = mouth;
    this.expression = expression;
  }

  setMouth(level: number): void {
    if (!this.mouth) {
      return;
    }
    const clamped = Math.min(1, Math.max(0, level));
    this.mouth.style.height = `${4 + clamped * 22}px`;
    this.mouth.style.borderRadius = `${clamped * 50}%`;
  }

  setExpression(name: string | null): void {
    if (!this.expression) {
      return;
    }
    this.expression.textContent = name ? `[${name}]` : "";
  }

  playMotion(_group: string, _index?: number): void {
    // sprite ではモーションを持たない
  }

  destroy(): void {
    this.root?.remove?.();
    this.root = null;
    this.mouth = null;
    this.expression = null;
  }
}
