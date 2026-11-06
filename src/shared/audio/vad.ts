import type { CaptureEndReason } from "../protocol";
import { concatInt16, rmsLevel } from "./pcm";

export type VadDecision =
  | { kind: "continue" }
  | { kind: "speech_start" }
  | { kind: "finish"; reason: CaptureEndReason };

/** 数値配列の中央値（空なら 0） */
function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
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
  /**
   * 相対しきい値の上限（0..1）。
   * タイピング・物音・空調などの環境音で暗騒音が膨らんでも、
   * しきい値がこれを超えて跳ね上がらないようにする（未指定なら上限なし）。
   */
  maxSilenceThreshold?: number;
}

export interface VadOptions {
  /** 1 発話の最大長（ms） */
  maxDurationMs: number;
  /** 発話開始までの待ち（ms）。未指定なら待ち続ける */
  startTimeoutMs?: number;
  silenceDurationMs?: number;
  threshold?: number;
}

/**
 * フレーム単位の VAD（発話区間検出）。
 *
 * ブラウザ・Node の双方で動く純粋ロジック。1 フレーム = frameMs 分の Int16 PCM。
 */
export class VadEngine {
  private readonly sampleRate: number;
  private readonly frameMs: number;
  private readonly silenceDurationMs: number;
  private readonly preRollFrames: number;
  private readonly calibrationFrames: number;
  private readonly debounceFrames: number;
  private readonly startTimeoutMs?: number;
  private readonly maxDurationMs: number;
  private readonly baseThreshold: number;

  private thresholdValue: number;
  private noiseFloor = 0;
  private smoothed = 0;
  private calibrationFrame = 0;
  /** 較正期間のレベル（中央値で暗騒音を見積もる） */
  private readonly calibrationLevels: number[] = [];
  private speechFrames = 0;
  private silenceFrames = 0;
  private elapsed = 0;
  private speechStarted = false;
  private done = false;
  private finishReason: CaptureEndReason | null = null;
  private receivedFrames = 0;
  private maxLevel = 0;

  private readonly collected: Int16Array[] = [];
  private readonly preRoll: Int16Array[] = [];

  constructor(
    private readonly settings: VadSettings,
    options: VadOptions
  ) {
    this.sampleRate = settings.sampleRate;
    this.frameMs = settings.frameMs;
    this.silenceDurationMs = options.silenceDurationMs ?? settings.silenceDurationMs;
    this.preRollFrames = Math.max(0, Math.ceil(settings.preRollMs / settings.frameMs));
    this.calibrationFrames = Math.max(0, Math.ceil(settings.calibrationMs / settings.frameMs));
    this.debounceFrames = Math.max(1, settings.debounceFrames);
    this.startTimeoutMs = options.startTimeoutMs;
    this.maxDurationMs = options.maxDurationMs;
    this.baseThreshold = options.threshold ?? settings.silenceThreshold;
    this.thresholdValue = this.baseThreshold;
  }

  /** 平滑化後のレベル（0..1） */
  get level(): number {
    return this.smoothed;
  }

  /** 現在のしきい値（0..1） */
  get threshold(): number {
    return this.thresholdValue;
  }

  get hasSpeech(): boolean {
    return this.speechStarted;
  }

  get elapsedMs(): number {
    return this.elapsed;
  }

  /** 受信したフレーム数（0 はデバイスから音声が来ていない） */
  get frames(): number {
    return this.receivedFrames;
  }

  /** 観測した最大レベル（0..1） */
  get peakLevel(): number {
    return this.maxLevel;
  }

  /** 1 フレーム分のサンプル数 */
  get frameSamples(): number {
    return Math.max(1, Math.round((this.sampleRate * this.frameMs) / 1000));
  }

  /** フレーム長（ms） */
  get frameMsValue(): number {
    return this.frameMs;
  }

  /** 1 フレーム（frameSamples 分の 16bit PCM）を入力し、判定結果を返す */
  push(frame: Int16Array): VadDecision {
    if (this.done) {
      return { kind: "finish", reason: this.finishReason ?? "aborted" };
    }

    this.elapsed += this.frameMs;
    const level = rmsLevel(frame, this.settings.inputGain);
    const alpha = this.settings.smoothingAlpha;
    this.smoothed = alpha * level + (1 - alpha) * this.smoothed;
    this.receivedFrames += 1;
    this.maxLevel = Math.max(this.maxLevel, level);

    // 起動直後は暗騒音を測定し、相対しきい値を決める（この間は発話判定しない）。
    // - 中央値を使い、タイピング等の一発ノイズに引きずられないようにする
    // - しきい値より十分大きい音は「環境音ではなく発話・物音」とみなして学習から除外する
    //   （話し始めてからマイクが開いても、しきい値が発話レベルまで跳ね上がらない）
    if (this.calibrationFrame < this.calibrationFrames) {
      this.calibrationFrame += 1;
      if (this.smoothed <= this.baseThreshold * 1.5) {
        this.calibrationLevels.push(this.smoothed);
      }
      this.noiseFloor = median(this.calibrationLevels);
      this.updateThreshold();
      this.pushPreRoll(frame);
      return this.checkTimeout();
    }

    this.updateThreshold();

    if (!this.speechStarted) {
      this.speechFrames = this.smoothed > this.thresholdValue ? this.speechFrames + 1 : 0;
      if (this.speechFrames >= this.debounceFrames) {
        this.speechStarted = true;
        for (const buffered of this.preRoll) {
          this.collected.push(buffered);
        }
        this.preRoll.length = 0;
        this.collected.push(frame);
        this.silenceFrames = 0;
        const timeout = this.checkTimeout();
        return timeout.kind === "finish" ? timeout : { kind: "speech_start" };
      }
      this.pushPreRoll(frame);
      return this.checkTimeout();
    }

    this.collected.push(frame);
    this.silenceFrames = this.smoothed < this.thresholdValue ? this.silenceFrames + 1 : 0;

    if (this.silenceFrames * this.frameMs >= this.silenceDurationMs) {
      return this.finish("silence");
    }
    return this.checkTimeout();
  }

  /** 収集済み PCM（プリロール + 発話区間） */
  collectedPcm(): Int16Array {
    return concatInt16(this.collected);
  }

  /** 外部要因（中断・デバイスエラー）で終了させる */
  finish(reason: CaptureEndReason): VadDecision {
    if (!this.done) {
      this.done = true;
      this.finishReason = reason;
    }
    return { kind: "finish", reason: this.finishReason ?? reason };
  }

  private updateThreshold(): void {
    // 相対しきい値（暗騒音 × 倍率）には上限を設ける。
    // 環境音で暗騒音が大きい場合でも、しきい値が発話レベルを超えて跳ね上がらないようにする。
    const cap = this.settings.maxSilenceThreshold ?? Number.POSITIVE_INFINITY;
    const relative = this.noiseFloor * this.settings.relativeThresholdMultiplier;
    this.thresholdValue = Math.max(this.baseThreshold, Math.min(cap, relative));
  }

  private checkTimeout(): VadDecision {
    if (this.elapsed >= this.maxDurationMs) {
      return this.finish("max_duration");
    }
    if (!this.speechStarted && this.startTimeoutMs !== undefined && this.elapsed >= this.startTimeoutMs) {
      return this.finish("no_speech");
    }
    return { kind: "continue" };
  }

  private pushPreRoll(frame: Int16Array): void {
    if (this.preRollFrames === 0) {
      return;
    }
    this.preRoll.push(frame);
    while (this.preRoll.length > this.preRollFrames) {
      this.preRoll.shift();
    }
  }
}
