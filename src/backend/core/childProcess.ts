import { spawn } from "child_process";

export interface RunProcessOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  windowsHide?: boolean;
}

export interface RunProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * 子プロセスを実行し、終了まで待つ。
 * タイムアウト／中断時はプロセスを kill し、結果にその旨を残す（reject しない）。
 */
export function runProcess(
  binary: string,
  args: string[],
  options: RunProcessOptions = {}
): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: options.windowsHide ?? true });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      if (options.signal && onAbort) {
        options.signal.removeEventListener("abort", onAbort);
      }
    };

    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ code, stdout, stderr, timedOut, aborted });
    };

    const kill = (): void => {
      try {
        child.kill();
      } catch {
        // 既に終了している場合は無視
      }
    };

    let timer: NodeJS.Timeout | null = null;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs);
    }

    let onAbort: (() => void) | null = null;
    if (options.signal) {
      onAbort = () => {
        aborted = true;
        kill();
      };
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort);
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    child.on("close", (code) => finish(code));
  });
}
