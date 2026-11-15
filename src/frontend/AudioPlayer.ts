import type { ClientCommand, HelloPayload, PipelineEvent } from "../shared/protocol";
import { bytesFromBase64 } from "../shared/audio/pcm";

type AudioEvent = Extract<PipelineEvent, { type: "tts_audio" }>;

export interface AudioPlayerDeps {
  send(command: ClientCommand): void;
  onPlayingChange?(playing: boolean): void;
}

/**
 * `tts_audio` を WebAudio で順番に再生する。
 * 再生が終わったら `audio_playback_done` を返し、サーバーの `speaking` を終わらせる。
 */
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private volume = 1;
  private readonly ready: { event: AudioEvent; buffer: AudioBuffer }[] = [];
  private current: AudioBufferSourceNode | null = null;
  private playing = false;
  /** stop 後に古い onended が ack を送らないようにするための世代番号 */
  private token = 0;

  constructor(private readonly deps: AudioPlayerDeps) {}

  configure(cfg: HelloPayload["audio"]): void {
    this.volume = Math.min(1, Math.max(0, cfg.outputVolume));
    if (this.gain) {
      this.gain.gain.value = this.volume;
    }
  }

  /** ユーザー操作の中で呼ぶ（自動再生ポリシー対策） */
  async prime(): Promise<void> {
    const ctx = this.context();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // 次の操作で再試行する
      }
    }
  }

  enqueue(event: AudioEvent): void {
    void this.decode(event);
  }

  stop(): void {
    this.token += 1;
    this.ready.length = 0;
    if (this.current) {
      try {
        this.current.stop();
      } catch {
        // 既に停止している場合は無視
      }
      this.current = null;
    }
    if (this.playing) {
      this.playing = false;
      this.deps.onPlayingChange?.(false);
    }
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.gain = null;
  }

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private async decode(event: AudioEvent): Promise<void> {
    try {
      const copy = new Uint8Array(bytesFromBase64(event.audio));
      const buffer = await this.context().decodeAudioData(copy.buffer as ArrayBuffer);
      this.ready.push({ event, buffer });
      this.pump();
    } catch (error) {
      console.warn("[Audio] 音声をデコードできませんでした", error);
      this.deps.send({ type: "audio_playback_done", utteranceId: event.utteranceId });
    }
  }

  private pump(): void {
    if (this.playing || this.ready.length === 0) {
      return;
    }
    const next = this.ready.shift()!;
    const source = this.context().createBufferSource();
    source.buffer = next.buffer;
    if (this.gain) {
      source.connect(this.gain);
    }

    const token = this.token;
    this.playing = true;
    this.current = source;
    this.deps.onPlayingChange?.(true);

    source.onended = () => {
      if (token !== this.token) {
        return;
      }
      this.current = null;
      this.playing = false;
      this.deps.send({ type: "audio_playback_done", utteranceId: next.event.utteranceId });
      this.pump();
    };

    source.start();
  }
}
