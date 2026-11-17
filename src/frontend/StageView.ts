import type { AvatarConfigPayload } from "../shared/protocol";
import type { StageOptions } from "../shared/ui/stageMode";
import { AvatarStage } from "./avatar/AvatarStage";
import { must } from "./dom";

/** 背景設定（色 / `assets/avatar/x.jpg` / URL）を CSS の background へ変換する */
function toBackground(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "#0f1117";
  }

  // ローカル素材は `/avatar-assets/` で配信されるため、URL へ読み替える
  const local = trimmed.match(/^assets[\\/]avatar[\\/](.+)$/i);
  const target = local ? `/avatar-assets/${local[1].replace(/\\/g, "/")}` : trimmed;

  const looksLikeImage =
    /^(https?:|\/|\.\/|data:image\/)/i.test(target) || /\.(png|jpe?g|webp|gif|avif)$/i.test(target);
  return looksLikeImage ? `url("${target}") center / cover no-repeat` : target;
}

/** ステージ（配信向けレイアウト）と字幕・アバターの表示を担当する */
export class StageView {
  private readonly stageEl = must<HTMLElement>("stage");
  private readonly captionEl = must<HTMLElement>("caption");
  private readonly avatar = new AvatarStage();
  private mode: StageOptions["mode"] = "split";

  apply(options: StageOptions): void {
    this.mode = options.mode;
    document.body.classList.toggle("stage-mode", options.mode === "stage");
    document.body.classList.toggle("split-mode", options.mode === "split");
    document.body.classList.toggle("transparent", options.transparent);
    this.stageEl.classList.toggle("hidden", options.mode === "chat");
    // 字幕は配信向けの stage / split で使う（空文字のときは CSS の :empty で隠れる）
    this.captionEl.classList.toggle("hidden", options.mode === "chat");
  }

  async mountAvatar(config: AvatarConfigPayload): Promise<void> {
    this.stageEl.style.setProperty?.("--stage-background", toBackground(config.background));
    // チャットのみの表示ではアバターは見えないため、Live2D のランタイム（pixi）を読み込まない
    if (this.mode === "chat") {
      return;
    }
    await this.avatar.mount(this.stageEl, config);
    const empty = config.renderer === "none";
    this.stageEl.classList.toggle("hidden", empty);
  }

  setMouth(level: number): void {
    this.avatar.setMouth(level);
  }

  setExpression(name: string | null): void {
    this.avatar.setExpression(name);
  }

  setCaption(text: string, final: boolean): void {
    this.captionEl.textContent = text;
    this.captionEl.classList.toggle("final", final);
    if (this.mode !== "chat") {
      this.captionEl.classList.remove("hidden");
    }
  }
}
