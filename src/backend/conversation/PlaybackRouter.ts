import { ConfigManager } from "../config/ConfigManager";
import { Logger } from "../core/logger";
import type { PlaybackHandle, PlaybackMeta, PlaybackSink } from "../core/ports";

/**
 * 設定（`audio.playback_target`）と接続状況から実際の出力先を選ぶ。
 * ブラウザ再生を指定されていても表示クライアントが居なければサーバー再生へ落とす。
 */
export class PlaybackRouter implements PlaybackSink {
  private readonly logger: Logger;

  constructor(
    private readonly deps: {
      config: ConfigManager;
      server: PlaybackSink;
      browser: PlaybackSink;
      logger?: Logger;
    }
  ) {
    this.logger = deps.logger ?? new Logger("Playback");
  }

  get kind(): "server" | "browser" {
    return this.resolve().kind;
  }

  isAvailable(): boolean {
    return this.resolve().isAvailable();
  }

  play(wav: Buffer, meta: PlaybackMeta): PlaybackHandle {
    return this.resolve().play(wav, meta);
  }

  private resolve(): PlaybackSink {
    const target = this.deps.config.getAudio().playback_target;
    if (target === "browser") {
      if (this.deps.browser.isAvailable()) {
        return this.deps.browser;
      }
      this.logger.warn("ブラウザ再生が指定されていますが表示クライアントがいません（サーバー再生へ切り替えます）");
    }
    return this.deps.server;
  }
}
