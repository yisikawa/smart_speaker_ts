import type { CaptureEndReason, HelloPayload } from "../shared/protocol";
import { applyGain, bytesToBase64, encodeWav, resample } from "../shared/audio/pcm";
import { VadEngine } from "../shared/audio/vad";

/** hello で受け取る音声設定 */
export type MicAudioConfig = HelloPayload["audio"];

export interface ListenOptions {
  startTimeoutMs: number;
  maxDurationMs: number;
  threshold?: number;
  onLevel?: (level: number, threshold: number) => void;
  onSpeechStart?: () => void;
}

export interface ListenResult {
  /** 発話が取れた場合の 16kHz モノラル WAV（Base64）。無音なら null */
  wavBase64: string | null;
  reason: CaptureEndReason;
  frames: number;
  peakLevel: number;
  durationMs: number;
}

export class BrowserMicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserMicError";
  }
}

/** AudioWorklet として読み込む処理（Blob URL 経由で追加するので追加ファイル不要） */
const WORKLET_SOURCE = `
class SumikaCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}
registerProcessor("sumika-capture", SumikaCaptureProcessor);
`;

interface ActiveSession {
  engine: VadEngine;
  options: ListenOptions;
  resolve: (result: ListenResult) => void;
  startTimer: number | null;
  maxTimer: number | null;
}

/**
 * ブラウザのマイク入力（getUserMedia + Web Audio）。
 * VAD はサーバーと同じ `VadEngine` を共有し、発話単位の WAV を生成する。
 */
export class BrowserMic {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioNode | null = null;
  private sink: GainNode | null = null;
  private deviceId: string | null = null;
  private session: ActiveSession | null = null;
  private sampleCallbacks = 0;

  constructor(private readonly config: MicAudioConfig) {}

  get isRunning(): boolean {
    return this.stream !== null;
  }

  get captureRate(): number {
    return this.context?.sampleRate ?? this.config.sampleRate;
  }

  /** マイクを開く（初回はブラウザの許可ダイアログが出る） */
  async start(deviceId?: string): Promise<void> {
    const target = deviceId ?? null;
    if (this.stream && this.deviceId === target) {
      await this.ensureRunning(true);
      return;
    }
    await this.stopStream();

    if (!window.isSecureContext) {
      throw new BrowserMicError(
        `マイクは https または http://localhost でのみ使用できます（現在: ${window.location.origin}）`
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new BrowserMicError(
        "このブラウザはマイク入力に対応していません（http://localhost または https で開いてください）"
      );
    }

    // 自動再生ポリシー対策: クリック操作中に AudioContext を作り、すぐ resume する
    const context = this.ensureContext();
    await this.ensureRunning(false);

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: target ? { exact: target } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      throw new BrowserMicError(describeMicError(error));
    }
    this.deviceId = target;

    const track = this.stream.getAudioTracks()[0];
    if (track) {
      track.addEventListener("ended", () => this.log(`マイクトラックが終了しました: ${track.label}`));
      track.addEventListener("mute", () => this.log(`マイクがミュートされました: ${track.label}`));
    }

    // 許可ダイアログの待ち時間で suspend に戻ることがあるため、ここでも再開を試みる
    await this.ensureRunning(true);

    this.source = context.createMediaStreamSource(this.stream);
    this.node = await this.createCaptureNode(context);
    // 音を出さずにワークレットを動かすためのダミー経路（フィードバック防止）
    this.sink = context.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(context.destination);
    await this.ensureRunning(true);

    this.log(`マイク開始: ${this.diagnostics()}`);
  }

