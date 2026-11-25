import type { ClientCommand, HelloPayload, PipelineEvent } from "../shared/protocol";
import { bytesFromBase64 } from "../shared/audio/pcm";

type AudioEvent = Extract<PipelineEvent, { type: "tts_audio" }>;

export interface AudioPlayerDeps {
  send(command: ClientCommand): void;
  onPlayingChange?(playing: boolean): void;
  /** AudioContext の生成（テスト用。既定は `new AudioContext()`） */
  createContext?: () => AudioContext;
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
  /** 再生中の音量列（口パク用） */
  private currentVolumesInfo: { volumes: number[]; sliceMs: number } | null = null;
  /** 再生開始時の AudioContext 時刻 */
  private startedAt = 0;
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

  /** 再生中か（口パクの判定に使う） */
  isPlaying(): boolean {
    return this.playing;
  }

  /** 現在の音声の再生位置（ms） */
  elapsedMs(): number {
    return this.ctx ? Math.max(0, (this.ctx.currentTime - this.startedAt) * 1000) : 0;
  }

  /** 再生中の音量列（口パク用）。停止中は null */
  currentVolumes(): { volumes: number[]; sliceMs: number } | null {
    return this.currentVolumesInfo;
  }

  stop(): void {
    this.token += 1;
    this.ready.length = 0;
    this.currentVolumesInfo = null;
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
      this.ctx = this.deps.createContext?.() ?? new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private async decode(event: AudioEvent): Promise<void> {
    const token = this.token;
    try {
      const copy = new Uint8Array(bytesFromBase64(event.audio));
      const buffer = await this.context().decodeAudioData(copy.buffer as ArrayBuffer);
      if (token !== this.token) {
        // stop() 済み。デコード結果は捨てる（ack も送らない）
        return;
      }
      this.ready.push({ event, buffer });
      this.pump();
    } catch (error) {
      console.warn("[Audio] 音声をデコードできませんでした", error);
      if (token === this.token) {
        this.deps.send({ type: "audio_playback_done", utteranceId: event.utteranceId });
      }
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
    this.startedAt = this.context().currentTime;
    this.currentVolumesInfo = { volumes: next.event.volumes, sliceMs: next.event.sliceMs };
    this.deps.onPlayingChange?.(true);

    source.onended = () => {
      if (token !== this.token) {
        return;
      }
      this.current = null;
      this.playing = false;
      this.currentVolumesInfo = null;
      this.deps.send({ type: "audio_playback_done", utteranceId: next.event.utteranceId });
      this.pump();
    };

    source.start();
  }
}
