import type {
  ClientCommand,
  DiagnosticsReport,
  HelloPayload,
  PipelineEvent,
  ServerMessage,
} from "../shared/protocol";
import { ChatView } from "./ChatView";
import { MicLoop } from "./MicLoop";
import { WsClient } from "./WsClient";

/**
 * 画面の組み立て（Composition Root）。
 *
 * - 描画: `ChatView`
 * - 通信: `WsClient`（接続・再接続・hello 待ち）
 * - 録音: `MicLoop`（ブラウザのマイク・フォローアップ・バージイン監視）
 *
 * ここは「イベントを誰に渡すか」だけを持ち、DOM 操作・通信・録音の詳細は各担当に任せる。
 */
class SumikaApp {
  private readonly view = new ChatView();
  private readonly ws: WsClient;
  private readonly micLoop: MicLoop;
  /** 診断パネルを開いているか */
  private diagnosticsOpen = false;

  constructor() {
    this.ws = new WsClient({
      onOpen: () => {
        this.view.setServicesText("接続済み（状態を取得中…）");
        this.view.showToast("サーバーに接続しました", "info");
      },
      onMessage: (message) => this.handleMessage(message),
      onClose: () => {
        this.view.setServicesText("サーバー未接続（再接続中…）", true);
        this.view.setState("error");
        this.view.showToast("サーバーとの接続が切れました（再接続します）", "error");
      },
      onHelloTimeout: () => {
        if (this.view.servicesEl.textContent?.startsWith("接続済み")) {
          this.view.setServicesText("サーバーの応答がありません（ページを再読み込みしてください）", true);
        }
      },
    });
    this.micLoop = new MicLoop({
      view: this.view,
      send: (command) => this.send(command),
      isConnected: () => this.ws.isOpen,
    });
  }

  start(): void {
    this.bindEvents();
    // connect() より先に初期状態を設定する（未接続時の表示を上書きしないため）
    this.view.setState("idle");
    this.connect();
  }

  private connect(): void {
    // start.bat を使わずに HTML を直接開いた場合は WebSocket を張れないため、明示する
    if (this.ws.isUnsupportedEnvironment) {
      this.view.setServicesText("未接続（start.bat で起動し http://localhost:3000 を開いてください）", true);
      this.view.statusEl.className = "status error";
      this.view.statusEl.textContent = "未接続";
      return;
    }
    this.ws.connect();
  }

