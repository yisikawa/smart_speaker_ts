import { randomUUID } from "node:crypto";
import { buildVolumeEnvelope } from "../../shared/audio/envelope";
import { Logger } from "../core/logger";
import type { PlaybackMeta, TextToSpeech } from "../core/ports";
import { wavDurationMs } from "../services/wav";

export interface SpeechQueueDeps {
  tts: TextToSpeech;
  logger: Logger;
  signal: AbortSignal;
  /** WAV にヘッダが無い場合のサンプリングレート */
  sampleRate: number;
  /** 先読みする文数（1 推奨） */
  prefetchDepth: number;
  /** 1 文を鳴らす。バージイン発話があれば WAV を返す */
  play(wav: Buffer, meta: PlaybackMeta): Promise<Buffer | undefined>;
  /** 合成を始めた文（ログ・表示用） */
  onSentence?(text: string): void;
}

export interface SpeechQueueResult {
  played: number;
  failed: number;
  bargeWav?: Buffer;
}

interface Item {
  text: string;
  expression?: string;
  promise?: Promise<Buffer | null>;
}

/**
 * 文単位の音声合成と再生。
 *
 * - `enqueue` された順に 1 文ずつ再生する（順序保証）
 * - 再生中に次の 1 文を先読みして、文の間で止まらないようにする
 * - 1 文の合成失敗は警告して残りを続ける
 * - `stop()` / `AbortSignal` で即座に止め、`drain()` は必ず解決する
 */
export class SpeechQueue {
  private readonly items: Item[] = [];
  private running = false;
  private stopped = false;
  private played = 0;
  private failed = 0;
  private bargeWav: Buffer | undefined;
  private readonly idleWaiters: (() => void)[] = [];

  constructor(private readonly deps: SpeechQueueDeps) {}

  enqueue(text: string, expression?: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.stopped || this.deps.signal.aborted) {
      return;
    }
    this.items.push({ text: trimmed, expression });
    void this.run();
  }

  /** すべて再生し終わるまで待つ（中断・失敗でも必ず解決する） */
  async drain(): Promise<SpeechQueueResult> {
    if (!this.running && this.items.length === 0) {
      return this.result();
    }
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    return this.result();
  }

  stop(): void {
    this.stopped = true;
    this.items.length = 0;
    this.notifyIdle();
  }

  private result(): SpeechQueueResult {
    return { played: this.played, failed: this.failed, bargeWav: this.bargeWav };
  }

  private notifyIdle(): void {
    if (this.running) {
      return;
    }
    for (const resolve of this.idleWaiters.splice(0)) {
      resolve();
    }
  }

  private async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (!this.stopped && !this.deps.signal.aborted && this.items.length > 0) {
        const item = this.items[0];
        const wav = await this.synthesize(item);
        if (this.stopped || this.deps.signal.aborted) {
          return;
        }
        if (!wav) {
          this.items.shift();
          this.failed += 1;
          continue;
        }

        // 再生を待つ間に次の文を合成しておく
        for (let i = 1; i <= this.deps.prefetchDepth && i < this.items.length; i += 1) {
          void this.synthesize(this.items[i]);
        }

        this.items.shift();
        const barge = await this.deps.play(wav, this.meta(wav, item.text, item.expression));
        if (this.stopped) {
          return;
        }
        this.played += 1;
        if (barge) {
          this.bargeWav = barge;
          this.stopped = true;
          return;
        }
      }
    } finally {
      this.running = false;
      if (!this.stopped && this.items.length > 0) {
        void this.run();
      }
      this.notifyIdle();
    }
  }

  private synthesize(item: Item): Promise<Buffer | null> {
    if (!item.promise) {
      this.deps.onSentence?.(item.text);
      item.promise = this.deps.tts.synthesize(item.text, { signal: this.deps.signal }).catch((error) => {
        this.deps.logger.warn(`文の音声合成に失敗しました: ${item.text}`, error);
        return null;
      });
    }
    return item.promise;
  }

  private meta(wav: Buffer, text: string, expression?: string): PlaybackMeta {
    return {
      utteranceId: randomUUID(),
      text,
      expression,
      volumes: buildVolumeEnvelope(wav),
      sliceMs: 20,
      durationMs: wavDurationMs(wav, this.deps.sampleRate),
    };
  }
}
