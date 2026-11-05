import type {
  AssistantState,
  ChatMessage,
  ClientCommand,
  HelloPayload,
  PipelineEvent,
  ServerMessage,
} from "../shared/protocol";
import { BrowserMic, BrowserMicError } from "./mic";
import type { ListenResult } from "./mic";

const STATE_LABELS: Record<AssistantState, string> = {
  idle: "待機中",
  waiting_wakeword: "ウェイクワード待機中",
  recording: "聞き取り中…",
  transcribing: "音声を認識中…",
  thinking: "考え中…",
  speaking: "話しています…",
  error: "エラー",
};

const BUSY_STATES: AssistantState[] = ["recording", "transcribing", "thinking", "speaking"];

class SumikaApp {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private helloTimer: number | null = null;
  private assistantName = "さくら";
  private userName = "あなた";
  private streaming: { element: HTMLElement; text: string } | null = null;
  private audioConfig: HelloPayload["audio"] | null = null;
  private mic: BrowserMic | null = null;
  private micLoopRunning = false;
  private micLoopActive = false;
  private bargeMonitorActive = false;
  private pendingBarge: string | null = null;
  private turnWaiter: ((completed: boolean) => void) | null = null;

  private readonly conversationEl = must<HTMLElement>("conversation");
  private readonly statusEl = must<HTMLElement>("status");
  private readonly levelFill = must<HTMLElement>("levelFill");
  private readonly levelHint = must<HTMLElement>("levelHint");
  private readonly faceEl = must<HTMLElement>("characterFace");
  private readonly nameEl = must<HTMLElement>("characterName");
  private readonly labelEl = must<HTMLElement>("characterLabel");
  private readonly servicesEl = must<HTMLElement>("services");
  private readonly versionEl = must<HTMLElement>("version");
  private readonly btnListen = must<HTMLButtonElement>("btnListen");
  private readonly btnStop = must<HTMLButtonElement>("btnStop");
  private readonly btnClear = must<HTMLButtonElement>("btnClear");
  private readonly btnSend = must<HTMLButtonElement>("btnSend");
  private readonly btnMicTest = must<HTMLButtonElement>("btnMicTest");
  private readonly inputEl = must<HTMLTextAreaElement>("textInput");
  private readonly deviceSelect = must<HTMLSelectElement>("inputDevice");
  private readonly toastEl = must<HTMLElement>("toast");

  start(): void {
    this.bindEvents();
    // connect() より先に初期状態を設定する（未接続時の表示を上書きしないため）
    this.setState("idle");
    this.connect();
  }

