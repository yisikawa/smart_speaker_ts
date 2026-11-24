import type { TTSConfig, TtsProfile } from "../config/schema";

/**
 * `[tts.ja]` の実効プロファイルを組み立てる。
 *
 * `[tts]` 直下の既存キー（engine / endpoint / speaker_id / speed）が既定値で、
 * `[tts.ja]` は「上書き」として重ねる。これにより、
 *
 * - 何も書かなければ従来どおり VOICEVOX（後方互換）
 * - `[tts.ja].engine = "gpt_sovits"` にすれば **ja も en と同じエンジン**になり、
 *   参照音声を共有して日英の声質を揃えられる（B 案）
 *
 * という 2 通りを 1 つの設定で表現できる。
 */
export function resolveJaProfile(tts: TTSConfig): TtsProfile {
  const ja = tts.ja ?? {};
  return {
    engine: ja.engine ?? tts.engine,
    endpoint: ja.endpoint?.trim() ? ja.endpoint : tts.endpoint,
    model: ja.model ?? "",
    voice: ja.voice ?? "",
    speaker_id: ja.speaker_id ?? tts.speaker_id,
    speed: ja.speed ?? tts.speed,
    reference_wav: ja.reference_wav ?? "",
    reference_text: ja.reference_text ?? "",
    prompt_lang: ja.prompt_lang?.trim() ? ja.prompt_lang : "ja",
  };
}

/** プロファイルの表示名（hello / ログ用） */
export function describeProfile(profile: TtsProfile): string {
  if (profile.engine === "gpt_sovits") {
    return `gpt_sovits:${profile.reference_wav || "(no ref)"}`;
  }
  if (profile.engine === "voicevox") {
    return `voicevox:${profile.speaker_id}`;
  }
  return `openai_speech:${profile.model}/${profile.voice}`;
}
