import type { AssistantState, ChatMessage, ServiceStatus } from "../shared/protocol";
import { must } from "./dom";

/** 状態 → 画面表示 */
const STATE_LABELS: Record<AssistantState, string> = {
  idle: "待機中",
  waiting_wakeword: "ウェイクワード待機中",
  recording: "聞き取り中…",
  transcribing: "音声を認識中…",
  thinking: "考え中…",
  speaking: "話しています…",
  error: "エラー",
};

/** 応答中とみなす状態（ボタン制御・ストリーム破棄の判定に使う） */
const BUSY_STATES: AssistantState[] = ["recording", "transcribing", "thinking", "speaking"];

/**
 * 画面（チャット・状態表示・レベルメーター・トースト）の描画を担当する。
 * 通信や録音の制御は持たない（`WsClient` / `MicLoop` / `app.ts` が担う）。
 */
export class ChatView {
  private assistantName = "さくら";
  private userName = "あなた";
  private streaming: { element: HTMLElement; text: string } | null = null;

  readonly conversationEl = must<HTMLElement>("conversation");
  readonly statusEl = must<HTMLElement>("status");
  readonly levelFill = must<HTMLElement>("levelFill");
  readonly levelHint = must<HTMLElement>("levelHint");
  readonly faceEl = must<HTMLElement>("characterFace");
  readonly nameEl = must<HTMLElement>("characterName");
  readonly labelEl = must<HTMLElement>("characterLabel");
  readonly servicesEl = must<HTMLElement>("services");
  readonly versionEl = must<HTMLElement>("version");
  readonly btnListen = must<HTMLButtonElement>("btnListen");
  readonly btnStop = must<HTMLButtonElement>("btnStop");
  readonly btnClear = must<HTMLButtonElement>("btnClear");
  readonly btnSend = must<HTMLButtonElement>("btnSend");
  readonly btnMicTest = must<HTMLButtonElement>("btnMicTest");
  readonly btnDiagnostics = must<HTMLButtonElement>("btnDiagnostics");
  readonly diagnosticsEl = must<HTMLElement>("diagnostics");
  readonly inputEl = must<HTMLTextAreaElement>("textInput");
  readonly deviceSelect = must<HTMLSelectElement>("inputDevice");
  readonly toastEl = must<HTMLElement>("toast");

  /** 表示名（hello で受け取る） */
  setNames(assistant: string, user: string): void {
    this.assistantName = assistant;
    this.userName = user;
  }

  setCharacter(name: string, label: string): void {
    this.nameEl.textContent = name;
    this.labelEl.textContent = label;
  }

  setVersion(version: string): void {
    this.versionEl.textContent = `v${version}`;
  }

  /** 接続状態のメッセージ（offline ならグレー表示） */
  setServicesText(text: string, offline = false): void {
    this.servicesEl.className = offline ? "services offline" : "services";
    this.servicesEl.textContent = text;
  }

  /** 依存サービスの疎通とマイク方式 */
  renderServices(services: ServiceStatus, inputMode: string): void {
    const mark = (ok: boolean): string => (ok ? "🟢" : "🔴");
    const mode = inputMode === "browser" ? "マイク: ブラウザ" : "マイク: サーバー";
    this.setServicesText(
      `LLM ${mark(services.llm)}  TTS ${mark(services.tts)}  STT ${mark(services.stt)}  /  ${mode}`
    );
  }

  setState(state: AssistantState): void {
    this.statusEl.className = `status ${state}`;
    this.statusEl.textContent = STATE_LABELS[state] ?? state;

    const busy = BUSY_STATES.includes(state);
    this.btnListen.disabled = busy;
    this.btnStop.disabled = !busy;
  }

  /** 状態が応答中でなくなったとき、途中までの吹き出しを切り離す（次ターンの追記を防ぐ） */
  discardStreamIfIdle(state: AssistantState): void {
    if (!BUSY_STATES.includes(state)) {
      this.streaming = null;
    }
  }

  setFace(text: string): void {
    this.faceEl.textContent = text;
  }

  updateLevel(level: number, threshold: number): void {
    const ratio = threshold > 0 ? Math.min(1, level / (threshold * 4)) : 0;
    this.levelFill.style.width = `${Math.round(Math.sqrt(ratio) * 100)}%`;
    this.levelHint.textContent = `レベル ${level.toFixed(3)} / しきい値 ${threshold.toFixed(3)}`;
  }

  resetLevel(): void {
    this.levelFill.style.width = "0%";
  }

  renderHistory(messages: ChatMessage[]): void {
    this.conversationEl.innerHTML = "";
    this.streaming = null;
    for (const message of messages) {
      this.addMessage(message.role, message.content);
    }
  }

  /** 1 件の吹き出しを追加する（role に応じて表示名を切り替える） */
  addMessage(role: "user" | "assistant", text: string): void {
    const name = role === "user" ? this.userName : this.assistantName;
    this.createBubble(role, name).textElement.textContent = text;
    this.scrollToBottom();
  }

  /** LLM の差分を「追記」していく（旧実装は上書きしていた） */
  appendStreamChunk(chunk: string): void {
    if (!this.streaming) {
      const bubble = this.createBubble("assistant", this.assistantName);
      this.streaming = { element: bubble.textElement, text: "" };
    }
    this.streaming.text += chunk;
    this.streaming.element.textContent = this.streaming.text;
    this.scrollToBottom();
  }

  finalizeStream(text: string): void {
    if (!this.streaming) {
      if (text.trim()) {
        this.addMessage("assistant", text);
      }
      return;
    }
    this.streaming.element.textContent = text;
    this.streaming = null;
    this.scrollToBottom();
  }

  addSystemNote(text: string): void {
    const note = document.createElement("div");
    note.className = "system-note";
    note.textContent = text;
    this.conversationEl.appendChild(note);
    this.scrollToBottom();
  }

  showToast(message: string, type: "info" | "error" = "info"): void {
    this.toastEl.textContent = message;
    this.toastEl.className = `toast ${type}`;
    window.setTimeout(() => {
      this.toastEl.className = "toast hidden";
    }, 3500);
  }

  /** 診断情報を表示する（null なら非表示） */
  renderDiagnostics(text: string | null): void {
    this.diagnosticsEl.textContent = text ?? "";
    this.diagnosticsEl.className = text ? "diagnostics" : "diagnostics hidden";
  }

  /** マイク一覧をセレクトへ反映する */
  setDeviceOptions(devices: { id: string; label: string }[], current: string): void {
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

  private scrollToBottom(): void {
    this.conversationEl.scrollTop = this.conversationEl.scrollHeight;
  }
}
