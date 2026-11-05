import { spawn, spawnSync, ChildProcess, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { CaptureEndReason } from "../../shared/protocol";
import { ConfigManager } from "../config/ConfigManager";
import { AudioConfig } from "../config/schema";
import { Logger } from "../core/logger";
import {
  AudioDevice,
  AudioIO,
  CaptureHandle,
  CaptureOptions,
  CaptureResult,
  PlaybackHandle,
  VadSettings,
} from "../core/ports";
import { encodeWav, ensureWav } from "./wav";
import { VadEngine } from "./vad";

/**
 * 音声入出力（Windows / ffmpeg 前提）。
 *
 * - 録音: `ffmpeg -f dshow` の 16bit PCM を stdout からストリーム取得し、
 *   VAD（VadEngine）で発話区間のみを切り出す。execSync によるブロッキングは行わない。
 * - 再生: WAV を一時ファイルへ書き出し、ffplay（無ければ PowerShell SoundPlayer）で再生する。
 */
export class AudioService implements AudioIO {
  private readonly logger: Logger;
  private readonly children = new Set<ChildProcess>();
  private deviceCache: AudioDevice[] | null = null;
  private playerKind: "ffplay" | "soundplayer" | null = null;

  constructor(private readonly deps: { config: ConfigManager; logger?: Logger }) {
    this.logger = deps.logger ? deps.logger.child("Audio") : new Logger("Audio");
  }

  /** ffmpeg 実行パス（設定で上書き可能） */
  private ffmpegBinary(): string {
    const configured = this.deps.config.getAudio().ffmpeg_path;
    return configured ? this.deps.config.resolvePath(configured) : "ffmpeg";
  }

  async listInputDevices(): Promise<AudioDevice[]> {
    if (this.deviceCache) {
      return this.deviceCache;
    }
    if (process.platform !== "win32") {
      this.deviceCache = [];
      return this.deviceCache;
    }

    const result = spawnSync(
      this.ffmpegBinary(),
      ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
      { encoding: "utf8", windowsHide: true, timeout: 10000 }
    );

    const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    const devices: AudioDevice[] = [];
    const pattern = /"([^"]+)"\s*\((audio|video)\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      if (match[2] === "audio") {
        devices.push({ name: match[1] });
      }
    }

    this.deviceCache = devices;
    this.logger.info(`入力デバイス: ${devices.map((d) => d.name).join(", ") || "(なし)"}`);
    return devices;
  }

  private async resolveInputDevice(cfg: AudioConfig): Promise<string> {
    if (cfg.input_device) {
      return cfg.input_device;
    }
    const devices = await this.listInputDevices();
    if (devices.length > 0) {
      return devices[0].name;
    }
    throw new Error(
      "入力デバイスが見つかりません。config/settings.toml の audio.input_device にデバイス名を指定してください。"
    );
  }

  capture(options: CaptureOptions): CaptureHandle {
    const cfg = this.deps.config.getAudio();
    const vadSettings: VadSettings = {
      sampleRate: cfg.sample_rate,
      frameMs: cfg.frame_ms,
      preRollMs: cfg.pre_roll_ms,
      silenceThreshold: cfg.silence_threshold,
      silenceDurationMs: cfg.silence_duration * 1000,
      smoothingAlpha: cfg.smoothing_alpha,
      relativeThresholdMultiplier: cfg.relative_threshold_multiplier,
      calibrationMs: cfg.calibration_duration * 1000,
      debounceFrames: cfg.debounce_frames,
      inputGain: cfg.input_gain,
    };
    const engine = new VadEngine(vadSettings, {
      maxDurationMs: options.maxDurationMs,
      startTimeoutMs: options.startTimeoutMs,
      silenceDurationMs: options.silenceDurationMs,
      threshold: options.threshold,
    });

    let settled = false;
    let proc: ChildProcessWithoutNullStreams | null = null;
    let watchdog: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;
    let resolveResult!: (result: CaptureResult) => void;

    const result = new Promise<CaptureResult>((resolve) => {
      resolveResult = resolve;
    });

    const finalize = (reason: CaptureEndReason): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      if (options.signal && abortListener) {
        options.signal.removeEventListener("abort", abortListener);
      }
      engine.finish(reason);
      if (proc) {
        this.children.delete(proc);
        try {
          proc.kill();
        } catch {
          // 既に終了している場合は無視
        }
      }
      const hasSpeech = engine.hasSpeech;
      const pcm = hasSpeech ? engine.collectedPcm() : Buffer.alloc(0);
      resolveResult({
        pcm,
        wav: encodeWav(pcm, cfg.sample_rate),
        durationMs: Math.round(engine.elapsedMs),
        hasSpeech: hasSpeech && pcm.length > 0,
        reason,
      });
    };

    const handle: CaptureHandle = {
      result,
      stop: (reason = "aborted") => finalize(reason),
    };

    // デバイスが無応答の場合の保険（VAD の時間判定とは独立）
    watchdog = setTimeout(() => finalize("max_duration"), options.maxDurationMs + 1500);

    if (options.signal) {
      abortListener = () => finalize("aborted");
      if (options.signal.aborted) {
        abortListener();
        return handle;
      }
      options.signal.addEventListener("abort", abortListener);
    }

    void this.runCapture(cfg, engine, options, finalize, (p) => {
      proc = p;
    }).catch((error: unknown) => {
      this.logger.error("録音の開始に失敗しました", error);
      finalize("device_error");
    });

    return handle;
  }

  private async runCapture(
    cfg: AudioConfig,
    engine: VadEngine,
    options: CaptureOptions,
    onFinish: (reason: CaptureEndReason) => void,
    setProcess: (proc: ChildProcessWithoutNullStreams) => void
  ): Promise<void> {
    const device = await this.resolveInputDevice(cfg);
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "dshow",
      "-audio_buffer_size",
      "50",
      "-i",
      `audio=${device}`,
      "-ac",
      "1",
      "-ar",
      String(cfg.sample_rate),
      "-f",
      "s16le",
      "-",
    ];

    // spawn はシェルを介さないため、デバイス名の空白・記号・日本語も安全に渡せる
    const proc = spawn(this.ffmpegBinary(), args, { windowsHide: true });
    setProcess(proc);
    this.children.add(proc);

    const frameBytes = engine.frameBytes;
    let pending: Buffer = Buffer.alloc(0);
    let stderr = "";
    let speechNotified = false;

    proc.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        const frame = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);

        const decision = engine.push(frame);
        options.onLevel?.(engine.level, engine.threshold);

        if (decision.kind === "speech_start" && !speechNotified) {
          speechNotified = true;
          options.onSpeechStart?.();
        }
        if (decision.kind === "finish") {
          onFinish(decision.reason);
          return;
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      this.children.delete(proc);
      this.logger.error(`ffmpeg の起動に失敗しました: ${error.message}`);
      onFinish("device_error");
    });

    proc.on("close", (code) => {
      this.children.delete(proc);
      if (stderr.trim()) {
        this.logger.warn(`ffmpeg: ${stderr.trim().slice(0, 400)}`);
      }
      // 正常終了（= こちらからの kill 後に finalize 済み）以外は異常とみなす
      if (code !== 0) {
        onFinish("device_error");
      }
    });
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
    const probe = spawnSync("ffplay", ["-version"], { windowsHide: true, encoding: "utf8", timeout: 5000 });
    this.playerKind = probe.status === 0 ? "ffplay" : "soundplayer";
    this.logger.info(`再生バックエンド: ${this.playerKind}`);
    return this.playerKind;
  }

  play(wav: Buffer): PlaybackHandle {
    const cfg = this.deps.config.getAudio();
    const file = path.join(
      os.tmpdir(),
      `sumika_play_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`
    );
    let proc: ChildProcess | null = null;
    let resolveFinished!: () => void;
    let resolved = false;

    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    const complete = (): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch {
        // 一時ファイル削除の失敗は無視
      }
      resolveFinished();
    };

    void (async () => {
      try {
        // VOICEVOX の出力は既に WAV なので二重ヘッダを付けない
        fs.writeFileSync(file, ensureWav(wav, cfg.sample_rate));
        const kind = await this.resolvePlayer();
        const args =
          kind === "ffplay"
            ? [
                "-nodisp",
                "-autoexit",
                "-loglevel",
                "quiet",
                "-volume",
                String(Math.round(Math.min(1, Math.max(0, cfg.output_volume)) * 100)),
                "-i",
                file,
              ]
            : [
                "-NoProfile",
                "-Command",
                `$p = New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}'; $p.PlaySync()`,
              ];

        const child = spawn(kind === "ffplay" ? "ffplay" : "powershell.exe", args, {
          windowsHide: true,
        });
        proc = child;
        this.children.add(child);

        child.on("error", (error) => {
          this.logger.error("再生プロセスの起動に失敗しました", error);
          complete();
        });
        child.on("close", () => {
          this.children.delete(child);
          complete();
        });
      } catch (error) {
        this.logger.error("再生に失敗しました", error);
        complete();
      }
    })();

    return {
      finished,
      stop: () => {
        if (proc) {
          try {
            proc.kill();
          } catch {
            // 既に終了している場合は無視
          }
        }
        complete();
      },
    };
  }

  async dispose(): Promise<void> {
    for (const child of this.children) {
      try {
        child.kill();
      } catch {
        // 無視
      }
    }
    this.children.clear();
  }
}
