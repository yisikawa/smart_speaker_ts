import type { CaptureEndReason } from "../../shared/protocol";
import { LlmMessage, LlmTool } from "./messages";

/* ------------------------------------------------------------------ */
/* Audio                                                               */
/* ------------------------------------------------------------------ */

export interface AudioDevice {
  name: string;
}

// VAD の設定・実装はブラウザと共有する（src/shared/audio/vad.ts）
export type { VadSettings, VadOptions } from "../../shared/audio/vad";

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
  /** 受信したフレーム数（0 ならデバイスから音声が来ていない） */
  frames?: number;
  /** 観測した最大レベル（0..1） */
  peakLevel?: number;
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

/** 1 文ぶんの読み上げ情報（クライアントの再生・口パクに使う） */
export interface PlaybackMeta {
  /** 発話単位の一意 ID（`audio_playback_done` と突き合わせる） */
  utteranceId: string;
  /** 表示用テキスト（感情タグは除去済み） */
  text: string;
  /** この文で発火する表情（モデルの表情名。無ければ undefined） */
  expression?: string;
  /** スライスごとの 0..1（口パク用）。サーバー再生では未使用 */
  volumes: number[];
  sliceMs: number;
  durationMs: number;
}

/**
 * 読み上げの出力先（サーバーの ffplay / ブラウザの WebAudio）。
 * `PlaybackRouter` が設定に応じて実装を選ぶ。
 */
export interface PlaybackSink {
  readonly kind: "server" | "browser";
  /** いま使えるか（クライアント未接続なら false） */
  isAvailable(): boolean;
  play(wav: Buffer, meta: PlaybackMeta): PlaybackHandle;
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
  /**
   * 設定変更を反映する（実行中に実装を差し替えられる場合のみ実装する）。
   * 再生成したら true。既定の実装は持たない（任意メソッド）。
   */
  reconfigure?(): boolean;
  /** 現在の構成の表示名（任意。hello の表示に使う） */
  describe?(): string;
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
  /**
   * モデルを事前に読み込む（任意）。切り替え直後の初回リクエストが
   * 読み込み待ちでタイムアウトしないようにする。戻り値は所要ミリ秒。
   */
  prepare?(model?: string): Promise<number>;
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
  /** 現在の構成の表示名（任意。hello の表示に使う） */
  describe?(): string;
}
