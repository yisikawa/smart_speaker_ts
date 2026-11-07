import * as path from "path";
import type { SttEngineName } from "../../shared/protocol";
import { ConfigManager } from "../config/ConfigManager";
import { Logger } from "../core/logger";
import { SpeechToText, Transcript } from "../core/ports";
import { createSttService } from "./sttFactory";

/**
 * 実装の作り直しが必要になる設定キー。
 *
 * `WhisperSttService` は毎回 `config.getSTT()` を読むためモデル差し替えは再生成不要だが、
 * `SherpaSttService` は recognizer をキャッシュするので**再生成しないと設定が反映されない**。
 * 判断を単純にするため、関連キーが変わったら一律で作り直す。
 */
const SIGNATURE_KEYS = [
  "engine",
  "model_path",
  "binary_path",
  "use_gpu",
  "threads",
  "sherpa_model_dir",
  "sherpa_model_type",
  "sherpa_provider",
  "sherpa_language",
] as const;

export interface SttSwitcherDeps {
  config: ConfigManager;
  logger?: Logger;
  /** 実装の生成（既定は `createSttService`）。テストで差し替える */
  create?: (deps: { config: ConfigManager; logger?: Logger }) => SpeechToText;
}

/**
 * 実行中に STT 実装を差し替えられるファサード。
 *
 * - 配線（`ConversationPipeline` / `ServiceMonitor`）はこの 1 個を共有する
 * - `reconfigure()` は「エンジンと関連設定の署名」が変わったときだけ作り直す
 * - `transcribe()` は呼び出し開始時の実装を捕捉するので、切替で進行中の認識を壊さない
 */
export class SttSwitcher implements SpeechToText {
  private readonly logger: Logger;
  private readonly factory: NonNullable<SttSwitcherDeps["create"]>;
  private current: SpeechToText;
  private signature: string;

  constructor(private readonly deps: SttSwitcherDeps) {
    this.logger = deps.logger ?? new Logger("STT");
    this.factory = deps.create ?? createSttService;
    this.signature = this.currentSignature();
    this.current = this.build();
  }

  /** 現在のエンジン（表示用） */
  get engine(): SttEngineName {
    return this.deps.config.getSTT().engine;
  }

  /** 設定変更を反映する。実装を作り直したら true */
  reconfigure(): boolean {
    const next = this.currentSignature();
    if (next === this.signature) {
      return false;
    }
    this.signature = next;
    this.current = this.build();
    this.logger.info(`STT を再構成しました: ${this.describe()}`);
    return true;
  }

  isAvailable(): Promise<boolean> {
    return this.current.isAvailable();
  }

  /** 呼び出し開始時の実装を捕捉する（切替中でも現在の認識を完遂させる） */
  transcribe(wav: Buffer, options: { signal?: AbortSignal } = {}): Promise<Transcript> {
    const impl = this.current;
    return impl.transcribe(wav, options);
  }

  /** 表示用の説明（例: `sherpa-onnx / sherpa-onnx-... (nemo_ctc)`） */
  describe(): string {
    const stt = this.deps.config.getSTT();
    if (stt.engine === "sherpa") {
      return `sherpa-onnx / ${path.basename(stt.sherpa_model_dir) || "未設定"} (${stt.sherpa_model_type})`;
    }
    return `whisper.cpp / ${path.basename(stt.model_path) || "未設定"}`;
  }

  private build(): SpeechToText {
    return this.factory({ config: this.deps.config, logger: this.logger });
  }

  private currentSignature(): string {
    const stt = this.deps.config.getSTT() as unknown as Record<string, unknown>;
    return JSON.stringify(SIGNATURE_KEYS.map((key) => [key, stt[key]]));
  }
}
