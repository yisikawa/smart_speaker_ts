/**
 * フロントエンド / バックエンド共有プロトコル定義。
 *
 * このファイルは「型のみ」を公開する。フロントエンドは `import type` でのみ参照するため、
 * コンパイル後の JavaScript には実行時依存（require）が残らない。
 */

/** アシスタントの全体状態（UI のステータス表示と 1:1 で対応する） */
export type AssistantState =
  | "idle"
  | "waiting_wakeword"
  | "recording"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

/** 1 ターン分の会話メッセージ */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** epoch ミリ秒 */
  at: number;
}

/** 録音終了理由 */
export type CaptureEndReason =
  | "silence"
  | "no_speech"
  | "max_duration"
  | "aborted"
  | "device_error";

/** パイプライン → クライアントへ流れるイベント */
export type PipelineEvent =
  | { type: "state"; state: AssistantState }
  | { type: "wakeword_detected"; phrase: string }
  | { type: "recording_started" }
  | { type: "level"; level: number; threshold: number }
  | { type: "recording_stopped"; durationMs: number; reason: CaptureEndReason }
  | { type: "stt_started" }
  | { type: "stt_complete"; text: string; language: string; elapsedMs: number }
  | { type: "llm_started" }
  | { type: "llm_delta"; content: string }
  | { type: "llm_complete"; text: string; elapsedMs: number }
  | { type: "tts_started" }
  | { type: "tts_complete"; elapsedMs: number }
  | { type: "speaking_started" }
  | { type: "speaking_finished" }
  | { type: "barge_in" }
  | { type: "followup_wait"; turn: number; maxTurns: number; timeoutMs: number }
  | { type: "turn_complete"; turn: number }
  /** 認識結果を破棄した（幻聴・エコー・短すぎる断片など）。ターンは成立していない */
  | { type: "turn_skipped"; reason: string }
  | { type: "history_updated"; messages: ChatMessage[] }
  | { type: "error"; scope: string; message: string };

/** クライアント → サーバーへ送るコマンド */
export type ClientCommand =
  | { type: "start_listening" }
  | { type: "stop_listening" }
  | { type: "submit_text"; text: string }
  | { type: "submit_audio"; format: "wav"; sampleRate: number; data: string }
  | { type: "speak"; text: string }
  | { type: "stop_speaking" }
  | { type: "simulate_wakeword"; phrase?: string }
  | { type: "clear_history" }
  | { type: "get_state" }
  | { type: "ping" };

/** 依存サービス（LLM / TTS / STT）の疎通状態 */
export interface ServiceStatus {
  llm: boolean;
  tts: boolean;
  stt: boolean;
}

/** 音声入力の方式（browser: ブラウザのマイク / server: サーバーの ffmpeg） */
export type InputMode = "browser" | "server";

/** 接続直後に送られる初期化メッセージ */
export interface HelloPayload {
  type: "hello";
  state: AssistantState;
  history: ChatMessage[];
  character: { name: string; label: string };
  user: string;
  version: string;
  services: ServiceStatus;
  /** ブラウザ側の録音制御に必要な情報 */
  audio: {
    inputMode: InputMode;
    sampleRate: number;
    noSpeechTimeoutMs: number;
    followup: {
      enabled: boolean;
      maxTurns: number;
      timeoutMs: number;
      guardMs: number;
      /** 上限に達しても聞き取りを続けるか */
      keepListening: boolean;
    };
    bargeIn: { enabled: boolean; minScore: number };
    silenceThreshold: number;
    maxRecordMs: number;
    /** ブラウザの VAD に使う設定（サーバー側と同じアルゴリズム） */
    vad: {
      frameMs: number;
      preRollMs: number;
      silenceDurationMs: number;
      smoothingAlpha: number;
      relativeThresholdMultiplier: number;
      /** 相対しきい値の上限（環境音でしきい値が跳ね上がらないようにする） */
      maxSilenceThreshold: number;
      calibrationMs: number;
      debounceFrames: number;
      inputGain: number;
    };
  };
}

/** サーバー → クライアントへ流れるメッセージ */
export type ServerMessage =
  | HelloPayload
  | { type: "event"; event: PipelineEvent }
  | { type: "state"; state: AssistantState }
  | { type: "history"; messages: ChatMessage[] }
  | { type: "error"; message: string }
  | { type: "pong" };

/** GET /api/health のレスポンス */
export interface HealthReport {
  ok: boolean;
  version: string;
  uptimeSec: number;
  services: ServiceStatus;
  audioDevices: number;
  warnings: string[];
}
