import type { AvatarConfigPayload } from "../shared/protocol";
import type { StageOptions } from "../shared/ui/stageMode";
import { AvatarStage } from "./avatar/AvatarStage";
import { must } from "./dom";

/** ステージ（配信向けレイアウト）と字幕・アバターの表示を担当する */
export class StageView {
  private readonly stageEl = must<HTMLElement>("stage");
  private readonly captionEl = must<HTMLElement>("caption");
  private readonly avatar = new AvatarStage();
  private mode: "chat" | "stage" = "chat";

  apply(options: StageOptions): void {
    this.mode = options.mode;
    document.body.classList.toggle("stage-mode", options.mode === "stage");
    document.body.classList.toggle("transparent", options.transparent);
    this.stageEl.classList.toggle("hidden", options.mode !== "stage");
    this.captionEl.classList.toggle("hidden", options.mode !== "stage");
  }

  async mountAvatar(config: AvatarConfigPayload): Promise<void> {
    await this.avatar.mount(this.stageEl, config);
    const empty = config.renderer === "none";
    this.stageEl.classList.toggle("hidden", this.mode !== "stage" || empty);
  }

  setMouth(level: number): void {
    this.avatar.setMouth(level);
  }

  setCaption(text: string, final: boolean): void {
    this.captionEl.textContent = text;
    this.captionEl.classList.toggle("final", final);
    if (this.mode === "stage") {
      this.captionEl.classList.remove("hidden");
    }
  }
}
