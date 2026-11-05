import type { CaptureEndReason } from "../../shared/protocol";
import { LlmMessage, LlmTool } from "./messages";

/* ------------------------------------------------------------------ */
/* Audio                                                               */
/* ------------------------------------------------------------------ */

export interface AudioDevice {
  name: string;
}

export interface VadSettings {
  sampleRate: number;
  frameMs: number;
  preRollMs: number;
  silenceThreshold: number;
  silenceDurationMs: number;
  smoothingAlpha: number;
  relativeThresholdMultiplier: number;
  calibrationMs: number;
  debounceFrames: number;
  inputGain: number;
}

export interface CaptureOptions {
  /** 1 発話の最大長（ms） */
  maxDurationMs: number;
  /** 発話開始までの待ち（ms）。未指定なら待ち続ける */
  startTimeoutMs?: number;
  /** 無音継続で発話終了と判定する時間（ms） */
  silenceDurationMs?: number;
  /** しきい値の明示指定（バージイン用） */
  threshold?: number;
  /** レベル通知（メーター表示・バージイン判定用） */
  onLevel?: (level: number, threshold: number) => void;
  /** 発話開始を検知した瞬間の通知（再生停止に使う） */
  onSpeechStart?: () => void;
  signal?: AbortSignal;
}

export interface CaptureResult {
  /** 16kHz / 16bit / モノラルの PCM */
  pcm: Buffer;
  /** PCM に WAV ヘッダを付けたもの（STT へ渡す） */
  wav: Buffer;
  durationMs: number;
  hasSpeech: boolean;
  reason: CaptureEndReason;
}

export interface CaptureHandle {
  /** 録音完了時に解決する */
  result: Promise<CaptureResult>;
  /** 録音を中断する（result は終了理由 aborted で解決する） */
  stop(reason?: CaptureEndReason): void;
}

export interface PlaybackHandle {
  /** 再生完了時に解決する（stop でも解決する） */
  finished: Promise<void>;
  stop(): void;
}

export interface AudioIO {
  listInputDevices(): Promise<AudioDevice[]>;
  capture(options: CaptureOptions): CaptureHandle;
  play(wav: Buffer): PlaybackHandle;
  dispose(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Speech to text                                                      */
/* ------------------------------------------------------------------ */

export interface Transcript {
  text: string;
  language: string;
  elapsedMs: number;
}

export interface SpeechToText {
  isAvailable(): Promise<boolean>;
  transcribe(wav: Buffer, options?: { signal?: AbortSignal }): Promise<Transcript>;
}

/* ------------------------------------------------------------------ */
/* Language model                                                      */
/* ------------------------------------------------------------------ */

export interface ChatOptions {
  signal?: AbortSignal;
  temperature?: number;
  tools?: LlmTool[];
}

export interface LanguageModel {
  isAvailable(): Promise<boolean>;
  listModels(): Promise<string[]>;
  /** ストリーミング応答。差分ごとに onDelta を呼び、最終的な全文を返す */
  chatStream(
    messages: LlmMessage[],
    onDelta: (chunk: string) => void,
    options?: ChatOptions
  ): Promise<string>;
}

/* ------------------------------------------------------------------ */
/* Text to speech                                                      */
/* ------------------------------------------------------------------ */

export interface TtsSpeaker {
  name: string;
  styles: { name: string; id: number }[];
}

export interface TtsOptions {
  speakerId?: number;
  signal?: AbortSignal;
}

export interface TextToSpeech {
  isAvailable(): Promise<boolean>;
  listSpeakers(): Promise<TtsSpeaker[]>;
  /** テキストから WAV バイナリを生成する */
  synthesize(text: string, options?: TtsOptions): Promise<Buffer>;
}
