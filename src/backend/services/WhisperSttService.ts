import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runProcess } from "../core/childProcess";
import { abortError } from "../core/errors";
import { BaseSttService, RecognizeResult } from "./BaseSttService";
import { joinSegments, WhisperSegment } from "./transcriptFilter";

/** whisper.cpp の `-ojf`（JSON full）出力のうち、こちらで使う部分 */
interface WhisperJson {
  transcription?: WhisperSegment[];
}

/**
 * whisper.cpp（main.exe）を子プロセスで呼び出す STT 実装。
 *
 * 注意: whisper.cpp の `-ng` は「GPU を無効化」するフラグである。
 * 旧実装は use_gpu=true のときに `-ng` を渡しており意味が逆だった。
 *
 * 無音・雑音に対する幻聴（「ご視聴ありがとうございました」等）対策として、
 * - `-sns`（非音声トークン抑制）
 * - `-mc 0`（文脈を引き継がない）
 * - `-nth`（無音判定しきい値）
 * - `-ojf` の no_speech_prob / avg_logprob による区間フィルタ
 * を併用する（テキスト側の幻聴判定は `BaseSttService` が行う）。
 */
export class WhisperSttService extends BaseSttService {
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
      "-ojf",
      "-of",
      outputBase,
      "-t",
      String(stt.threads),
      "-bs",
      String(stt.beam_size),
      "-mc",
      String(stt.max_context),
      "-nth",
      String(stt.no_speech_thold),
      stt.flash_attn ? "-fa" : "-nfa",
    ];
    if (stt.suppress_non_speech) {
      args.push("-sns");
    }
    if (!stt.use_gpu) {
      args.push("-ng");
    }
    if (stt.initial_prompt) {
      args.push("--prompt", stt.initial_prompt);
    }
    return args;
  }

  /** `-ojf` の JSON を読む（無ければ null） */
  private readJson(jsonPath: string): WhisperJson | null {
    if (!fs.existsSync(jsonPath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as WhisperJson;
    } catch {
      return null;
    }
  }

  protected async recognize(
    wav: Buffer,
    options: { signal?: AbortSignal }
  ): Promise<RecognizeResult> {
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

    try {
      await fs.promises.writeFile(inputPath, wav);
      const result = await runProcess(binary, this.buildArgs(inputPath, outputBase), {
        timeoutMs: stt.timeout_seconds * 1000,
        signal: options.signal,
      });

      if (result.aborted) {
        throw abortError("STT が中断されました");
      }
      if (result.timedOut) {
        throw new Error(`STT がタイムアウトしました（${stt.timeout_seconds} 秒）`);
      }
      if (result.code !== 0) {
        throw new Error(`whisper.cpp が異常終了しました (code=${result.code}): ${result.stderr.slice(0, 400)}`);
      }

      const textPath = `${outputBase}.txt`;
      const jsonPath = `${outputBase}.json`;
      let text = "";
      let droppedSegments = 0;

      const json = this.readJson(jsonPath);
      const segments = Array.isArray(json?.transcription) ? json.transcription : [];
      if (segments.length > 0) {
        const joined = joinSegments(segments, {
          noSpeechProb: stt.drop_no_speech_prob,
          avgLogprob: stt.drop_avg_logprob,
        });
        text = joined.text;
        droppedSegments = joined.dropped;
      } else if (fs.existsSync(textPath)) {
        text = (await fs.promises.readFile(textPath, "utf-8")).trim();
      }

      return {
        text,
        note: droppedSegments > 0 ? `低信頼の区間 ${droppedSegments} 件を破棄` : undefined,
      };
    } finally {
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
