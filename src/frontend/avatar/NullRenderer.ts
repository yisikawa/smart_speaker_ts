import type { AvatarConfigPayload } from "../../shared/protocol";
import type { AvatarRenderer } from "./types";

/** アバター無効時のダミー */
export class NullRenderer implements AvatarRenderer {
  readonly name = "none" as const;

  async mount(_container: HTMLElement, _config: AvatarConfigPayload): Promise<void> {
    // 何もしない
  }

  setMouth(_level: number): void {
    // 何もしない
  }

  setExpression(_name: string | null): void {
    // 何もしない
  }

  playMotion(_group: string, _index?: number): void {
    // 何もしない
  }

  destroy(): void {
    // 何もしない
  }
}