  private bindEvents(): void {
    const view = this.view;
    view.btnListen.addEventListener("click", () => {
      // ブラウザ入力モードでは、この画面がマイクを開いて発話単位で送信する
      if (this.micLoop.isBrowserMode) {
        void this.micLoop.start();
        return;
      }
      this.send({ type: "start_listening" });
    });
    view.btnStop.addEventListener("click", () => {
      this.micLoop.stop();
      this.send({ type: "stop_listening" });
    });
    view.btnClear.addEventListener("click", () => this.send({ type: "clear_history" }));
    view.btnSend.addEventListener("click", () => this.submitText());
    view.btnMicTest.addEventListener("click", () => {
      void this.micLoop.checkMic();
    });
    view.btnDiagnostics.addEventListener("click", () => {
      void this.showDiagnostics();
    });
    view.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.submitText();
      }
    });
    view.deviceSelect.addEventListener("change", () => {
      if (this.micLoop.isBrowserMode) {
        void this.micLoop.switchDevice();
      }
    });
  }

  private submitText(): void {
    const text = this.view.inputEl.value.trim();
    if (!text) {
      return;
    }
    this.send({ type: "submit_text", text });
    this.view.inputEl.value = "";
  }

  private send(command: ClientCommand): void {
    if (!this.ws.send(command)) {
      this.view.showToast("サーバーに接続されていません", "error");
    }
  }

  /** 診断情報（/api/diagnostics）を取得して表示する。もう一度押すと閉じる */
  private async showDiagnostics(): Promise<void> {
    if (this.diagnosticsOpen) {
      this.diagnosticsOpen = false;
      this.view.renderDiagnostics(null);
      return;
    }
    try {
      const res = await fetch("/api/diagnostics");
      if (!res.ok) {
        throw new Error(`/api/diagnostics が ${res.status} を返しました`);
      }
      const report = (await res.json()) as DiagnosticsReport;
      this.diagnosticsOpen = true;
      this.view.renderDiagnostics(formatDiagnostics(report));
    } catch (error) {
      this.view.showToast(`診断情報を取得できませんでした: ${errorText(error)}`, "error");
    }
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "hello":
        this.applyHello(message);
        break;
      case "state":
        this.view.setState(message.state);
        break;
      case "history":
        this.view.renderHistory(message.messages);
        break;
      case "event":
        this.handleEvent(message.event);
        break;
      case "error":
        this.view.showToast(message.message, "error");
        break;
      case "pong":
        break;
    }
  }

  private applyHello(hello: HelloPayload): void {
    this.ws.helloReceived();
    this.view.setServicesText("");
    this.view.setNames(hello.character.name, hello.user);
    this.view.setCharacter(hello.character.name, hello.character.label);
    this.view.setVersion(hello.version);
    this.micLoop.configure(hello.audio);
    if (hello.audio.inputMode === "browser") {
      void this.micLoop.refreshDevices();
    }
    this.view.renderHistory(hello.history);
    this.view.renderServices(hello.services, hello.audio.inputMode);
    this.view.setState(hello.state);
  }

  private handleEvent(event: PipelineEvent): void {
    const view = this.view;
    switch (event.type) {
      case "state":
        view.setState(event.state);
        // 中断（停止ボタン等）で llm_complete が来なかった場合、途中までの吹き出しが残る。
        // そのままにすると次の応答が古い吹き出しへ追記されるため、ここで切り離す。
        view.discardStreamIfIdle(event.state);
        break;
      case "wakeword_detected":
        view.addSystemNote(`「${event.phrase}」で起動しました`);
        break;
      case "level":
        view.updateLevel(event.level, event.threshold);
        break;
      case "recording_started":
        view.setFace("🎤");
        break;
      case "recording_stopped":
        view.setFace("💭");
        view.resetLevel();
        break;
      case "stt_complete":
        view.addMessage("user", event.text);
        break;
      case "llm_delta":
        view.appendStreamChunk(event.content);
        break;
      case "llm_complete":
        view.finalizeStream(event.text);
        view.setFace("🌸");
        break;
      case "speaking_started":
        view.setFace("🗣️");
        // ブラウザ入力モードでは、再生中の割り込み（バージイン）をブラウザ側で監視する
        this.micLoop.startBargeMonitor();
        break;
      case "speaking_finished":
        view.setFace("🌸");
        break;
      case "barge_in":
        view.addSystemNote("発話を検出したため再生を中断しました");
        break;
      case "followup_wait":
        view.addSystemNote(
          `続けて話しかけてください（${event.turn}/${event.maxTurns}・${Math.round(
            event.timeoutMs / 1000
          )} 秒）`
        );
        break;
      case "history_updated":
        view.renderHistory(event.messages);
        break;
      case "turn_complete":
      case "turn_skipped":
        // turn_skipped はターンが成立していない（幻聴・エコー等）。待機を解いて聞き取りを続ける。
        // ここで待機を解かないとクライアントが「応答待ち」のまま固まる。
        this.micLoop.resolveTurn(true);
        break;
      case "error":
        this.micLoop.resolveTurn(false);
        view.showToast(event.message, "error");
        break;
      default:
        break;
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  new SumikaApp().start();
});

/** 診断レポートを 1 つのテキストへ整形する */
function formatDiagnostics(report: DiagnosticsReport): string {
  const skip = report.skips;
  const capture = report.capture
    ? `録音: ${report.capture.count} 回 / 直近 frames=${report.capture.lastFrames} peak=${report.capture.lastPeakLevel} reason=${report.capture.lastReason}`
    : "録音: サーバー録音モードでは未計測（ブラウザ入力では録音はクライアント側）";
  const lastSkip = report.lastSkip
    ? `直近の破棄: ${report.lastSkip.reason}「${report.lastSkip.text}」`
    : "直近の破棄: なし";
  const services = report.services;
  return [
    `状態: ${report.state}${report.busy ? "（応答中）" : ""}`,
    `サービス: LLM=${services.llm} TTS=${services.tts} STT=${services.stt}`,
    `破棄: 幻聴=${skip.hallucination} 短断片=${skip.short} エコー=${skip.echo} 繰り返し=${skip.repeat}`,
    lastSkip,
    capture,
    `音声: ${report.audio.input_mode} / しきい値=${report.audio.silence_threshold}（上限 ${report.audio.silence_threshold_max}） / 無音=${report.audio.silence_duration}s / 最大=${report.audio.max_record_seconds}s / バージイン=${report.audio.barge_in_enabled}`,
    report.warnings.length > 0 ? `設定の警告: ${report.warnings.join(" / ")}` : "設定の警告: なし",
  ].join("\n");
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error);
}
