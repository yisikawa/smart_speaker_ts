import type {
  AssistantState,
  ChatMessage,
  ClientCommand,
  HelloPayload,
  PipelineEvent,
  ServerMessage,
} from "../shared/protocol";

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
  private assistantName = "さくら";
  private userName = "あなた";
  private streaming: { element: HTMLElement; text: string } | null = null;

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
  private readonly inputEl = must<HTMLTextAreaElement>("textInput");
  private readonly toastEl = must<HTMLElement>("toast");

  start(): void {
    this.bindEvents();
    this.connect();
    this.setState("idle");
  }

  private bindEvents(): void {
    this.btnListen.addEventListener("click", () => this.send({ type: "start_listening" }));
    this.btnStop.addEventListener("click", () => this.send({ type: "stop_listening" }));
    this.btnClear.addEventListener("click", () => this.send({ type: "clear_history" }));
    this.btnSend.addEventListener("click", () => this.submitText());
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.submitText();
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
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
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
      this.setState("error");
      this.showToast("サーバーとの接続が切れました（再接続します）", "error");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // 再接続は onclose で処理する
    };
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
    this.assistantName = hello.character.name;
    this.userName = hello.user;
    this.nameEl.textContent = hello.character.name;
    this.labelEl.textContent = hello.character.label;
    this.versionEl.textContent = `v${hello.version}`;
    this.renderHistory(hello.history);
    this.renderServices(hello.services);
    this.setState(hello.state);
  }

  private renderServices(services: { llm: boolean; tts: boolean; stt: boolean }): void {
    const mark = (ok: boolean): string => (ok ? "🟢" : "🔴");
    this.servicesEl.textContent = `LLM ${mark(services.llm)}  TTS ${mark(services.tts)}  STT ${mark(
      services.stt
    )}`;
  }

  private handleEvent(event: PipelineEvent): void {
    switch (event.type) {
      case "state":
        this.setState(event.state);
        break;
      case "wakeword_detected":
        this.addSystemNote(`「${event.phrase}」で起動しました`);
        break;
      case "level": {
        const ratio = event.threshold > 0 ? Math.min(1, event.level / (event.threshold * 4)) : 0;
        this.levelFill.style.width = `${Math.round(Math.sqrt(ratio) * 100)}%`;
        this.levelHint.textContent = `レベル ${event.level.toFixed(3)} / しきい値 ${event.threshold.toFixed(3)}`;
        break;
      }
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
      case "error":
        this.showToast(event.message, "error");
        break;
      default:
        break;
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

document.addEventListener("DOMContentLoaded", () => {
  new SumikaApp().start();
});
