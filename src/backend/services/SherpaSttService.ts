import * as fs from "fs";
import * as path from "path";
import { ConfigManager } from "../config/ConfigManager";
import { abortError } from "../core/errors";
import { Logger } from "../core/logger";
import { SpeechToText, Transcript } from "../core/ports";
import { bytesToInt16, int16ToFloat32, isWav, resample, wavToFloat32 } from "../../shared/audio/pcm";
import { isHallucination } from "./transcriptFilter";

/* ------------------------------------------------------------------ */
/* sherpa-onnx-node（node-addon-api）の最小型定義                        */
/* 型定義パッケージが無いため、必要な API だけを宣言する               */
/* ------------------------------------------------------------------ */

interface SherpaStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}

interface SherpaResult {
  text?: string;
}

interface SherpaRecognizer {
  createStream(): SherpaStream;
  decode(stream: SherpaStream): void;
  getResult(stream: SherpaStream): SherpaResult;
}

interface SherpaModule {
  OfflineRecognizer: new (config: Record<string, unknown>) => SherpaRecognizer;
}

/** sherpa-onnx が前提とするサンプリングレート */
const SHERPA_SAMPLE_RATE = 16000;

/** Float32 サンプル（-1..1）の RMS を返す */
function rmsOfFloat32(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * sherpa-onnx（ONNX Runtime）による STT 実装。
 *
 * whisper.cpp と違い **CTC / TDT 系の非自己回帰モデル**を扱えるため、
 * 無音に対する定型句の幻聴（「ご視聴ありがとうございました」等）が構造的に起きない。
 * モデルは `scripts/setup-sherpa.ps1` で取得する（既定は日本語 Parakeet 0.6B int8）。
 *
 * - ネイティブモジュール（sherpa-onnx-node）は必要になった時点で読み込む
 *   （未インストールでもアプリ起動・他エンジンの利用に影響しない）
 * - モデルのロードは初回の transcribe まで遅延する（起動を速く保つ）
 */
export class SherpaSttService implements SpeechToText {
  private readonly logger: Logger;
  private recognizer: SherpaRecognizer | null = null;
  private module: SherpaModule | null = null;
  private loadError: Error | null = null;

  constructor(private readonly deps: { config: ConfigManager; logger?: Logger }) {
    this.logger = deps.logger ? deps.logger.child("STT") : new Logger("STT");
  }

  private modelDir(): string {
    return this.deps.config.resolvePath(this.deps.config.getSTT().sherpa_model_dir);
  }

  /** ディレクトリ内で最初に一致したファイルを返す */
  private findFile(dir: string, patterns: RegExp[]): string | null {
    if (!fs.existsSync(dir)) {
      return null;
    }
    const entries = fs.readdirSync(dir);
    for (const pattern of patterns) {
      const hit = entries.find((name) => pattern.test(name));
      if (hit) {
        return path.join(dir, hit);
      }
    }
    return null;
  }

  /** モデル一式（tokens.txt と必要な ONNX）がそろっているか */
  private modelFiles(): {
    tokens: string;
    encoder: string | null;
    decoder: string | null;
    joiner: string | null;
    model: string | null;
  } | null {
    const dir = this.modelDir();
    const tokens = this.findFile(dir, [/^tokens\.txt$/i]);
    if (!tokens) {
      return null;
    }
    return {
      tokens,
      encoder: this.findFile(dir, [/^encoder.*\.onnx$/i]),
      decoder: this.findFile(dir, [/^decoder.*\.onnx$/i]),
      joiner: this.findFile(dir, [/^joiner.*\.onnx$/i]),
      model: this.findFile(dir, [/^model.*\.onnx$/i, /\.onnx$/i]),
    };
  }

  /** ネイティブモジュールを読み込む（1 回だけ。失敗はキャッシュする） */
  private loadModule(): SherpaModule {
    if (this.module) {
      return this.module;
    }
    if (this.loadError) {
      throw this.loadError;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.module = require("sherpa-onnx-node") as SherpaModule;
      return this.module;
    } catch (error) {
      this.loadError = new Error(
        "sherpa-onnx-node を読み込めません。`npm install sherpa-onnx-node` を実行してください: " +
          (error instanceof Error ? error.message : String(error))
      );
      throw this.loadError;
    }
  }

  /** 設定から recognizer を組み立てる（モデル種別ごとに構成が異なる） */
  private buildRecognizer(): SherpaRecognizer {
    const stt = this.deps.config.getSTT();
    const files = this.modelFiles();
    if (!files) {
      throw new Error(
        `sherpa-onnx のモデルが見つかりません（tokens.txt が無い）: ${this.modelDir()}。` +
          "`scripts/setup-sherpa.ps1` を実行してください。"
      );
    }

    const sherpa = this.loadModule();
    const modelConfig: Record<string, unknown> = {
      tokens: files.tokens,
      modelType: stt.sherpa_model_type,
      numThreads: stt.threads,
      provider: stt.sherpa_provider || "cpu",
      debug: 0,
    };

    if (stt.sherpa_model_type === "sense_voice") {
      if (!files.model) {
        throw new Error(`SenseVoice のモデル（model*.onnx）が見つかりません: ${this.modelDir()}`);
      }
      modelConfig.senseVoice = {
        model: files.model,
        language: stt.sherpa_language || "auto",
        useItn: true,
      };
    } else if (stt.sherpa_model_type === "nemo_ctc") {
      if (!files.model) {
        throw new Error(`NeMo CTC のモデル（model*.onnx）が見つかりません: ${this.modelDir()}`);
      }
      modelConfig.nemoCtc = { model: files.model };
    } else {
      if (!files.encoder || !files.decoder || !files.joiner) {
        throw new Error(
          `transducer モデル一式（encoder / decoder / joiner の .onnx）が見つかりません: ${this.modelDir()}`
        );
      }
      modelConfig.transducer = {
        encoder: files.encoder,
        decoder: files.decoder,
        joiner: files.joiner,
      };
    }

    const recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SHERPA_SAMPLE_RATE, featureDim: 80 },
      modelConfig,
    });
    this.logger.info(
      `sherpa-onnx を読み込みました: ${this.modelDir()} (${stt.sherpa_model_type})`
    );
    return recognizer;
  }

  private ensureRecognizer(): SherpaRecognizer {
    if (!this.recognizer) {
      this.recognizer = this.buildRecognizer();
    }
    return this.recognizer;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.modelFiles()) {
      return false;
    }
    try {
      this.loadModule();
      return true;
    } catch {
      return false;
    }
  }

  /** 16kHz 以外は線形補間でリサンプリングする（sherpa-onnx の前提に合わせる） */
  private resampleIfNeeded(
    samples: Float32Array,
    sampleRate: number
  ): { samples: Float32Array; sampleRate: number } {
    if (sampleRate === SHERPA_SAMPLE_RATE) {
      return { samples, sampleRate };
    }
    const asInt16 = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const value = Math.round(samples[i] * 32768);
      asInt16[i] = value > 32767 ? 32767 : value < -32768 ? -32768 : value;
    }
    const converted = resample(asInt16, sampleRate, SHERPA_SAMPLE_RATE);
    return { samples: int16ToFloat32(converted), sampleRate: SHERPA_SAMPLE_RATE };
  }

  /** WAV（または 16bit PCM）を sherpa-onnx の入力形式へ変換する */
  private toInput(wav: Buffer): { samples: Float32Array; sampleRate: number } {
    const bytes = new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength);
    if (isWav(bytes)) {
      const decoded = wavToFloat32(bytes);
      if (decoded) {
        return this.resampleIfNeeded(decoded.samples, decoded.sampleRate);
      }
    }
    // WAV ヘッダが無い場合は 16kHz / モノラル / 16bit として扱う
    return this.resampleIfNeeded(int16ToFloat32(bytesToInt16(bytes)), SHERPA_SAMPLE_RATE);
  }

  async transcribe(wav: Buffer, options: { signal?: AbortSignal } = {}): Promise<Transcript> {
    const stt = this.deps.config.getSTT();
    if (options.signal?.aborted) {
      throw abortError("STT が中断されました");
    }

    const started = Date.now();
    const input = this.toInput(wav);

    // ほぼ無音の入力は認識させない（CTC 系でも短い誤認識が出るため）
    if (stt.min_input_rms > 0) {
      const rms = rmsOfFloat32(input.samples);
      if (rms < stt.min_input_rms) {
        const elapsedMs = Date.now() - started;
        this.logger.info(`入力がほぼ無音のため認識をスキップしました (rms=${rms.toFixed(4)}, ${elapsedMs}ms)`);
        return { text: "", language: stt.sherpa_language || stt.language, elapsedMs };
      }
    }

    const recognizer = this.ensureRecognizer();

    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: input.sampleRate, samples: input.samples });
    recognizer.decode(stream);

    if (options.signal?.aborted) {
      throw abortError("STT が中断されました");
    }

    const result = recognizer.getResult(stream);
    let text = (result?.text ?? "").trim();
    if (text && stt.filter_hallucinations && isHallucination(text)) {
      this.logger.warn(`幻聴と判定したため破棄します: ${text}`);
      text = "";
    }

    const elapsedMs = Date.now() - started;
    this.logger.info(`認識完了 (${elapsedMs}ms): ${text || "(空)"}`);
    return { text, language: stt.sherpa_language || stt.language, elapsedMs };
  }
}
