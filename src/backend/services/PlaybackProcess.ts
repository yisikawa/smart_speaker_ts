import type { ChildProcess } from "child_process";
import { ConfigManager } from "../config/ConfigManager";
import { Logger } from "../core/logger";
import type { PlaybackHandle } from "../core/ports";
import { ensureWav } from "./wav";

export interface PlaybackProcessDeps {
  config: ConfigManager;
  logger: Logger;
  /** 子プロセスの起動（テストではフェイク） */
  spawn: (binary: string, args: string[], options: { windowsHide: boolean }) => ChildProcess;
  /** ffplay が使えるか（テストでは固定値） */
  hasFfplay: () => Promise<boolean>;
  writeFile: (file: string, data: Buffer) => void;
  removeFile: (file: string) => void;
  tmpFile: () => string;
}

/** 再生バックエンドごとの引数（音量は 0..1 を 0..100 へ丸める） */
export function buildPlaybackArgs(
  kind: "ffplay" | "soundplayer",
  file: string,
  volume: number
): string[] {
  if (kind === "ffplay") {
    return [
      "-nodisp",
      "-autoexit",
      "-loglevel",
      "quiet",
      "-volume",
      String(Math.round(Math.min(1, Math.max(0, volume)) * 100)),
      "-i",
      file,
    ];
  }
  return [
    "-NoProfile",
    "-Command",
    `$p = New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}'; $p.PlaySync()`,
  ];
}

/**
 * WAV を一時ファイルへ書き、ffplay / SoundPlayer で再生する。
 *
 * `stop()` が書込や spawn より先に来たら、**後続の副作用を起こさない**。
 * 失敗しても `finished` は必ず解決する（パイプラインを止めない）。
 */
export class PlaybackProcess {
  private playerKind: "ffplay" | "soundplayer" | null = null;
  /** 再生中の子プロセス（`dispose()` で確実に止めるため保持する） */
  private readonly active = new Set<ChildProcess>();

  constructor(private readonly deps: PlaybackProcessDeps) {}

  play(wav: Buffer): PlaybackHandle {
    const cfg = this.deps.config.getAudio();
    const file = this.deps.tmpFile();
    let cancelled = false;
    let written = false;
    let proc: ChildProcess | null = null;
    let settled = false;
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    const removeTmp = (): void => {
      if (!written) {
        return;
      }
      try {
        this.deps.removeFile(file);
        written = false;
      } catch {
        // 子プロセスがまだ開いている場合がある（Windows）。close 時にもう一度試す
      }
    };

    const complete = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeTmp();
      resolveFinished();
    };

    const kill = (child: ChildProcess): void => {
      try {
        child.kill();
      } catch {
        // 既に終了している場合は無視
      }
    };

    void (async () => {
      try {
        if (cancelled) {
          complete();
          return;
        }
        this.deps.writeFile(file, ensureWav(wav, cfg.sample_rate));
        written = true;
        if (cancelled) {
          complete();
          return;
        }

        const kind = await this.resolvePlayer();
        if (cancelled) {
          complete();
          return;
        }

        const child = this.deps.spawn(
          kind === "ffplay" ? "ffplay" : "powershell.exe",
          buildPlaybackArgs(kind, file, cfg.output_volume),
          { windowsHide: true }
        );
        proc = child;
        this.active.add(child);
        if (cancelled) {
          // spawn 直前に停止されていた場合も孤児プロセスを残さない
          kill(child);
          this.active.delete(child);
          complete();
          return;
        }

        child.on("error", (error) => {
          this.active.delete(child);
          this.deps.logger.error("再生プロセスの起動に失敗しました", error);
          complete();
        });
        child.on("close", () => {
          this.active.delete(child);
          // stop() で消せなかった一時ファイルをここで回収する
          removeTmp();
          complete();
        });
      } catch (error) {
        this.deps.logger.error("再生に失敗しました", error);
        try {
          this.deps.removeFile(file);
          written = false;
        } catch {
          // 一時ファイル削除の失敗は無視
        }
        complete();
      }
    })();

    return {
      finished,
      stop: () => {
        cancelled = true;
        if (proc) {
          kill(proc);
        }
        complete();
      },
    };
  }

  /** 再生中のプロセスをすべて止める（終了処理用） */
  dispose(): void {
    for (const child of this.active) {
      try {
        child.kill();
      } catch {
        // 既に終了している場合は無視
      }
    }
    this.active.clear();
  }

  /** 再生バックエンドを決める（設定 → ffplay の有無 → SoundPlayer） */
  private async resolvePlayer(): Promise<"ffplay" | "soundplayer"> {
    const configured = this.deps.config.getAudio().player;
    if (configured === "ffplay" || configured === "soundplayer") {
      return configured;
    }
    if (this.playerKind) {
      return this.playerKind;
    }
    this.playerKind = (await this.deps.hasFfplay()) ? "ffplay" : "soundplayer";
    this.deps.logger.info(`再生バックエンド: ${this.playerKind}`);
    return this.playerKind;
  }
}
