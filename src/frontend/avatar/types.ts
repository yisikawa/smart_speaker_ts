import type { AvatarConfigPayload } from "../../shared/protocol";

/** アバター描画の抽象（Live2D / CSS 立ち絵 / 無効） */
export interface AvatarRenderer {
  readonly name: "live2d" | "sprite" | "none";
  mount(container: HTMLElement, config: AvatarConfigPayload): Promise<void>;
  /** 口の開き 0..1 */
  setMouth(level: number): void;
  setExpression(name: string | null): void;
  playMotion(group: string, index?: number): void;
  destroy(): void;
}
