import { buildClientVadSettings } from "../../shared/audio/vadSettings";
import type {
  AssistantState,
  AvatarConfigPayload,
  ChatMessage,
  HelloPayload,
  LanguageMode,
  ModelSelection,
  ServiceStatus,
} from "../../shared/protocol";
import type { AppConfig } from "../config/schema";

export interface HelloPayloadInput {
  state: AssistantState;
  history: ChatMessage[];
  character: { name: string; label: string };
  language: LanguageMode;
  user: string;
  version: string;
  services: ServiceStatus;
  models: ModelSelection;
  /** `buildAvatarPayload()` の結果（WsHub が組み立てて渡す） */
  avatar: AvatarConfigPayload;
  /** この接続が音声を鳴らす担当か */
  isPrimary: boolean;
  audio: AppConfig["audio"];
  conversation: AppConfig["conversation"];
}

/**
 * 接続直後の初期化メッセージを組み立てる。
 * 設定 → ワイヤ形式の変換（ms 換算・VAD 導出）をこの 1 箇所に閉じ込める。
 */
export function buildHelloPayload(input: HelloPayloadInput): HelloPayload {
  const audio = input.audio;
  const conv = input.conversation;
  return {
    type: "hello",
    state: input.state,
    history: input.history,
    character: input.character,
    language: input.language,
    user: input.user,
    version: input.version,
    services: input.services,
    models: input.models,
    avatar: input.avatar,
    audio: {
      inputMode: audio.input_mode,
      playbackTarget: audio.playback_target,
      isPrimary: input.isPrimary,
      outputVolume: audio.output_volume,
      sampleRate: audio.sample_rate,
      noSpeechTimeoutMs: audio.no_speech_timeout * 1000,
      followup: {
        enabled: conv.followup_enabled,
        maxTurns: conv.max_followup_turns,
        timeoutMs: conv.followup_timeout_seconds * 1000,
        guardMs: conv.followup_guard_ms,
        keepListening: conv.keep_listening,
      },
      bargeIn: {
        enabled: conv.barge_in_enabled,
        minScore: conv.barge_in_min_score,
      },
      silenceThreshold: audio.silence_threshold,
      maxRecordMs: audio.max_record_seconds * 1000,
      vad: buildClientVadSettings(audio),
    },
  };
}
