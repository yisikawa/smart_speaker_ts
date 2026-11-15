import { bytesToBase64 } from "../../shared/audio/pcm";
import type { ServerMessage } from "../../shared/protocol";
import { Logger } from "../core/logger";
import type { PlaybackHandle, PlaybackMeta, PlaybackSink } from "../core/ports";

export interface WsPlaybackSinkDeps {
  /** 配信（`tts_audio` は WsHub が primary に絞る） */
  send: (message: ServerMessage) => boolean;
  /** 音声を鳴らせるクライアントがいるか */
  hasPrimaryClient: () => boolean;
  logger?: Logger;
  /** ack が来ないときの猶予（ms） */
  timeoutMarginMs?: number;
}

/**
 * ブラウザ（WebAudio）で再生する sink。
 * `tts_audio` を送り、クライアントの `audio_playback_done` を待つ。
 * 通知が来なくても **必ず** `durationMs + 猶予` で解決する（`speaking` で固まらないため）。
 */
export class WsPlaybackSink implements PlaybackSink {
  readonly kind = "browser" as const;
  private readonly logger: Logger;
  private readonly pending = new Map<string, () => void>();

  constructor(private readonly deps: WsPlaybackSinkDeps) {
    this.logger = deps.logger ?? new Logger("Playback");
  }

  isAvailable(): boolean {
    return this.deps.hasPrimaryClient();
  }

  play(wav: Buffer, meta: PlaybackMeta): PlaybackHandle {
    if (!this.isAvailable()) {
      return { finished: Promise.resolve(), stop: () => undefined };
    }

    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      this.pending.delete(meta.utteranceId);
      clearTimeout(timer);
      resolveFinished();
    };

    timer = setTimeout(() => {
      this.logger.warn(`再生完了通知が来ません: ${meta.utteranceId}（タイムアウトで継続します）`);
      settle();
    }, Math.max(0, meta.durationMs) + (this.deps.timeoutMarginMs ?? 1500));
    (timer as unknown as { unref?: () => void }).unref?.();
    this.pending.set(meta.utteranceId, settle);

    const sent = this.deps.send({
      type: "event",
      event: {
        type: "tts_audio",
        utteranceId: meta.utteranceId,
        text: meta.text,
        expression: meta.expression,
        audio: bytesToBase64(wav),
        volumes: meta.volumes,
        sliceMs: meta.sliceMs,
        durationMs: meta.durationMs,
      },
    });
    if (!sent) {
      this.logger.warn("音声を送信できませんでした（クライアント未接続）");
      settle();
    }

    return { finished, stop: () => settle() };
  }

  /** クライアントの `audio_playback_done` を受ける */
  resolveDone(utteranceId: string): void {
    this.pending.get(utteranceId)?.();
  }

  /** 待機中の再生をすべて解く（終了処理用） */
  dispose(): void {
    for (const settle of [...this.pending.values()]) {
      settle();
    }
  }
}
