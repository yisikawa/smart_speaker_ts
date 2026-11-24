import { spawn } from "child_process";
import { readWavInfo } from "../../shared/audio/pcm";

/**
 * WAV の正規化（口パク・再生の前提を揃える）。
 *
 * ブラウザ再生・サーバー再生は任意の WAV を鳴らせるが、口パクの
 * `buildVolumeEnvelope()` は **16bit PCM** しか解析できない。
 * マルチリンガル TTS は 24bit / 32bit float を返すことがあるため、
 * 再生前にここで 16bit PCM モノラルへ落とす（**サンプルレートはそのまま**。
 * 口パクは WAV のサンプルレートを使うので、40kHz でも正しく動く）。
 */

function toBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** 16bit PCM / モノラルの WAV か（そのまま口パクに使えるか） */
export function isPcm16MonoWav(buffer: Buffer): boolean {
  const info = readWavInfo(toBytes(buffer));
  return info !== null && info.bitsPerSample === 16 && info.channels === 1;
}

export interface NormalizeWavOptions {
  /** ffmpeg 実行パス（未指定なら PATH の ffmpeg） */
  ffmpegPath?: string;
  /** 変換タイムアウト（ms） */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 変換に失敗したときの通知（口パクが無効になるため、呼び出し側でログに出す） */
  onError?: (error: unknown) => void;
}

/**
 * 16bit PCM モノラルでなければ ffmpeg で変換する。
 * 変換に失敗した場合は元の Buffer を返す（無音にはせず、口パクだけ諦める）。
 * 失敗は `options.onError` で通知する（握りつぶすと原因が追えない）。
 */
export async function normalizeWav(
  wav: Buffer,
  options: NormalizeWavOptions = {}
): Promise<Buffer> {
  if (isPcm16MonoWav(wav)) {
    return wav;
  }
  // 中断済みなら ffmpeg を起動しない（起動すると ENOENT などが後から未処理例外で飛ぶ）
  if (options.signal?.aborted) {
    return wav;
  }
  try {
    return await convertWithFfmpeg(wav, options);
  } catch (error) {
    // 中断は呼び出し側の意図的な停止なので「変換失敗」として通知しない
    // （通知すると「口パクが無効になります」という誤警告になる）
    if (!options.signal?.aborted) {
      options.onError?.(error);
    }
    return wav;
  }
}

function convertWithFfmpeg(wav: Buffer, options: NormalizeWavOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const binary = options.ffmpegPath?.trim() || "ffmpeg";
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      // LIST メタデータを付けない（付くと readWavInfo の固定オフセット読みが崩れ、
      // durationMs が 1ms になって speaking が早く解除される）
      "-map_metadata",
      "-1",
      "-fflags",
      "+bitexact",
      "-flags:a",
      "+bitexact",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "pipe:1",
    ];
    const child = spawn(binary, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs ?? 20000;

    const finish = (error: Error | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      if (error) {
        reject(error);
      } else {
        resolve(Buffer.concat(chunks));
      }
    };

    const kill = (): void => {
      try {
        child.kill();
      } catch {
        // 既に終了している場合は無視
      }
    };

    const timer = setTimeout(() => {
      kill();
      finish(new Error(`ffmpeg による WAV 変換がタイムアウトしました（${timeoutMs}ms）`));
    }, timeoutMs);

    // 中断済みでも、後から届く spawn のエラーを取りこぼさないようリスナーは先に張る
    child.on("error", (error) => finish(error));

    const onAbort = (): void => {
      kill();
      finish(new Error("WAV 変換が中断されました"));
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort);
    }

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(`ffmpeg が異常終了しました (code=${code}): ${stderr.slice(0, 200)}`));
        return;
      }
      if (chunks.length === 0) {
        finish(new Error("ffmpeg の出力が空でした"));
        return;
      }
      finish(null);
    });

    child.stdin.on("error", () => {
      // ffmpeg 側が先に終了した場合の EPIPE は close で判定する
    });
    child.stdin.end(wav);
  });
}
