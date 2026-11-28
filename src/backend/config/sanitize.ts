import { AppConfig, DEFAULT_CONFIG } from "./schema";
import { isSherpaModelType } from "../../shared/stt/modelTypes";
import { DEFAULT_PORT, MAX_PORT, MIN_PORT, isValidPort } from "../../shared/port";

/** 数値項目を持つセクション */
type NumericSection = "audio" | "conversation" | "stt" | "llm" | "tts" | "avatar" | "gui";

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
  { section: "llm", key: "model_load_timeout_seconds", min: 30, max: 900 },
  { section: "llm", key: "history_turns", min: 0, max: 40 },

  { section: "tts", key: "speaker_id", min: 0, max: 1000 },
  { section: "tts", key: "speed", min: 0.25, max: 4 },
  { section: "tts", key: "pitch", min: -1, max: 1 },
  { section: "tts", key: "volume", min: 0, max: 2 },
  { section: "tts", key: "timeout_seconds", min: 5, max: 300 },

  { section: "avatar", key: "scale", min: 0.1, max: 5 },
  { section: "avatar", key: "offset_x", min: -1, max: 1 },
  { section: "avatar", key: "offset_y", min: -1, max: 2 },
  { section: "avatar", key: "idle_motion_interval_seconds", min: 0, max: 600 },
  { section: "avatar", key: "lip_sync_smoothing", min: 0, max: 1 },
  { section: "avatar", key: "lip_sync_gain", min: 0, max: 3 },

  { section: "llm", key: "num_ctx", min: 512, max: 32768 },
  { section: "tts", key: "prefetch_depth", min: 0, max: 3 },
  { section: "tts", key: "min_sentence_chars", min: 1, max: 40 },
  { section: "tts", key: "max_sentence_chars", min: 10, max: 200 },
  { section: "gui", key: "caption_font_size", min: 12, max: 120 },
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
/** RVC の f0 推定方式（`rvc_python` が受け付ける値） */
const F0_METHODS = ["rmvpe", "harvest", "crepe", "pm"] as const;

/**
 * `tts.voice_conversion` を RVC の仕様範囲へ補正する。
 *
 * 範囲外の値はワーカー（rvc_python）側で落ちるため、設定ファイルに何が書かれていても
 * ここで必ず収める。真実源は `schema.ts`（既定値）とこの関数（範囲）。
 */
