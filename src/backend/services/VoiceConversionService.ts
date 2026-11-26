import { ConfigManager } from "../config/ConfigManager";
import { Logger } from "../core/logger";
import { isWav } from "./wav";

export interface VoiceConversionOptions {
  signal?: AbortSignal;
  /** 変換に失敗したときの通知（呼び出し側でログに出す） */
  onError?: (error: unknown) => void;
}

/**
 * RVC（声質変換）の常駐ワーカーへ WAV を送る。
 *
 * - `tts.voice_conversion.enabled` が false、または endpoint が未設定なら**何もせず素通し**する
 * - 変換条件（`index_rate` / `pitch` / `f0_method` / モデル）は**すべて設定から渡す**
 *   （ワーカー側にハードコードしない。ワーカーはモデルのロードと推論だけを担う）
 * - 失敗時は**元の WAV を返す**（無音にしない。`normalizeWav` と同じ方針）
 */
export class VoiceConversionService {
  private readonly logger: Logger;
  /** 設定不備の警告は 1 回だけ出す（毎文で同じ警告を出さない） */
  private warnedUnavailable = false;

  constructor(
    private readonly deps: {
      config: ConfigManager;
      logger?: Logger;
      /** テストで差し替える（既定はグローバルの fetch） */
      fetchImpl?: typeof fetch;
    }
  ) {
    this.logger = deps.logger ?? new Logger("RVC");
  }

  /** 変換が有効か（設定上 enabled で endpoint もある） */
  get isEnabled(): boolean {
    const cfg = this.deps.config.getTTS().voice_conversion;
    return cfg.enabled && Boolean(cfg.endpoint.trim());
  }

  async convert(wav: Buffer, options: VoiceConversionOptions = {}): Promise<Buffer> {
    const cfg = this.deps.config.getTTS().voice_conversion;
    if (!cfg.enabled) {
      return wav;
    }
    if (!cfg.endpoint.trim()) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.logger.warn("tts.voice_conversion.endpoint が未設定のため声質変換をスキップします");
      }
      return wav;
    }
    if (!cfg.model_path.trim()) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.logger.warn("tts.voice_conversion.model_path が未設定のため声質変換をスキップします");
      }
      return wav;
    }

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const timeoutMs = Math.max(1000, cfg.timeout_seconds * 1000);
    const signal = options.signal ?? AbortSignal.timeout(timeoutMs);

    try {
      const response = await fetchImpl(`${cfg.endpoint.replace(/\/+$/, "")}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wav_base64: wav.toString("base64"),
          pitch: cfg.pitch,
          f0_method: cfg.f0_method,
          index_rate: cfg.index_rate,
          model: this.deps.config.resolvePath(cfg.model_path),
          index: this.deps.config.resolvePath(cfg.index_path),
        }),
        signal,
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 160);
        throw new Error(`/convert が ${response.status} を返しました: ${detail}`);
      }
      const payload = (await response.json()) as { wav_base64?: string };
      if (!payload.wav_base64) {
        throw new Error("/convert の応答に wav_base64 がありません");
      }
      const converted = Buffer.from(payload.wav_base64, "base64");
      if (!isWav(converted)) {
        throw new Error("変換後の音声が WAV ではありません");
      }
      // RVC の出力（40kHz/16bit/mono）をそのまま返す。
      // 口パク（buildVolumeEnvelope）は WAV のサンプルレートを使うため、16kHz へ落とす必要はない
      return converted;
    } catch (error) {
      if (options.signal?.aborted) {
        return wav;
      }
      this.logger.warn("声質変換に失敗したため元の音声で再生します", error);
      options.onError?.(error);
      return wav;
    }
  }
}