  private bindEvents(): void {
    this.btnListen.addEventListener("click", () => {
      // ブラウザ入力モードでは、この画面がマイクを開いて発話単位で送信する
      if (this.isBrowserMode()) {
        void this.startMicLoop();
        return;
      }
      this.send({ type: "start_listening" });
    });
    this.btnStop.addEventListener("click", () => {
      this.stopMicLoop();
      this.send({ type: "stop_listening" });
    });
    this.btnClear.addEventListener("click", () => this.send({ type: "clear_history" }));
    this.btnSend.addEventListener("click", () => this.submitText());
    this.btnMicTest.addEventListener("click", () => {
      void this.checkMic();
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.submitText();
      }
    });
    this.deviceSelect.addEventListener("change", () => {
      if (this.isBrowserMode()) {
        void this.switchDevice();
      }
    });
  }

  private submitText(): void {
    const text = this.inputEl.value.trim();
    if (!text) {
      return;
    }
    this.send({ type: "submit_text", text });
    this.inputEl.value = "";
  }

  private connect(): void {
    // start.bat を使わずに HTML を直接開いた場合は WebSocket を張れないため、明示する
    if (window.location.protocol === "file:") {
      this.servicesEl.className = "services offline";
      this.servicesEl.textContent = "未接続（start.bat で起動し http://localhost:3000 を開いてください）";
      this.statusEl.className = "status error";
      this.statusEl.textContent = "未接続";
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.servicesEl.className = "services";
      this.servicesEl.textContent = "接続済み（状態を取得中…）";
      this.startHelloTimer();
      this.showToast("サーバーに接続しました", "info");
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        this.handleMessage(JSON.parse(String(event.data)) as ServerMessage);
      } catch {
        console.warn("[WS] 解析できないメッセージを受信しました");
      }
    };

    this.ws.onclose = () => {
      this.clearHelloTimer();
      this.servicesEl.className = "services offline";
      this.servicesEl.textContent = "サーバー未接続（再接続中…）";
      this.setState("error");
      this.showToast("サーバーとの接続が切れました（再接続します）", "error");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // 再接続は onclose で処理する
    };
  }

  /** hello が一定時間届かない場合は「接続済みだが応答なし」と表示する */
  private startHelloTimer(): void {
    this.clearHelloTimer();
    this.helloTimer = window.setTimeout(() => {
      this.helloTimer = null;
      if (this.servicesEl.textContent?.startsWith("接続済み")) {
        this.servicesEl.className = "services offline";
        this.servicesEl.textContent = "サーバーの応答がありません（ページを再読み込みしてください）";
      }
    }, 5000);
  }

  private clearHelloTimer(): void {
    if (this.helloTimer !== null) {
      window.clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 10);
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 15000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(command: ClientCommand): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.showToast("サーバーに接続されていません", "error");
      return;
    }
    this.ws.send(JSON.stringify(command));
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "hello":
        this.applyHello(message);
        break;
      case "state":
        this.setState(message.state);
        break;
      case "history":
        this.renderHistory(message.messages);
        break;
      case "event":
        this.handleEvent(message.event);
        break;
      case "error":
        this.showToast(message.message, "error");
        break;
      case "pong":
        break;
    }
  }

  private applyHello(hello: HelloPayload): void {
    this.clearHelloTimer();
    this.servicesEl.className = "services";
    this.assistantName = hello.character.name;
    this.userName = hello.user;
    this.nameEl.textContent = hello.character.name;
    this.labelEl.textContent = hello.character.label;
    this.versionEl.textContent = `v${hello.version}`;
    this.audioConfig = hello.audio;
    this.mic = new BrowserMic(hello.audio);
    if (hello.audio.inputMode === "browser") {
      void this.refreshDevices();
    } else {
      this.deviceSelect.disabled = true;
    }
    this.renderHistory(hello.history);
    this.renderServices(hello.services);
    this.setState(hello.state);
  }

  private renderServices(services: { llm: boolean; tts: boolean; stt: boolean }): void {
    const mark = (ok: boolean): string => (ok ? "🟢" : "🔴");
    const mode = this.audioConfig?.inputMode === "browser" ? "マイク: ブラウザ" : "マイク: サーバー";
    this.servicesEl.textContent = `LLM ${mark(services.llm)}  TTS ${mark(services.tts)}  STT ${mark(
      services.stt
    )}  /  ${mode}`;
  }

  private handleEvent(event: PipelineEvent): void {
    switch (event.type) {
      case "state":
        this.setState(event.state);
        break;
      case "wakeword_detected":
        this.addSystemNote(`「${event.phrase}」で起動しました`);
        break;
      case "level":
        this.updateLevel(event.level, event.threshold);
        break;
      case "recording_started":
        this.faceEl.textContent = "🎤";
        break;
      case "recording_stopped":
        this.faceEl.textContent = "💭";
        this.levelFill.style.width = "0%";
        break;
      case "stt_complete":
        this.addMessage("user", this.userName, event.text);
        break;
      case "llm_delta":
        this.appendStreamChunk(event.content);
        break;
      case "llm_complete":
        this.finalizeStream(event.text);
        this.faceEl.textContent = "🌸";
        break;
      case "speaking_started":
        this.faceEl.textContent = "🗣️";
        // ブラウザ入力モードでは、再生中の割り込み（バージイン）をブラウザ側で監視する
        this.startBargeMonitor();
        break;
      case "speaking_finished":
        this.faceEl.textContent = "🌸";
        break;
      case "barge_in":
        this.addSystemNote("発話を検出したため再生を中断しました");
        break;
      case "followup_wait":
        this.addSystemNote(
          `続けて話しかけてください（${event.turn}/${event.maxTurns}・${Math.round(
            event.timeoutMs / 1000
          )} 秒）`
        );
        break;
      case "history_updated":
        this.renderHistory(event.messages);
        break;
      case "turn_complete":
        this.resolveTurn(true);
        break;
      case "error":
        this.resolveTurn(false);
        this.showToast(event.message, "error");
        break;
      default:
        break;
    }
  }

  private isBrowserMode(): boolean {
    return this.audioConfig?.inputMode === "browser";
  }

  private async refreshDevices(): Promise<void> {
    if (!this.mic || !this.isBrowserMode()) {
      return;
    }
    try {
      const devices = await this.mic.listDevices();
      const current = this.deviceSelect.value;
      this.deviceSelect.innerHTML = "";
      const auto = document.createElement("option");
      auto.value = "";
      auto.textContent = "既定のマイク";
      this.deviceSelect.appendChild(auto);
      for (const device of devices) {
        const option = document.createElement("option");
        option.value = device.id;
        option.textContent = device.label;
        this.deviceSelect.appendChild(option);
      }
      if (current) {
        this.deviceSelect.value = current;
      }
    } catch {
      // 一覧が取れなくても既定デバイスで録音は可能
    }
  }

  private async switchDevice(): Promise<void> {
    if (!this.mic) {
      return;
    }
    try {
      await this.mic.start(this.deviceSelect.value || undefined);
      this.showToast("マイクを切り替えました", "info");
      await this.refreshDevices();
    } catch (error) {
      this.showToast(
        error instanceof BrowserMicError ? error.message : String((error as Error)?.message ?? error),
        "error"
      );
    }
  }

  /** ブラウザ録音のターンループ（聞き取り → 送信 → 応答待ち → フォローアップ） */
  private async startMicLoop(): Promise<void> {
    const cfg = this.audioConfig;
    if (!cfg || cfg.inputMode !== "browser" || this.micLoopRunning) {
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.showToast("サーバーに接続されていません", "error");
      return;
    }

    this.micLoopRunning = true;
    this.micLoopActive = true;
    try {
      if (!this.mic) {
        this.mic = new BrowserMic(cfg);
      }
      await this.mic.start(this.deviceSelect.value || undefined);
      await this.refreshDevices();

      let followup = 0;
      while (this.micLoopActive) {
        let wav = this.pendingBarge;
        this.pendingBarge = null;

        if (!wav) {
          if (followup > 0) {
            await delay(cfg.followup.guardMs);
            if (!this.micLoopActive) {
              break;
            }
          }
          this.setState("recording");
          const result = await this.mic.listen({
            startTimeoutMs: followup > 0 ? cfg.followup.timeoutMs : cfg.noSpeechTimeoutMs,
            maxDurationMs: cfg.maxRecordMs,
            onLevel: (level, threshold) => this.updateLevel(level, threshold),
          });
          this.levelFill.style.width = "0%";
          if (!this.micLoopActive) {
            break;
          }
          if (!result.wavBase64) {
            this.reportEmptyCapture(result);
            break;
          }
          wav = result.wavBase64;
        }

        this.send({ type: "submit_audio", format: "wav", sampleRate: cfg.sampleRate, data: wav });
        this.setState("transcribing");
        const completed = await this.waitForTurn();
        if (!this.micLoopActive || !completed) {
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
          this.addSystemNote(
            `続けて話しかけてください（${followup}/${cfg.followup.maxTurns}・${Math.round(
              cfg.followup.timeoutMs / 1000
            )} 秒）`
          );
        }
      }
    } catch (error) {
      const message =
        error instanceof BrowserMicError ? error.message : String((error as Error)?.message ?? error);
      this.showToast(message, "error");
      this.servicesEl.className = "services offline";
    } finally {
      this.micLoopRunning = false;
      this.micLoopActive = false;
      this.mic?.stop("aborted");
      this.setState("idle");
    }
  }

  private stopMicLoop(): void {
    this.micLoopActive = false;
    this.mic?.stop("aborted");
    this.resolveTurn(false);
  }

  /** 発話が取れなかった原因をユーザーへ伝える */
  private reportEmptyCapture(result: ListenResult): void {
    const cfg = this.audioConfig;
    if (!cfg) {
      return;
    }
    if (result.frames === 0) {
      this.showToast(
        "マイクから音声データが届きませんでした（マイクの許可・接続を確認してください）",
        "error"
      );
    } else if (result.peakLevel < cfg.silenceThreshold * 0.5) {
      this.showToast(
        "マイクの入力レベルがほぼ 0 です（ミュート／Windows の入力レベルを確認してください）",
        "error"
      );
    }
  }

  /** 再生中の割り込みを監視し、発話があれば再生停止＋次ターンの入力にする */
  private startBargeMonitor(): void {
    const cfg = this.audioConfig;
    if (!cfg || cfg.inputMode !== "browser" || !cfg.bargeIn.enabled) {
      return;
    }
    if (!this.mic?.isRunning || !this.micLoopActive || this.bargeMonitorActive) {
      return;
    }
    this.bargeMonitorActive = true;
    void this.mic
      .listen({
        startTimeoutMs: cfg.maxRecordMs,
        maxDurationMs: cfg.maxRecordMs,
        threshold: Math.max(cfg.silenceThreshold, cfg.bargeIn.minScore),
        onSpeechStart: () => this.send({ type: "stop_speaking" }),
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

  private waitForTurn(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const finish = (completed: boolean): void => {
        if (this.turnWaiter === finish) {
          this.turnWaiter = null;
          resolve(completed);
        }
      };
      this.turnWaiter = finish;
      window.setTimeout(() => finish(false), 180000);
    });
  }

  private resolveTurn(completed: boolean): void {
    this.turnWaiter?.(completed);
  }

  private updateLevel(level: number, threshold: number): void {
    const ratio = threshold > 0 ? Math.min(1, level / (threshold * 4)) : 0;
    this.levelFill.style.width = `${Math.round(Math.sqrt(ratio) * 100)}%`;
    this.levelHint.textContent = `レベル ${level.toFixed(3)} / しきい値 ${threshold.toFixed(3)}`;
  }

  /** マイク入力を 5 秒だけ確認する（送信はしない） */
  private async checkMic(): Promise<void> {
    const cfg = this.audioConfig;
    if (!cfg || cfg.inputMode !== "browser" || !this.mic) {
      this.showToast("マイク確認はブラウザ入力モードのみ対応しています", "error");
      return;
    }
    if (this.micLoopRunning) {
      this.showToast("聞き取り中は実行できません。先に停止してください", "error");
      return;
    }
    try {
      await this.mic.start(this.deviceSelect.value || undefined);
      await this.refreshDevices();
      this.showToast("5 秒間マイクを確認します。話しかけてください", "info");
      const result = await this.mic.listen({
        startTimeoutMs: 5000,
        maxDurationMs: 5000,
        onLevel: (level, threshold) => this.updateLevel(level, threshold),
      });
      const dbfs = result.peakLevel > 0 ? (20 * Math.log10(result.peakLevel)).toFixed(1) : "-∞";
      if (result.frames === 0) {
        this.showToast("音声データが届きません（マイクの許可・接続を確認してください）", "error");
      } else if (result.peakLevel < cfg.silenceThreshold * 0.5) {
        this.showToast(
          `ほぼ無音でした（frames=${result.frames} / peak=${result.peakLevel}）。マイク選択を確認してください`,
          "error"
        );
      } else {
        this.showToast(
          `マイクOK: peak ${result.peakLevel.toFixed(3)}（${dbfs} dBFS）/ ${result.frames} フレーム`,
          "info"
        );
      }
    } catch (error) {
      this.showToast(
        error instanceof BrowserMicError ? error.message : String((error as Error)?.message ?? error),
        "error"
      );
    } finally {
      this.levelFill.style.width = "0%";
    }
  }

  private setState(state: AssistantState): void {
    this.statusEl.className = `status ${state}`;
    this.statusEl.textContent = STATE_LABELS[state] ?? state;

    const busy = BUSY_STATES.includes(state);
    this.btnListen.disabled = busy;
    this.btnStop.disabled = !busy;
  }

  private renderHistory(messages: ChatMessage[]): void {
    this.conversationEl.innerHTML = "";
    this.streaming = null;
    for (const message of messages) {
      this.addMessage(
        message.role,
        message.role === "user" ? this.userName : this.assistantName,
        message.content
      );
    }
  }

  /** LLM の差分を「追記」していく（旧実装は上書きしていた） */
  private appendStreamChunk(chunk: string): void {
    if (!this.streaming) {
      const bubble = this.createBubble("assistant", this.assistantName);
      this.streaming = { element: bubble.textElement, text: "" };
    }
    this.streaming.text += chunk;
    this.streaming.element.textContent = this.streaming.text;
    this.scrollToBottom();
  }

  private finalizeStream(text: string): void {
    if (!this.streaming) {
      if (text.trim()) {
        this.addMessage("assistant", this.assistantName, text);
      }
      return;
    }
    this.streaming.element.textContent = text;
    this.streaming = null;
    this.scrollToBottom();
  }

  private addMessage(role: "user" | "assistant", name: string, text: string): void {
    this.createBubble(role, name).textElement.textContent = text;
    this.scrollToBottom();
  }

  private createBubble(
    role: "user" | "assistant",
    name: string
  ): { wrapper: HTMLElement; textElement: HTMLElement } {
    const wrapper = document.createElement("div");
    wrapper.className = `message ${role}`;

    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = name;

    const body = document.createElement("div");
    body.className = "message-text";

    wrapper.append(meta, body);
    this.conversationEl.appendChild(wrapper);
    return { wrapper, textElement: body };
  }

  private addSystemNote(text: string): void {
    const note = document.createElement("div");
    note.className = "system-note";
    note.textContent = text;
    this.conversationEl.appendChild(note);
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    this.conversationEl.scrollTop = this.conversationEl.scrollHeight;
  }

  private showToast(message: string, type: "info" | "error" = "info"): void {
    this.toastEl.textContent = message;
    this.toastEl.className = `toast ${type}`;
    window.setTimeout(() => {
      this.toastEl.className = "toast hidden";
    }, 3500);
  }
}

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`要素が見つかりません: #${id}`);
  }
  return element as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

document.addEventListener("DOMContentLoaded", () => {
  new SumikaApp().start();
});
