import type { AssistantState, PipelineEvent } from "../../shared/protocol";
import { ConfigManager } from "../config/ConfigManager";
import { AudioIO, CaptureHandle, CaptureResult } from "../core/ports";

export interface ListeningHooks {
  emit(event: PipelineEvent): void;
  setState(state: AssistantState): void;
  /** 録音ハンドルを預ける（stop() で中断できるようにする）。終了時は null */
  onCapture(handle: CaptureHandle | null): void;
  /** ターンループが継続中か */
  isActive(): boolean;
}

export interface ListeningOptions {
  /** フォローアップ（連続聞き取り）かどうか。開始待ち・案内の条件に使う */
  followup: boolean;
}

/**
 * 1 回分の録音（VAD による自動区切り）と、録れなかった場合の案内。
 *
 * 「録音 → 判定 → 案内」を 1 箇所にまとめ、パイプライン（状態機械）から録音の詳細を追い出す。
 */
export class ListeningLoop {
  constructor(private readonly deps: { config: ConfigManager; audio: AudioIO }) {}

  /** 発話 WAV を返す。発話が無い・デバイス異常なら null（理由はイベントで通知済み） */
  async capture(hooks: ListeningHooks, options: ListeningOptions): Promise<Buffer | null> {
    const conv = this.deps.config.getConversation();
    const audio = this.deps.config.getAudio();

    // 応答直後は自分の声を拾わないよう少し待つ
    if (options.followup) {
      await sleep(conv.followup_guard_ms);
      if (!hooks.isActive()) {
        return null;
      }
    }

    hooks.setState("recording");
    hooks.emit({ type: "recording_started" });

    const startTimeoutMs =
      (options.followup ? conv.followup_timeout_seconds : audio.no_speech_timeout) * 1000;
    let lastLevelAt = 0;
    const capture = this.deps.audio.capture({
      maxDurationMs: audio.max_record_seconds * 1000,
      startTimeoutMs,
      onLevel: (level, threshold) => {
        const now = Date.now();
        if (now - lastLevelAt < 100) {
          return; // UI へは 10Hz 程度に間引いて送る
        }
        lastLevelAt = now;
        hooks.emit({
          type: "level",
          level: Number(level.toFixed(3)),
          threshold: Number(threshold.toFixed(3)),
        });
      },
    });
    hooks.onCapture(capture);

    const result = await capture.result;
    hooks.onCapture(null);
    hooks.emit({
      type: "recording_stopped",
      durationMs: result.durationMs,
      reason: result.reason,
    });

    if (!hooks.isActive()) {
      return null;
    }
    if (!result.hasSpeech) {
      this.reportEmpty(result, options.followup, audio.silence_threshold, hooks);
      return null;
    }
    return result.wav;
  }

  /** 録れなかった理由をユーザーへ伝える（マイク設定の切り分け用） */
  private reportEmpty(
    result: CaptureResult,
    followup: boolean,
    silenceThreshold: number,
    hooks: ListeningHooks
  ): void {
    if (result.reason === "device_error") {
      hooks.emit({
        type: "error",
        scope: "audio",
        message:
          "マイク入力を開始できませんでした。音声デバイスの設定（audio.input_device）を確認してください。",
      });
      return;
    }
    if (result.frames === 0 && result.reason !== "aborted") {
      hooks.emit({
        type: "error",
        scope: "audio",
        message:
          "マイクから音声データが取得できませんでした（他アプリがマイクを使用中／ミュート／デバイス設定を確認してください）。",
      });
      return;
    }
    if (followup === false && result.peakLevel !== undefined && result.peakLevel < silenceThreshold * 0.5) {
      // 録音はできているがレベルがほぼ 0（ミュート・入力レベル 0 など）
      hooks.emit({
        type: "error",
        scope: "audio",
        message: `マイクの入力レベルがほぼ 0 です（peak=${result.peakLevel}）。Windows のサウンド設定でミュート／入力レベルを確認してください。`,
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
