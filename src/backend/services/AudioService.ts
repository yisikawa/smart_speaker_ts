import { spawn, spawnSync, ChildProcess, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { CaptureEndReason } from "../../shared/protocol";
import { applyGain, bytesToInt16, int16ToBytes } from "../../shared/audio/pcm";
import { buildVadSettings } from "../../shared/audio/vadSettings";
import { VadEngine } from "../../shared/audio/vad";
import { ConfigManager } from "../config/ConfigManager";
import { AudioConfig } from "../config/schema";
import { Logger } from "../core/logger";
import { runtimeTempDir } from "../core/paths";
import {
  AudioDevice,
  AudioIO,
  CaptureHandle,
  CaptureOptions,
  CaptureResult,
  PlaybackHandle,
} from "../core/ports";
import { PlaybackProcess } from "./PlaybackProcess";
import { encodeWav } from "./wav";

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
  /** 再生は PlaybackProcess に委譲する（停止のキャンセルを 1 箇所に閉じ込める） */
  private readonly playbackProcess: PlaybackProcess;
  /** 録音セッションの直列化用ロック */
  private deviceLock: Promise<void> = Promise.resolve();

  constructor(private readonly deps: { config: ConfigManager; logger?: Logger }) {
    this.logger = deps.logger ?? new Logger("Audio");
    this.playbackProcess = new PlaybackProcess({
      config: deps.config,
      logger: this.logger,
      spawn: (binary, args, options) => spawn(binary, args, options),
      hasFfplay: async () =>
        spawnSync("ffplay", ["-version"], { windowsHide: true, encoding: "utf8", timeout: 5000 })
          .status === 0,
      writeFile: (file, data) => fs.writeFileSync(file, data),
      removeFile: (file) => {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      },
      tmpFile: () =>
        path.join(
          runtimeTempDir(deps.config.rootDir),
          `sumika_play_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`
        ),
    });
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
    // VAD 設定の組み立ては shared/audio/vadSettings（ブラウザと共通の 1 箇所）に任せる
    const engine = new VadEngine(buildVadSettings(cfg), {
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
      // 発話区間のみを取り出し、設定された input_gain を実サンプルに適用する
      const samples = hasSpeech ? applyGain(engine.collectedPcm(), cfg.input_gain) : new Int16Array(0);
      const pcm = hasSpeech ? Buffer.from(int16ToBytes(samples)) : Buffer.alloc(0);
      if (engine.frames === 0 && reason !== "aborted") {
        this.logger.warn(
          `録音フレームが 0 件でした（reason=${reason}）。マイクの使用状況・ミュート・デバイス設定を確認してください。`
        );
      }
      resolveResult({
        pcm,
        wav: encodeWav(pcm, cfg.sample_rate),
        durationMs: Math.round(engine.elapsedMs),
        hasSpeech: hasSpeech && pcm.length > 0,
        reason,
        frames: engine.frames,
        peakLevel: Number(engine.peakLevel.toFixed(3)),
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

    // マイクは 1 セッションずつ排他的に使う（バージイン監視とフォローアップの競合対策）
    void (async () => {
      const release = await this.acquireDevice();
      try {
        if (settled) {
          return;
        }
        await this.runCapture(cfg, engine, options, finalize, () => settled, (p) => {
          proc = p;
          if (settled) {
            // finalize 後に spawn された場合は即座に止める（孤児プロセス防止）
            try {
              p.kill();
            } catch {
              // 無視
            }
          }
        });
      } catch (error) {
        this.logger.error("録音の開始に失敗しました", error);
        finalize("device_error");
      } finally {
        release();
      }
    })();

    return handle;
  }

  /**
   * 録音セッションを直列化する。
   * 前のセッションの ffmpeg が終了してから `device_settle_ms` 待ってマイクを開く。
   */
  private async acquireDevice(): Promise<() => void> {
    const previous = this.deviceLock;
    let release!: () => void;
    this.deviceLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const settleMs = this.deps.config.getAudio().device_settle_ms;
    if (settleMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
    }
    return () => release();
  }

  private async runCapture(
    cfg: AudioConfig,
    engine: VadEngine,
    options: CaptureOptions,
    onFinish: (reason: CaptureEndReason) => void,
    isSettled: () => boolean,
    setProcess: (proc: ChildProcessWithoutNullStreams) => void
  ): Promise<void> {
    const device = await this.resolveInputDevice(cfg);
    if (isSettled()) {
      // デバイス解決中に停止された場合は起動しない（孤児プロセス防止）
      this.logger.debug("録音開始前にセッションが終了したため ffmpeg は起動しません");
      return;
    }
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
    this.logger.debug(`ffmpeg 起動: pid=${proc.pid} device="${device}"`);

    const frameSamples = engine.frameSamples;
    const frameBytes = frameSamples * 2;
    let pending: Buffer = Buffer.alloc(0);
    let stderr = "";
    let speechNotified = false;

    proc.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        const frame = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);

        const decision = engine.push(bytesToInt16(new Uint8Array(frame.buffer, frame.byteOffset, frameBytes)));
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

    // プロセスの終了（= デバイス解放）まで待つ。次の録音はこの後に開始される。
    await new Promise<void>((resolve) => {
      proc.on("close", (code) => {
        this.children.delete(proc);
        const stderrText = stderr.trim();
        if (stderrText) {
          this.logger.warn(`ffmpeg: ${stderrText.slice(0, 400)}`);
        }
        this.logger.info(
          `録音終了: frames=${engine.frames} peak=${engine.peakLevel.toFixed(3)} code=${code} device="${device}"`
        );
        // 正常終了（= こちらからの kill 後に finalize 済み）以外は異常とみなす
        if (code !== 0) {
          onFinish("device_error");
        }
        resolve();
      });
    });
  }

  play(wav: Buffer): PlaybackHandle {
    return this.playbackProcess.play(wav);
  }

  async dispose(): Promise<void> {
    this.playbackProcess.dispose();
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
