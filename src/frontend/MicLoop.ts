import type { ClientCommand, HelloPayload } from "../shared/protocol";
import type { ChatView } from "./ChatView";
import { delay } from "./dom";
import { BrowserMic, BrowserMicError } from "./mic";
import type { ListenResult } from "./mic";

type AudioConfig = HelloPayload["audio"];

export interface MicLoopDeps {
  view: ChatView;
  send(command: ClientCommand): void;
  /** WebSocket が接続中か */
  isConnected(): boolean;
}

/** ターン完了を待つ最大時間（ms）。サーバー無応答で永久に待たないための保険 */
const TURN_TIMEOUT_MS = 60000;

/**
 * ブラウザ録音のターンループ（聞き取り → 送信 → 応答待ち → フォローアップ）と、
 * マイク選択・マイク確認・バージイン監視。
 */
export class MicLoop {
  private cfg: AudioConfig | null = null;
  private mic: BrowserMic | null = null;
  private running = false;
  private active = false;
  private bargeMonitorActive = false;
  private pendingBarge: string | null = null;
  private turnWaiter: ((completed: boolean) => void) | null = null;

  constructor(private readonly deps: MicLoopDeps) {}

  /** hello の音声設定を反映する（ブラウザモードならマイクを用意する） */
  configure(cfg: AudioConfig): void {
    this.cfg = cfg;
    this.mic = new BrowserMic(cfg);
    if (cfg.inputMode !== "browser") {
      this.deps.view.deviceSelect.disabled = true;
    }
  }

