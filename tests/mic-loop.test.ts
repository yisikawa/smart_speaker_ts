import test from "node:test";
import assert from "node:assert/strict";
import { MicLoop } from "../src/frontend/MicLoop";
import type { BrowserMic } from "../src/frontend/mic";
import type { ClientCommand, HelloPayload } from "../src/shared/protocol";

type AudioConfig = HelloPayload["audio"];
type ListenOptions = Parameters<BrowserMic["listen"]>[0];

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function audioConfig(overrides: Partial<AudioConfig> = {}): AudioConfig {
  return {
    inputMode: "browser",
    playbackTarget: "browser",
    isPrimary: true,
    outputVolume: 1,
    sampleRate: 16000,
    noSpeechTimeoutMs: 5000,
    followup: { enabled: false, maxTurns: 0, timeoutMs: 0, guardMs: 0, keepListening: false },
    bargeIn: { enabled: true, minScore: 0.05 },
    silenceThreshold: 0.02,
    maxRecordMs: 10000,
    vad: {
      frameMs: 20,
      preRollMs: 100,
      silenceDurationMs: 500,
      smoothingAlpha: 0.3,
      relativeThresholdMultiplier: 3,
      maxSilenceThreshold: 0.06,
      calibrationMs: 500,
      debounceFrames: 2,
      inputGain: 1,
    },
    ...overrides,
  };
}

class FakeMic {
  cfg: AudioConfig;
  stopStreamCalls = 0;
  isRunning = false;
  constructor(cfg: AudioConfig, private readonly autoSpeech = false) {
    this.cfg = cfg;
  }
  reconfigure(cfg: AudioConfig): void {
    this.cfg = cfg;
  }
  async start(): Promise<void> {
    this.isRunning = true;
  }
  async stopStream(): Promise<void> {
    this.stopStreamCalls += 1;
    this.isRunning = false;
  }
  async listDevices(): Promise<{ id: string; label: string }[]> {
    return [];
  }
  listen(options: ListenOptions): Promise<never> {
    if (this.autoSpeech) {
      options.onSpeechStart?.();
    }
    return new Promise<never>(() => undefined);
  }
  stop(): void {}
  diagnostics(): string {
    return "";
  }
}

function createView() {
  return {
    deviceSelect: { value: "", disabled: false },
    setDeviceOptions: () => undefined,
    updateLevel: () => undefined,
    resetLevel: () => undefined,
    addSystemNote: () => undefined,
    showToast: () => undefined,
    setServicesText: () => undefined,
  };
}

test("configure はマイクを作り直さず設定だけ差し替える", () => {
  const created: FakeMic[] = [];
  const loop = new MicLoop({
    view: createView(),
    send: () => undefined,
    isConnected: () => true,
    onStateChange: () => undefined,
    createMic: (cfg) => {
      const mic = new FakeMic(cfg);
      created.push(mic);
      return mic as unknown as BrowserMic;
    },
  });

  loop.configure(audioConfig());
  loop.configure(audioConfig({ silenceThreshold: 0.05 }));

  assert.equal(created.length, 1);
  assert.equal(created[0].cfg.silenceThreshold, 0.05);
});

test("shutdown はループを止めてストリームを解放する", async () => {
  const created: FakeMic[] = [];
  const loop = new MicLoop({
    view: createView(),
    send: () => undefined,
    isConnected: () => true,
    onStateChange: () => undefined,
    createMic: (cfg) => {
      const mic = new FakeMic(cfg);
      created.push(mic);
      return mic as unknown as BrowserMic;
    },
  });
  loop.configure(audioConfig());
  await loop.shutdown();
  assert.equal(created[0].stopStreamCalls, 1);
});

test("バージイン検出時はローカル停止を先に呼び、その後に stop_speaking を送る", async () => {
  const order: string[] = [];
  const loop = new MicLoop({
    view: createView(),
    send: (command: ClientCommand) => order.push(command.type),
    isConnected: () => true,
    onStateChange: () => undefined,
    onBargeIn: () => order.push("barge"),
    createMic: (cfg) => new FakeMic(cfg, true) as unknown as BrowserMic,
  });
  loop.configure(audioConfig());
  void loop.start();
  await flush();
  assert.equal(order.length, 0);

  // 再生中の監視だけがバージインを拾う（録音ループの listen は onSpeechStart を渡さない）
  loop.startBargeMonitor();
  assert.deepEqual(order, ["barge", "stop_speaking"]);
  loop.stop();
});
