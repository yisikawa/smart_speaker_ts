import type { ServiceStatus } from "../../shared/protocol";
import { Logger } from "../core/logger";
import { LanguageModel, SpeechToText, TextToSpeech } from "../core/ports";

export interface ServiceMonitorDeps {
  llm: LanguageModel;
  tts: TextToSpeech;
  stt: SpeechToText;
  logger?: Logger;
  /** 定期確認の間隔（ms、既定 30000） */
  intervalMs?: number;
}

/** 失敗しても false を返す（疎通確認で例外を投げない） */
async function isAvailable(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

/**
 * 依存サービス（LLM / TTS / STT）の疎通状態を保持し、定期的に更新する。
 *
 * `/api/health`（都度確認）と WebSocket の hello（保持値）が同じ判定を共有できるよう、
 * 確認処理を 1 箇所にまとめている。
 */
export class ServiceMonitor {
  private status: ServiceStatus = { llm: false, tts: false, stt: false };
  private timer: NodeJS.Timeout | null = null;
  private readonly logger: Logger;

  constructor(private readonly deps: ServiceMonitorDeps) {
    this.logger = deps.logger ?? new Logger("Services");
  }

  /** 直近の確認結果 */
  get current(): ServiceStatus {
    return this.status;
  }

  /** 今すぐ確認する（`/api/health` はこちらを使う） */
  async refresh(): Promise<ServiceStatus> {
    const [llm, tts, stt] = await Promise.all([
      isAvailable(() => this.deps.llm.isAvailable()),
      isAvailable(() => this.deps.tts.isAvailable()),
      isAvailable(() => this.deps.stt.isAvailable()),
    ]);
    this.status = { llm, tts, stt };
    return this.status;
  }

  /** 定期確認を開始する（起動時に 1 回確認してから一定間隔で更新） */
  start(): void {
    if (this.timer) {
      return;
    }
    void this.refresh().catch((error) => this.logger.warn("疎通確認に失敗しました", error));
    this.timer = setInterval(() => {
      void this.refresh().catch((error) => this.logger.warn("疎通確認に失敗しました", error));
    }, this.deps.intervalMs ?? 30000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
