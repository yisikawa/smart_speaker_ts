import { AppConfig, SherpaModelType } from "./schema";

/** 数値項目を持つセクション */
type NumericSection = "audio" | "conversation" | "stt" | "llm" | "tts";

interface ClampRule {
  section: NumericSection;
  key: string;
  min: number;
  max: number;
}

/**
 * 数値項目の許容範囲（宣言的テーブル）。
 *
 * 既定値は `schema.ts`、範囲はここが真実源。項目を追加したら
 * 1) `schema.ts` の型と既定値、2) このテーブル、3) `settings.default.toml` を更新する
 * （3 は `npm run config:default` と `tests/config-defaults.test.ts` で担保する）。
 */
const CLAMP_RULES: ClampRule[] = [
  { section: "audio", key: "sample_rate", min: 8000, max: 48000 },
  { section: "audio", key: "frame_ms", min: 10, max: 100 },
  { section: "audio", key: "pre_roll_ms", min: 0, max: 2000 },
  { section: "audio", key: "max_record_seconds", min: 1, max: 60 },
  { section: "audio", key: "silence_threshold", min: 0.0001, max: 1 },
  { section: "audio", key: "silence_threshold_max", min: 0.001, max: 0.5 },
  { section: "audio", key: "silence_duration", min: 0.2, max: 10 },
  { section: "audio", key: "no_speech_timeout", min: 0.5, max: 60 },
  { section: "audio", key: "smoothing_alpha", min: 0.01, max: 1 },
  { section: "audio", key: "relative_threshold_multiplier", min: 1, max: 20 },
  { section: "audio", key: "calibration_duration", min: 0, max: 5 },
  { section: "audio", key: "debounce_frames", min: 1, max: 50 },
  { section: "audio", key: "input_gain", min: 0.1, max: 10 },
  { section: "audio", key: "output_volume", min: 0, max: 1 },
  { section: "audio", key: "device_settle_ms", min: 0, max: 3000 },

  { section: "conversation", key: "max_followup_turns", min: 0, max: 10 },
  { section: "conversation", key: "followup_timeout_seconds", min: 0.5, max: 60 },
  { section: "conversation", key: "followup_guard_ms", min: 0, max: 5000 },
  { section: "conversation", key: "barge_in_min_score", min: 0.0001, max: 1 },

  { section: "stt", key: "beam_size", min: 1, max: 8 },
  { section: "stt", key: "threads", min: 1, max: 64 },
  { section: "stt", key: "timeout_seconds", min: 5, max: 600 },
  { section: "stt", key: "max_context", min: 0, max: 64 },
  { section: "stt", key: "no_speech_thold", min: 0, max: 1 },
  { section: "stt", key: "drop_no_speech_prob", min: 0, max: 1 },
  { section: "stt", key: "drop_avg_logprob", min: -5, max: 0 },
  { section: "stt", key: "min_input_rms", min: 0, max: 0.1 },

  { section: "llm", key: "temperature", min: 0, max: 2 },
  { section: "llm", key: "max_tokens", min: 32, max: 8192 },
  { section: "llm", key: "response_timeout_seconds", min: 5, max: 600 },
  { section: "llm", key: "history_turns", min: 0, max: 40 },

  { section: "tts", key: "speaker_id", min: 0, max: 1000 },
  { section: "tts", key: "speed", min: 0.25, max: 4 },
  { section: "tts", key: "pitch", min: -1, max: 1 },
  { section: "tts", key: "volume", min: 0, max: 2 },
  { section: "tts", key: "timeout_seconds", min: 5, max: 300 },
];

function clampField(
  target: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  label: string,
  warnings: string[]
): void {
  const raw = target[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    warnings.push(`${label} が数値ではありません（既定値を使用します）`);
    return;
  }
  if (raw < min || raw > max) {
    const clamped = Math.min(max, Math.max(min, raw));
    warnings.push(`${label}=${raw} は範囲外 (${min}..${max}) のため ${clamped} に補正しました`);
    target[key] = clamped;
  }
}

/**
 * 設定値を検証し、危険な値は既定レンジへ補正する。
 * 補正内容は警告メッセージとして返す（起動時にログ出力される）。
 */
export function sanitizeConfig(config: AppConfig): string[] {
  const warnings: string[] = [];

  for (const rule of CLAMP_RULES) {
    clampField(
      config[rule.section] as unknown as Record<string, unknown>,
      rule.key,
      rule.min,
      rule.max,
      `${rule.section}.${rule.key}`,
      warnings
    );
  }

  if (config.audio.silence_threshold_max < config.audio.silence_threshold) {
    warnings.push(
      `audio.silence_threshold_max (${config.audio.silence_threshold_max}) が silence_threshold (${config.audio.silence_threshold}) より小さいため、しきい値の下限に合わせます`
    );
    config.audio.silence_threshold_max = config.audio.silence_threshold;
  }

  const player = config.audio.player;
  if (player !== "auto" && player !== "ffplay" && player !== "soundplayer") {
    warnings.push(`audio.player=${String(player)} は未対応のため "auto" を使用します`);
    config.audio.player = "auto";
  }

  const inputMode = config.audio.input_mode;
  if (inputMode !== "browser" && inputMode !== "server") {
    warnings.push(`audio.input_mode=${String(inputMode)} は未対応のため "browser" を使用します`);
    config.audio.input_mode = "browser";
  }

  const engine = config.stt.engine;
  if (engine !== "whisper" && engine !== "sherpa") {
    warnings.push(`stt.engine=${String(engine)} は未対応のため "whisper" を使用します`);
    config.stt.engine = "whisper";
  }

  const modelTypes: SherpaModelType[] = ["nemo_transducer", "nemo_ctc", "sense_voice", "zipformer_transducer"];
  if (!modelTypes.includes(config.stt.sherpa_model_type)) {
    warnings.push(
      `stt.sherpa_model_type=${String(config.stt.sherpa_model_type)} は未対応のため "nemo_transducer" を使用します`
    );
    config.stt.sherpa_model_type = "nemo_transducer";
  }

  if (!config.stt.sherpa_provider.trim()) {
    config.stt.sherpa_provider = "cpu";
  }
  if (!config.stt.sherpa_language.trim()) {
    config.stt.sherpa_language = config.stt.language || "ja";
  }

  if (!Array.isArray(config.wakeword.wakeword_path)) {
    warnings.push("wakeword.wakeword_path が配列ではありません（空として扱います）");
    config.wakeword.wakeword_path = [];
  }

  return warnings;
}