function clampVoiceConversion(
  vc: AppConfig["tts"]["voice_conversion"],
  warnings: string[]
): void {
  const defaults = DEFAULT_CONFIG.tts.voice_conversion;

  if (!Number.isFinite(vc.index_rate)) {
    vc.index_rate = defaults.index_rate;
  } else if (vc.index_rate < 0 || vc.index_rate > 1) {
    vc.index_rate = Math.min(1, Math.max(0, vc.index_rate));
    warnings.push(`tts.voice_conversion.index_rate を ${vc.index_rate} に補正しました`);
  }

  if (!Number.isFinite(vc.protect) || vc.protect < 0 || vc.protect > 0.5) {
    const value = Number.isFinite(vc.protect) ? vc.protect : defaults.protect;
    vc.protect = Math.min(0.5, Math.max(0, value));
    warnings.push(`tts.voice_conversion.protect を ${vc.protect} に補正しました`);
  }

  if (!Number.isInteger(vc.pitch) || vc.pitch < -24 || vc.pitch > 24) {
    vc.pitch = 0;
    warnings.push("tts.voice_conversion.pitch を 0 に補正しました");
  }

  if (!F0_METHODS.includes(vc.f0_method as (typeof F0_METHODS)[number])) {
    vc.f0_method = defaults.f0_method;
    warnings.push(`tts.voice_conversion.f0_method を ${vc.f0_method} に補正しました`);
  }
}

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
    warnings.push(
      `stt.engine=${String(engine)} は未対応のため "${DEFAULT_CONFIG.stt.engine}" を使用します`
    );
    config.stt.engine = DEFAULT_CONFIG.stt.engine;
  }

  if (!isSherpaModelType(config.stt.sherpa_model_type)) {
    warnings.push(
      `stt.sherpa_model_type=${String(config.stt.sherpa_model_type)} は未対応のため "${DEFAULT_CONFIG.stt.sherpa_model_type}" を使用します`
    );
    config.stt.sherpa_model_type = DEFAULT_CONFIG.stt.sherpa_model_type;
  }

  if (!config.stt.sherpa_provider.trim()) {
    config.stt.sherpa_provider = DEFAULT_CONFIG.stt.sherpa_provider;
  }
  if (!config.stt.sherpa_language.trim()) {
    config.stt.sherpa_language = config.stt.language || DEFAULT_CONFIG.stt.sherpa_language;
  }

  if (!Array.isArray(config.wakeword.wakeword_path)) {
    warnings.push("wakeword.wakeword_path が配列ではありません（空として扱います）");
    config.wakeword.wakeword_path = [];
  }

  if (config.audio.playback_target !== "server" && config.audio.playback_target !== "browser") {
    warnings.push(
      `audio.playback_target=${String(config.audio.playback_target)} は未対応のため "${DEFAULT_CONFIG.audio.playback_target}" を使用します`
    );
    config.audio.playback_target = DEFAULT_CONFIG.audio.playback_target;
  }

  if (config.gui.layout !== "chat" && config.gui.layout !== "stage") {
    warnings.push(`gui.layout=${String(config.gui.layout)} は未対応のため "chat" を使用します`);
    config.gui.layout = "chat";
  }

  if (!config.llm.keep_alive.trim()) {
    config.llm.keep_alive = "30m";
  }

  // 言語モード（ja / en 以外は既定値に戻す）
  if (config.conversation.language !== "ja" && config.conversation.language !== "en") {
    warnings.push(
      `conversation.language=${String(config.conversation.language)} は未対応のため "${DEFAULT_CONFIG.conversation.language}" を使用します`
    );
    config.conversation.language = DEFAULT_CONFIG.conversation.language;
  }

  // 読み上げエンジン（日本語＝[tts]、英語＝[tts.en]）
  const ttsEngines = ["voicevox", "openai_speech", "gpt_sovits"];
  if (!ttsEngines.includes(config.tts.engine)) {
    warnings.push(
      `tts.engine=${String(config.tts.engine)} は未対応のため "${DEFAULT_CONFIG.tts.engine}" を使用します`
    );
    config.tts.engine = DEFAULT_CONFIG.tts.engine;
  }
  if (!config.tts.en || typeof config.tts.en !== "object") {
    config.tts.en = { ...DEFAULT_CONFIG.tts.en };
  }
  if (!ttsEngines.includes(config.tts.en.engine)) {
    warnings.push(
      `tts.en.engine=${String(config.tts.en.engine)} は未対応のため "${DEFAULT_CONFIG.tts.en.engine}" を使用します`
    );
    config.tts.en.engine = DEFAULT_CONFIG.tts.en.engine;
  }
  if (!config.tts.en.endpoint.trim()) {
    config.tts.en.endpoint = DEFAULT_CONFIG.tts.en.endpoint;
  }
  if (!config.tts.en.prompt_lang.trim()) {
    config.tts.en.prompt_lang = DEFAULT_CONFIG.tts.en.prompt_lang;
  }

  // 日本語モードの上書き（[tts.ja]。未指定なら [tts] 直下）
  if (!config.tts.ja || typeof config.tts.ja !== "object") {
    config.tts.ja = {};
  }
  if (config.tts.ja.engine !== undefined && !ttsEngines.includes(config.tts.ja.engine)) {
    warnings.push(
      `tts.ja.engine=${String(config.tts.ja.engine)} は未対応のため [tts].engine を使用します`
    );
    delete config.tts.ja.engine;
  }

  // 声質変換（既定は有効。モデル未設定なら実行時にスキップするので、ここでは無効化しない）
  const vc = config.tts.voice_conversion;
  if (!vc || typeof vc !== "object") {
    config.tts.voice_conversion = { ...DEFAULT_CONFIG.tts.voice_conversion };
  } else {
    clampVoiceConversion(vc, warnings);
  }

  // 配信（HTTPS・LAN 公開）。`[server]` が無い設定ファイルでも既定で補完する
  const srv = config.server;
  if (!srv || typeof srv !== "object") {
    config.server = { ...DEFAULT_CONFIG.server };
  } else {
    if (!isValidPort(srv.port)) {
      warnings.push(
        `server.port=${String(srv.port)} は ${MIN_PORT}..${MAX_PORT} の整数ではないため ${DEFAULT_PORT} を使用します`
      );
      srv.port = DEFAULT_PORT;
    }
    if (typeof srv.https !== "boolean") srv.https = DEFAULT_CONFIG.server.https;
    if (typeof srv.cert_path !== "string") srv.cert_path = DEFAULT_CONFIG.server.cert_path;
    if (typeof srv.key_path !== "string") srv.key_path = DEFAULT_CONFIG.server.key_path;
    if (typeof srv.host !== "string") srv.host = DEFAULT_CONFIG.server.host;
  }

  return warnings;
}