  /** AudioContext を（必要なら）作る */
  private ensureContext(): AudioContext {
    if (this.context && this.context.state !== "closed") {
      return this.context;
    }
    const AudioContextCtor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      throw new BrowserMicError("Web Audio API を利用できません");
    }
    this.context = new AudioContextCtor({ sampleRate: this.config.sampleRate });
    return this.context;
  }

  /**
   * AudioContext が running になるまで待つ。
   * 自動再生ポリシーで開始できない場合は、次のクリックで再開できるようにする。
   */
  private async ensureRunning(strict: boolean): Promise<void> {
    const context = this.context;
    if (!context || context.state === "running") {
      return;
    }
    await context.resume().catch(() => undefined);
    if ((context.state as string) === "running") {
      return;
    }
    // 次のクリックで resume を試みる（ユーザー操作が必要なブラウザ向け）
    document.addEventListener(
      "pointerdown",
      () => {
        if (this.context?.state === "suspended") {
          void this.context.resume().catch(() => undefined);
        }
      },
      { once: true }
    );
    if (strict) {
      throw new BrowserMicError(
        "ブラウザが音声処理を開始できませんでした。画面をもう一度クリックして再試行してください。"
      );
    }
  }

  /** 切り分け用の状態文字列 */
  diagnostics(): string {
    const track = this.stream?.getAudioTracks()[0];
    return [
      `ctx=${this.context?.state ?? "none"}`,
      `rate=${this.context?.sampleRate ?? "-"}`,
      `device="${track?.label ?? "(未取得)"}"`,
      `muted=${track?.muted ?? "-"}`,
      `samples=${this.sampleCallbacks}`,
      `secure=${window.isSecureContext}`,
    ].join(" ");
  }

  private log(message: string): void {
    console.info(`[mic] ${message}`);
  }

  private async createCaptureNode(context: AudioContext): Promise<AudioNode> {
    if (context.audioWorklet) {
      try {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
        await context.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(context, "sumika-capture");
        node.port.onmessage = (event: MessageEvent<Float32Array>) => this.onSamples(event.data);
        return node;
      } catch {
        // AudioWorklet が使えない環境では ScriptProcessor にフォールバック
      }
    }
    const processor = context.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (event) => this.onSamples(event.inputBuffer.getChannelData(0).slice(0));
    return processor;
  }

  /** 入力デバイス一覧（ラベルは許可後に取得できる） */
  async listDevices(): Promise<{ id: string; label: string }[]> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return [];
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "audioinput")
      .map((device) => ({ id: device.deviceId, label: device.label || "マイク" }));
  }

  /** 1 発話を録音する（VAD で自動区切り）。無音なら wavBase64 = null */
  listen(options: ListenOptions): Promise<ListenResult> {
    if (!this.stream || !this.context) {
      return Promise.reject(new BrowserMicError("マイクが開かれていません"));
    }
    if (this.session) {
      this.finishSession("aborted");
    }

    const vad = this.config.vad;
    const engine = new VadEngine(
      {
        sampleRate: this.captureRate,
        frameMs: vad.frameMs,
        preRollMs: vad.preRollMs,
        silenceThreshold: this.config.silenceThreshold,
        silenceDurationMs: vad.silenceDurationMs,
        smoothingAlpha: vad.smoothingAlpha,
        relativeThresholdMultiplier: vad.relativeThresholdMultiplier,
        calibrationMs: vad.calibrationMs,
        debounceFrames: vad.debounceFrames,
        inputGain: vad.inputGain,
      },
      {
        maxDurationMs: options.maxDurationMs,
        startTimeoutMs: options.startTimeoutMs,
        threshold: options.threshold,
      }
    );

    return new Promise<ListenResult>((resolve) => {
      const session: ActiveSession = { engine, options, resolve, startTimer: null, maxTimer: null };
      // フレームが来ない場合でも時間で終了させる（デバイス停止・ミュート対策）
      session.startTimer = window.setTimeout(() => {
        if (this.session === session && !engine.hasSpeech) {
          this.finishSession("no_speech");
        }
      }, options.startTimeoutMs + 500);
      session.maxTimer = window.setTimeout(() => {
        if (this.session === session) {
          this.finishSession("max_duration");
        }
      }, options.maxDurationMs + 1000);
      this.session = session;
    });
  }

  /** 録音中のセッションを中断する */
  stop(reason: CaptureEndReason = "aborted"): void {
    this.finishSession(reason);
  }

  /** マイクを閉じる */
  async stopStream(): Promise<void> {
    this.finishSession("aborted");
    try {
      this.node?.disconnect();
      this.source?.disconnect();
      this.sink?.disconnect();
    } catch {
      // 無視
    }
    this.node = null;
    this.source = null;
    this.sink = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.deviceId = null;
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // 無視
      }
      this.context = null;
    }
  }

  private onSamples(input: Float32Array): void {
    this.sampleCallbacks += 1;
    const session = this.session;
    if (!session) {
      return;
    }
    const samples = toInt16(input);
    const frameSamples = session.engine.frameSamples;
    for (let offset = 0; offset + frameSamples <= samples.length; offset += frameSamples) {
      const frame = samples.slice(offset, offset + frameSamples);
      const decision = session.engine.push(frame);
      session.options.onLevel?.(session.engine.level, session.engine.threshold);
      if (decision.kind === "speech_start") {
        session.options.onSpeechStart?.();
      }
      if (decision.kind === "finish") {
        this.finishSession(decision.reason);
        return;
      }
    }
  }

  private finishSession(reason: CaptureEndReason): void {
    const session = this.session;
    if (!session) {
      return;
    }
    this.session = null;
    session.engine.finish(reason);
    if (session.startTimer !== null) {
      window.clearTimeout(session.startTimer);
    }
    if (session.maxTimer !== null) {
      window.clearTimeout(session.maxTimer);
    }

    const hasSpeech = session.engine.hasSpeech;
    let wavBase64: string | null = null;
    if (hasSpeech) {
      const gained = applyGain(session.engine.collectedPcm(), this.config.vad.inputGain);
      const resampled = resample(gained, this.captureRate, this.config.sampleRate);
      wavBase64 = bytesToBase64(encodeWav(resampled, this.config.sampleRate));
    }

    session.resolve({
      wavBase64,
      reason,
      frames: session.engine.frames,
      peakLevel: session.engine.peakLevel,
      durationMs: session.engine.elapsedMs,
    });
  }
}

function toInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const value = Math.max(-1, Math.min(1, input[i]));
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return out;
}

function describeMicError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "マイクの使用が許可されていません。アドレスバー横のマイク設定で許可してください。";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "マイクが見つかりません。接続と Windows のサウンド設定を確認してください。";
    case "NotReadableError":
    case "TrackStartError":
      return "マイクが他のアプリに使用されています。他のアプリを閉じてから再試行してください。";
    case "OverconstrainedError":
      return "指定したマイクを開けませんでした。別のマイクを選択してください。";
    default:
      return `マイクを開けませんでした: ${(error as Error)?.message ?? String(error)}`;
  }
}