  get isBrowserMode(): boolean {
    return this.cfg?.inputMode === "browser";
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 聞き取りループを開始する（ブラウザモードのみ） */
  async start(): Promise<void> {
    const cfg = this.cfg;
    if (!cfg || cfg.inputMode !== "browser" || this.running) {
      return;
    }
    if (!this.deps.isConnected()) {
      this.deps.view.showToast("サーバーに接続されていません", "error");
      return;
    }

    this.running = true;
    this.active = true;
    try {
      this.mic = this.mic ?? new BrowserMic(cfg);
      await this.mic.start(this.deviceId());
      await this.refreshDevices();

      let followup = 0;
      while (this.active) {
        let wav = this.pendingBarge;
        this.pendingBarge = null;

        if (!wav) {
          if (followup > 0) {
            await delay(cfg.followup.guardMs);
            if (!this.active) {
              break;
            }
          }
          this.deps.view.setState("recording");
          const result = await this.mic.listen({
            startTimeoutMs: followup > 0 ? cfg.followup.timeoutMs : cfg.noSpeechTimeoutMs,
            maxDurationMs: cfg.maxRecordMs,
            onLevel: (level, threshold) => this.deps.view.updateLevel(level, threshold),
          });
          this.deps.view.resetLevel();
          if (!this.active) {
            break;
          }
          if (!result.wavBase64) {
            this.reportEmptyCapture(result);
            break;
          }
          wav = result.wavBase64;
        }

        this.deps.send({ type: "submit_audio", format: "wav", sampleRate: cfg.sampleRate, data: wav });
        this.deps.view.setState("transcribing");
        const completed = await this.waitForTurn();
        if (!this.active || !completed) {
          break;
        }

        if (this.pendingBarge) {
          // バージインで取得した発話をそのまま次のターンへ
          followup = 0;
          continue;
        }
        if (!cfg.followup.enabled) {
          break;
        }
        if (!cfg.followup.keepListening && followup >= cfg.followup.maxTurns) {
          break;
        }
        followup += 1;
        if (followup <= cfg.followup.maxTurns) {
          this.deps.view.addSystemNote(
            `続けて話しかけてください（${followup}/${cfg.followup.maxTurns}・${Math.round(
              cfg.followup.timeoutMs / 1000
            )} 秒）`
          );
        }
      }
    } catch (error) {
      this.deps.view.showToast(errorText(error), "error");
      this.deps.view.setServicesText("サーバー未接続（再接続中…）", true);
    } finally {
      this.running = false;
      this.active = false;
      this.mic?.stop("aborted");
      this.deps.view.setState("idle");
    }
  }

  /** 聞き取りを止める（停止ボタン・ページ破棄） */
  stop(): void {
    this.active = false;
    this.mic?.stop("aborted");
    this.resolveTurn(false);
  }

  /** ターン完了（または破棄）を通知する */
  resolveTurn(completed: boolean): void {
    this.turnWaiter?.(completed);
  }

  /** 再生中の割り込みを監視し、発話があれば再生停止＋次ターンの入力にする */
  startBargeMonitor(): void {
    const cfg = this.cfg;
    if (!cfg || cfg.inputMode !== "browser" || !cfg.bargeIn.enabled) {
      return;
    }
    if (!this.mic?.isRunning || !this.active || this.bargeMonitorActive) {
      return;
    }
    this.bargeMonitorActive = true;
    void this.mic
      .listen({
        startTimeoutMs: cfg.maxRecordMs,
        maxDurationMs: cfg.maxRecordMs,
        threshold: Math.max(cfg.silenceThreshold, cfg.bargeIn.minScore),
        onSpeechStart: () => this.deps.send({ type: "stop_speaking" }),
      })
      .then((result) => {
        if (result.wavBase64) {
          this.pendingBarge = result.wavBase64;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.bargeMonitorActive = false;
      });
  }

  /** 入力デバイス一覧を更新する */
  async refreshDevices(): Promise<void> {
    if (!this.mic || !this.isBrowserMode) {
      return;
    }
    try {
      const devices = await this.mic.listDevices();
      const current = this.deps.view.deviceSelect.value;
      this.deps.view.setDeviceOptions(devices, current);
    } catch {
      // 一覧が取れなくても既定デバイスで録音は可能
    }
  }

  /** マイクを切り替える */
  async switchDevice(): Promise<void> {
    if (!this.mic) {
      return;
    }
    try {
      await this.mic.start(this.deviceId());
      this.deps.view.showToast("マイクを切り替えました", "info");
      await this.refreshDevices();
    } catch (error) {
      this.deps.view.showToast(errorText(error), "error");
    }
  }

  /** マイク入力を 5 秒だけ確認する（送信はしない） */
  async checkMic(): Promise<void> {
    const cfg = this.cfg;
    if (!cfg || cfg.inputMode !== "browser" || !this.mic) {
      this.deps.view.showToast("マイク確認はブラウザ入力モードのみ対応しています", "error");
      return;
    }
    if (this.running) {
      this.deps.view.showToast("聞き取り中は実行できません。先に停止してください", "error");
      return;
    }
    const view = this.deps.view;
    try {
      await this.mic.start(this.deviceId());
      await this.refreshDevices();
      view.showToast("5 秒間マイクを確認します。話しかけてください", "info");

      const runListen = (): Promise<ListenResult> =>
        this.mic!.listen({
          startTimeoutMs: 5000,
          maxDurationMs: 5000,
          onLevel: (level, threshold) => view.updateLevel(level, threshold),
        });

      let result = await runListen();
      if (result.frames === 0) {
        // AudioContext が suspend していた場合などに備えて、開き直して 1 回だけ再試行する
        view.showToast("音声処理を再初期化して再試行します…", "info");
        await this.mic.stopStream();
        await this.mic.start(this.deviceId());
        result = await runListen();
      }

      const dbfs = result.peakLevel > 0 ? (20 * Math.log10(result.peakLevel)).toFixed(1) : "-∞";
      if (result.frames === 0) {
        view.showToast(`音声データが届きません（${this.mic.diagnostics()}）`, "error");
      } else if (result.peakLevel < cfg.silenceThreshold * 0.5) {
        view.showToast(
          `ほぼ無音でした（frames=${result.frames} / peak=${result.peakLevel}）。マイク選択を確認してください`,
          "error"
        );
      } else {
        view.showToast(
          `マイクOK: peak ${result.peakLevel.toFixed(3)}（${dbfs} dBFS）/ ${result.frames} フレーム`,
          "info"
        );
      }
    } catch (error) {
      view.showToast(errorText(error), "error");
    } finally {
      view.resetLevel();
    }
  }

  /** 発話が取れなかった原因をユーザーへ伝える */
  private reportEmptyCapture(result: ListenResult): void {
    const cfg = this.cfg;
    if (!cfg) {
      return;
    }
    if (result.frames === 0) {
      this.deps.view.showToast(
        `マイクから音声データが届きませんでした（${this.mic ? this.mic.diagnostics() : "-"}）`,
        "error"
      );
    } else if (result.peakLevel < cfg.silenceThreshold * 0.5) {
      this.deps.view.showToast(
        "マイクの入力レベルがほぼ 0 です（ミュート／Windows の入力レベルを確認してください）",
        "error"
      );
    }
  }

  private deviceId(): string | undefined {
    return this.deps.view.deviceSelect.value || undefined;
  }

  private waitForTurn(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const finish = (completed: boolean): void => {
        if (this.turnWaiter === finish) {
          this.turnWaiter = null;
          resolve(completed);
        }
      };
      this.turnWaiter = finish;
      // 保険: サーバーから何も来ない場合に永久に待たない（フリーズ防止）
      window.setTimeout(() => {
        if (this.turnWaiter === finish) {
          this.deps.view.showToast("応答が返りませんでした。サーバーのログを確認してください", "error");
        }
        finish(false);
      }, TURN_TIMEOUT_MS);
    });
  }
}

function errorText(error: unknown): string {
  return error instanceof BrowserMicError
    ? error.message
    : String((error as Error)?.message ?? error);
}
