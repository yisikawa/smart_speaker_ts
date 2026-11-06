import type { PipelineEvent } from "../../shared/protocol";
import { ConfigManager } from "../config/ConfigManager";
import { AudioIO, CaptureHandle, PlaybackHandle } from "../core/ports";
import { wavDurationMs } from "../services/wav";

export interface PlaybackHooks {
  emit(event: PipelineEvent): void;
  /** 再生ハンドルを預ける（stop() で止められるようにする）。終了時は null */
  onPlayback(handle: PlaybackHandle | null): void;
  /** バージイン監視の録音ハンドルを預ける。終了時は null */
  onCapture(handle: CaptureHandle | null): void;
  /** ターンループが継続中か */
  isActive(): boolean;
}

/**
 * 読み上げとバージイン監視。
 *
 * - ブラウザ入力モードではクライアントがマイクを監視して `stop_speaking` を送るため、
 *   サーバー側では監視しない（自分の声を拾わないため）
 * - サーバー入力モードでは再生中の発話を検知したら再生を止め、その音声を次ターンへ渡す
 */
export class PlaybackLoop {
  constructor(private readonly deps: { config: ConfigManager; audio: AudioIO }) {}

  /** 読み上げる。バージイン発話があれば次のターンの WAV を返す */
  async play(wav: Buffer, hooks: PlaybackHooks): Promise<Buffer | undefined> {
    const conv = this.deps.config.getConversation();
    const audio = this.deps.config.getAudio();

    const playback = this.deps.audio.play(wav);
    hooks.onPlayback(playback);
    hooks.emit({ type: "speaking_started" });

    if (!conv.barge_in_enabled || audio.input_mode === "browser") {
      await playback.finished;
      hooks.onPlayback(null);
      hooks.emit({ type: "speaking_finished" });
      return undefined;
    }

    let bargedIn = false;
    const playbackMs = Math.max(1000, wavDurationMs(wav, audio.sample_rate));
    const capture = this.deps.audio.capture({
      maxDurationMs: playbackMs + audio.max_record_seconds * 1000,
      // バージインは応答音声を拾わないよう通常より高めのしきい値を使う
      threshold: Math.max(audio.silence_threshold, conv.barge_in_min_score),
      onSpeechStart: () => {
        bargedIn = true;
        playback.stop();
      },
    });
    hooks.onCapture(capture);

    await playback.finished;
    hooks.onPlayback(null);

    if (!bargedIn) {
      capture.stop("aborted");
      await capture.result.catch(() => undefined);
      hooks.onCapture(null);
      hooks.emit({ type: "speaking_finished" });
      return undefined;
    }

    hooks.emit({ type: "barge_in" });
    hooks.emit({ type: "speaking_finished" });
    const result = await capture.result;
    hooks.onCapture(null);
    return hooks.isActive() && result.hasSpeech ? result.wav : undefined;
  }
}
