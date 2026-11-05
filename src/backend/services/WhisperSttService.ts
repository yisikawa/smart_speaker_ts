import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigManager } from "../config/ConfigManager";
import { runProcess } from "../core/childProcess";
import { Logger } from "../core/logger";
import { SpeechToText, Transcript } from "../core/ports";

/**
 * whisper.cpp（main.exe）を子プロセスで呼び出す STT 実装。
 *
 * 注意: whisper.cpp の `-ng` は「GPU を無効化」するフラグである。
 * 旧実装は use_gpu=true のときに `-ng` を渡しており意味が逆だった。
 */
export class WhisperSttService implements SpeechToText {
  private readonly logger: Logger;

  constructor(private readonly deps: { config: ConfigManager; logger?: Logger }) {
    this.logger = deps.logger ? deps.logger.child("STT") : new Logger("STT");
  }

  private binaryPath(): string {
    return this.deps.config.resolvePath(this.deps.config.getSTT().binary_path);
  }

  private modelPath(): string {
    return this.deps.config.resolvePath(this.deps.config.getSTT().model_path);
  }

  async isAvailable(): Promise<boolean> {
    return fs.existsSync(this.binaryPath()) && fs.existsSync(this.modelPath());
  }

  private buildArgs(inputPath: string, outputBase: string): string[] {
    const stt = this.deps.config.getSTT();
    const args = [
      "-m",
      this.modelPath(),
      "-f",
      inputPath,
      "-l",
      stt.language,
      "-otxt",
      "-of",
      outputBase,
      "-t",
      String(stt.threads),
      "-bs",
      String(stt.beam_size),
      stt.flash_attn ? "-fa" : "-nfa",
    ];
    if (!stt.use_gpu) {
      args.push("-ng");
    }
    if (stt.initial_prompt) {
      args.push("--prompt", stt.initial_prompt);
    }
    return args;
  }

  async transcribe(wav: Buffer, options: { signal?: AbortSignal } = {}): Promise<Transcript> {
    const stt = this.deps.config.getSTT();
    const binary = this.binaryPath();
    const model = this.modelPath();

    if (!fs.existsSync(binary)) {
      throw new Error(`whisper.cpp の実行ファイルが見つかりません: ${binary}`);
    }
    if (!fs.existsSync(model)) {
      throw new Error(`Whisper モデルが見つかりません: ${model}`);
    }

    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sumika-stt-"));
    const inputPath = path.join(workDir, "input.wav");
    const outputBase = path.join(workDir, "output");
    const started = Date.now();

    try {
      await fs.promises.writeFile(inputPath, wav);
      const result = await runProcess(binary, this.buildArgs(inputPath, outputBase), {
        timeoutMs: stt.timeout_seconds * 1000,
        signal: options.signal,
      });

      if (result.aborted) {
        const error = new Error("STT が中断されました");
        error.name = "AbortError";
        throw error;
      }
      if (result.timedOut) {
        throw new Error(`STT がタイムアウトしました（${stt.timeout_seconds} 秒）`);
      }
      if (result.code !== 0) {
        throw new Error(`whisper.cpp が異常終了しました (code=${result.code}): ${result.stderr.slice(0, 400)}`);
      }

      const textPath = `${outputBase}.txt`;
      const text = fs.existsSync(textPath) ? (await fs.promises.readFile(textPath, "utf-8")).trim() : "";
      const elapsedMs = Date.now() - started;
      this.logger.info(`認識完了 (${elapsedMs}ms): ${text || "(空)"}`);
      return { text, language: stt.language, elapsedMs };
    } finally {
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
