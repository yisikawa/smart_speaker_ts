import type { VadSettings } from "./vad";

/**
 * `AudioConfig` のうち VAD が必要とする値（backend の型に依存しない構造的型）。
 * `src/backend/config/schema.ts` の `AudioConfig` がそのまま代入できる。
 */
export interface VadConfigSource {
  sample_rate: number;
  frame_ms: number;
  pre_roll_ms: number;
  silence_threshold: number;
  silence_duration: number;
  smoothing_alpha: number;
  relative_threshold_multiplier: number;
  silence_threshold_max: number;
  calibration_duration: number;
  debounce_frames: number;
  input_gain: number;
}

/** 秒指定の設定を ms へ直し、サーバー・ブラウザ共通の VadSettings を作る */
export function buildVadSettings(source: VadConfigSource): VadSettings {
  return {
    sampleRate: source.sample_rate,
    frameMs: source.frame_ms,
    preRollMs: source.pre_roll_ms,
    silenceThreshold: source.silence_threshold,
    silenceDurationMs: source.silence_duration * 1000,
    smoothingAlpha: source.smoothing_alpha,
    relativeThresholdMultiplier: source.relative_threshold_multiplier,
    maxSilenceThreshold: source.silence_threshold_max,
    calibrationMs: source.calibration_duration * 1000,
    debounceFrames: source.debounce_frames,
    inputGain: source.input_gain,
  };
}

/** hello で配る形（sampleRate としきい値は `audio` 直下に置くため除外） */
export interface ClientVadSettings {
  frameMs: number;
  preRollMs: number;
  silenceDurationMs: number;
  smoothingAlpha: number;
  relativeThresholdMultiplier: number;
  /** ワイヤ上は必須（既存の `audio.vad` の形に合わせる） */
  maxSilenceThreshold: number;
  calibrationMs: number;
  debounceFrames: number;
  inputGain: number;
}

export function buildClientVadSettings(source: VadConfigSource): ClientVadSettings {
  const settings = buildVadSettings(source);
  return {
    frameMs: settings.frameMs,
    preRollMs: settings.preRollMs,
    silenceDurationMs: settings.silenceDurationMs,
    smoothingAlpha: settings.smoothingAlpha,
    relativeThresholdMultiplier: settings.relativeThresholdMultiplier,
    maxSilenceThreshold: settings.maxSilenceThreshold ?? source.silence_threshold_max,
    calibrationMs: settings.calibrationMs,
    debounceFrames: settings.debounceFrames,
    inputGain: settings.inputGain,
  };
}

/**
 * ブラウザ録音用の VadSettings。
 * hello で受け取った値のうち、録音レートとしきい値だけを実測値で上書きする。
 */
export function buildBrowserVadSettings(
  vad: ClientVadSettings,
  captureRate: number,
  silenceThreshold: number
): VadSettings {
  return {
    ...vad,
    sampleRate: captureRate,
    silenceThreshold,
  };
}
