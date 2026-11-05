import { AppConfig } from "./schema";

function clampField<T extends object>(
  target: T,
  key: Extract<keyof T, string>,
  min: number,
  max: number,
  label: string,
  warnings: string[]
): void {
  const raw = (target as Record<string, unknown>)[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    warnings.push(`${label} が数値ではありません（既定値を使用します）`);
    return;
  }
  if (raw < min || raw > max) {
    const clamped = Math.min(max, Math.max(min, raw));
    warnings.push(`${label}=${raw} は範囲外 (${min}..${max}) のため ${clamped} に補正しました`);
    (target as Record<string, unknown>)[key] = clamped;
  }
}

/**
 * 設定値を検証し、危険な値は既定レンジへ補正する。
 * 補正内容は警告メッセージとして返す（起動時にログ出力される）。
 */
export function sanitizeConfig(config: AppConfig): string[] {
  const warnings: string[] = [];

  clampField(config.audio, "sample_rate", 8000, 48000, "audio.sample_rate", warnings);
  clampField(config.audio, "frame_ms", 10, 100, "audio.frame_ms", warnings);
  clampField(config.audio, "pre_roll_ms", 0, 2000, "audio.pre_roll_ms", warnings);
  clampField(config.audio, "max_record_seconds", 1, 60, "audio.max_record_seconds", warnings);
  clampField(config.audio, "silence_threshold", 0.0001, 1, "audio.silence_threshold", warnings);
  clampField(config.audio, "silence_duration", 0.2, 10, "audio.silence_duration", warnings);
  clampField(config.audio, "no_speech_timeout", 0.5, 60, "audio.no_speech_timeout", warnings);
  clampField(config.audio, "smoothing_alpha", 0.01, 1, "audio.smoothing_alpha", warnings);
  clampField(
    config.audio,
    "relative_threshold_multiplier",
    1,
    20,
    "audio.relative_threshold_multiplier",
    warnings
  );
  clampField(config.audio, "calibration_duration", 0, 5, "audio.calibration_duration", warnings);
  clampField(config.audio, "debounce_frames", 1, 50, "audio.debounce_frames", warnings);
  clampField(config.audio, "input_gain", 0.1, 10, "audio.input_gain", warnings);
  clampField(config.audio, "output_volume", 0, 1, "audio.output_volume", warnings);

  clampField(config.conversation, "max_followup_turns", 0, 10, "conversation.max_followup_turns", warnings);
  clampField(
    config.conversation,
    "followup_timeout_seconds",
    0.5,
    60,
    "conversation.followup_timeout_seconds",
    warnings
  );
  clampField(config.conversation, "followup_guard_ms", 0, 5000, "conversation.followup_guard_ms", warnings);
  clampField(
    config.conversation,
    "barge_in_min_score",
    0.0001,
    1,
    "conversation.barge_in_min_score",
    warnings
  );

  clampField(config.stt, "beam_size", 1, 8, "stt.beam_size", warnings);
  clampField(config.stt, "threads", 1, 64, "stt.threads", warnings);
  clampField(config.stt, "timeout_seconds", 5, 600, "stt.timeout_seconds", warnings);

  clampField(config.llm, "temperature", 0, 2, "llm.temperature", warnings);
  clampField(config.llm, "max_tokens", 32, 8192, "llm.max_tokens", warnings);
  clampField(config.llm, "response_timeout_seconds", 5, 600, "llm.response_timeout_seconds", warnings);
  clampField(config.llm, "history_turns", 0, 40, "llm.history_turns", warnings);

  clampField(config.tts, "speaker_id", 0, 1000, "tts.speaker_id", warnings);
  clampField(config.tts, "speed", 0.25, 4, "tts.speed", warnings);
  clampField(config.tts, "pitch", -1, 1, "tts.pitch", warnings);
  clampField(config.tts, "volume", 0, 2, "tts.volume", warnings);
  clampField(config.tts, "timeout_seconds", 5, 300, "tts.timeout_seconds", warnings);

  const player = config.audio.player;
  if (player !== "auto" && player !== "ffplay" && player !== "soundplayer") {
    warnings.push(`audio.player=${String(player)} は未対応のため "auto" を使用します`);
    config.audio.player = "auto";
  }

  if (!Array.isArray(config.wakeword.wakeword_path)) {
    warnings.push("wakeword.wakeword_path が配列ではありません（空として扱います）");
    config.wakeword.wakeword_path = [];
  }

  return warnings;
}
