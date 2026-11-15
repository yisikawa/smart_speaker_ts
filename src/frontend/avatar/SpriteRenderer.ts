import type { AvatarConfigPayload } from "../../shared/protocol";
import type { AvatarRenderer } from "./types";

/**
 * 立ち絵のフォールバック。
 * `spriteUrl` があればその画像を表示し、無い/読めない場合は CSS で顔を描く。
 * どちらの場合も口（`.avatar-mouth`）を重ねて口パクできるようにする。
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
    root.style.left = `${config.offsetX * 100}%`;
    root.style.top = `${config.offsetY * 100}%`;
    container.append(root);
    this.root = root;

    if (config.spriteUrl) {
      root.classList.add("avatar-sprite--image");
      const image = document.createElement("img");
      image.className = "avatar-image";
      image.alt = "";
      image.onerror = () => {
        image.remove?.();
        root.classList.remove("avatar-sprite--image");
        this.drawFallbackFace(root);
      };
      image.src = config.spriteUrl;
      root.append(image);
    } else {
      this.drawFallbackFace(root);
    }

    const mouth = document.createElement("div");
    mouth.className = "avatar-mouth";
    root.append(mouth);
    this.mouth = mouth;

    const expression = document.createElement("div");
    expression.className = "avatar-expression";
    root.append(expression);
    this.expression = expression;
  }

  /** 画像が無い/読めないときの CSS の顔 */
  private drawFallbackFace(root: HTMLElement): void {
    const face = document.createElement("div");
    face.className = "avatar-face";

    const eyeLeft = document.createElement("div");
    eyeLeft.className = "avatar-eye avatar-eye-left";
    const eyeRight = document.createElement("div");
    eyeRight.className = "avatar-eye avatar-eye-right";
    face.append(eyeLeft, eyeRight);

    root.append(face);
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
