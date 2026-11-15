import type { AudioIO, PlaybackHandle, PlaybackMeta, PlaybackSink } from "../core/ports";

/** サーバー（ffplay / SoundPlayer）で再生する sink。`volumes` は使わない */
export class ServerPlaybackSink implements PlaybackSink {
  readonly kind = "server" as const;

  constructor(private readonly deps: { audio: AudioIO }) {}

  isAvailable(): boolean {
    return true;
  }

  play(wav: Buffer, _meta: PlaybackMeta): PlaybackHandle {
    return this.deps.audio.play(wav);
  }
}
