import { mouthLevelAt } from "../../shared/avatar/lipSync";
import type { AudioPlayer } from "../AudioPlayer";

export interface LipSyncDeps {
  player: AudioPlayer;
  onLevel(level: number): void;
  /** 0..1（大きいほど追従が速い） */
  smoothing: number;
}

/** 再生時刻と音量列から口の開きを毎フレーム更新する */
export class LipSyncDriver {
  private raf = 0;
  private level = 0;
  private running = false;

  constructor(private readonly deps: LipSyncDeps) {}

  start(): void {
    if (this.running || typeof requestAnimationFrame !== "function") {
      return;
    }
    this.running = true;
    const tick = (): void => {
      const info = this.deps.player.isPlaying() ? this.deps.player.currentVolumes() : null;
      const target = info
        ? mouthLevelAt(info.volumes, info.sliceMs, this.deps.player.elapsedMs(), {
            previous: this.level,
            smoothing: this.deps.smoothing,
          })
        : mouthLevelAt([], 20, 0, { previous: this.level, smoothing: this.deps.smoothing });
      this.level = target;
      this.deps.onLevel(target);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.raf);
    }
  }
}
