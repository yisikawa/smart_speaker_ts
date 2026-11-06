import type { ClientCommand, ServerMessage } from "../shared/protocol";

export interface WsHandlers {
  onOpen(): void;
  onMessage(message: ServerMessage): void;
  onClose(): void;
  /** hello が一定時間届かないとき（接続済みだが応答なし） */
  onHelloTimeout(): void;
}

/** 再接続の最大待ち時間（ms） */
const MAX_RECONNECT_DELAY_MS = 15000;
/** hello 待ちのタイムアウト（ms） */
const HELLO_TIMEOUT_MS = 5000;

/**
 * WebSocket の接続管理（接続・再接続・hello 待ち・コマンド送信）。
 * 画面描画やマイク制御は持たない。
 */
export class WsClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private helloTimer: number | null = null;

  constructor(private readonly handlers: WsHandlers) {}

  /** HTML を直接開いた場合など、接続できない環境か */
  get isUnsupportedEnvironment(): boolean {
    return window.location.protocol === "file:";
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.isUnsupportedEnvironment) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.startHelloTimer();
      this.handlers.onOpen();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        this.handlers.onMessage(JSON.parse(String(event.data)) as ServerMessage);
      } catch {
        console.warn("[WS] 解析できないメッセージを受信しました");
      }
    };

    this.ws.onclose = () => {
      this.clearHelloTimer();
      this.handlers.onClose();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // 再接続は onclose で処理する
    };
  }

  /** コマンドを送る。未接続なら false（呼び出し側がトーストを出す） */
  send(command: ClientCommand): boolean {
    if (!this.isOpen) {
      return false;
    }
    this.ws!.send(JSON.stringify(command));
    return true;
  }

  /** hello を受け取った（タイマーを止める） */
  helloReceived(): void {
    this.clearHelloTimer();
  }

  dispose(): void {
    this.clearHelloTimer();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHelloTimer(): void {
    this.clearHelloTimer();
    this.helloTimer = window.setTimeout(() => {
      this.helloTimer = null;
      this.handlers.onHelloTimeout();
    }, HELLO_TIMEOUT_MS);
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
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
