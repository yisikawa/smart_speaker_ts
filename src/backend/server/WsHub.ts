import * as http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { AvatarModelInfo } from "../../shared/avatar/modelCatalog";
import type { ClientCommand, ModelSelection, ServerMessage, ServiceStatus } from "../../shared/protocol";
import { ConfigManager } from "../config/ConfigManager";
import { ConversationPipeline } from "../conversation/ConversationPipeline";
import { Logger } from "../core/logger";
import { CharacterService } from "../services/CharacterService";
import { listAvatarModels } from "../services/avatarCatalog";
import { AudioPayloadError, decodeAudioPayload } from "./audioPayload";
import { buildAvatarPayload } from "./avatarPayload";
import type { ClientIdentity, ClientRole } from "./clientRole";
import { parseClientRole, pickPrimaryClientId } from "./clientRole";
import { buildHelloPayload } from "./helloPayload";

export interface WsHubDeps {
  server: http.Server;
  path?: string;
  pipeline: ConversationPipeline;
  config: ConfigManager;
  character: CharacterService;
  version: string;
  serviceStatus: () => ServiceStatus;
  /** 現在選択中のモデル（hello の表示用） */
  models: () => ModelSelection;
  /** クライアントの再生完了通知を sink へ渡す */
  onAudioPlaybackDone?: (utteranceId: string) => void;
  heartbeatMs?: number;
}

/**
 * WebSocket ハブ。
 * パイプラインイベントの配信と、クライアントコマンドの検証・振り分けを担当する。
 */
export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private readonly logger: Logger;
  private heartbeat: NodeJS.Timeout;
  private readonly offPipeline: () => void;
  private nextClientId = 0;
  private readonly clientIds = new WeakMap<WebSocket, string>();
  private readonly clientRoles = new WeakMap<WebSocket, ClientRole>();
  private primaryId: string | null = null;

  constructor(private readonly deps: WsHubDeps) {
    this.logger = new Logger("WS");
    this.wss = new WebSocketServer({ server: deps.server, path: deps.path ?? "/ws" });

    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req.url ?? undefined));
    this.wss.on("error", (error) => this.logger.error("WebSocket サーバーエラー", error));

    this.offPipeline = deps.pipeline.on((event) => {
      this.broadcast({ type: "event", event });
    });

    const interval = deps.heartbeatMs ?? 30000;
    this.heartbeat = setInterval(() => this.checkAlive(), interval);
    this.heartbeat.unref?.();
  }

  private handleConnection(ws: WebSocket, url?: string): void {
    this.clients.add(ws);
    this.alive.set(ws, true);
    const id = `c${++this.nextClientId}`;
    this.clientIds.set(ws, id);
    this.clientRoles.set(ws, parseClientRole(url));
    this.refreshPrimary();
    this.logger.info(`クライアント接続 (${this.clients.size})`);

    ws.on("pong", () => this.alive.set(ws, true));
    ws.on("close", () => {
      this.clients.delete(ws);
      this.refreshPrimary();
    });

    const audioConfig = this.deps.config.getAudio();
    const conversationConfig = this.deps.config.getConversation();
    const language = conversationConfig.language;
    const character = this.deps.character.get(language);

    ws.send(
      JSON.stringify(
        buildHelloPayload({
          state: this.deps.pipeline.getState(),
          history: this.deps.pipeline.getHistory(),
          character: { name: character.name, label: character.label },
          language,
          user: this.deps.config.getGUI().user_name,
          version: this.deps.version,
          services: this.deps.serviceStatus(),
          models: this.deps.models(),
          avatar: buildAvatarPayload(this.deps.config.getAvatar(), this.avatarModels()),
          isPrimary: this.clientIds.get(ws) === this.primaryId,
          audio: audioConfig,
          conversation: conversationConfig,
        })
      )
    );

    ws.on("message", (data: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        this.logger.warn("JSON でないメッセージを無視しました");
        return;
      }
      const command = parsed as ClientCommand;
      if (!command || typeof command.type !== "string" || !this.commandHandlers[command.type]) {
        ws.send(JSON.stringify({ type: "error", message: `不明なコマンドです: ${String((parsed as { type?: string })?.type)}` }));
        return;
      }
      this.handleCommand(ws, command);
    });

    ws.on("close", () => {
      this.clients.delete(ws);
      this.logger.info(`クライアント切断 (${this.clients.size})`);
    });

    ws.on("error", (error) => {
      this.logger.warn("クライアントエラー", error);
      this.clients.delete(ws);
    });
  }

  private handleCommand(ws: WebSocket, command: ClientCommand): void {
    const handler = this.commandHandlers[command.type] as
      | ((cmd: ClientCommand, socket: WebSocket) => void)
      | undefined;
    if (!handler) {
      ws.send(JSON.stringify({ type: "error", message: `不明なコマンドです: ${String(command.type)}` }));
      return;
    }
    handler(command, ws);
  }

  /**
   * コマンドの振り分け表。
   *
   * `ClientCommand` の判別共用体をキーにした完全なマップなので、
   * コマンドを追加すると **ここに実装しない限りコンパイルエラー**になる（検証漏れが起きない）。
   */
  private readonly commandHandlers: {
    [K in ClientCommand["type"]]: (
      command: Extract<ClientCommand, { type: K }>,
      ws: WebSocket
    ) => void;
  } = {
    start_listening: () => {
      void this.deps.pipeline.handleWakeWord("UI");
    },
    stop_listening: () => {
      this.deps.pipeline.stop();
    },
    submit_text: (command) => {
      void this.deps.pipeline.submitText(String(command.text ?? ""));
    },
    submit_audio: (command, ws) => {
      this.handleSubmitAudio(ws, command);
    },
    stop_speaking: () => {
      this.deps.pipeline.stopSpeaking();
    },
    speak: (command) => {
      void this.deps.pipeline.speak(String(command.text ?? ""));
    },
    simulate_wakeword: (command) => {
      void this.deps.pipeline.handleWakeWord(command.phrase ?? "さくら");
    },
    clear_history: (_command, ws) => {
      this.deps.pipeline.clearHistory();
      ws.send(JSON.stringify({ type: "history", messages: [] }));
    },
    get_state: (_command, ws) => {
      ws.send(JSON.stringify({ type: "state", state: this.deps.pipeline.getState() }));
      ws.send(JSON.stringify({ type: "history", messages: this.deps.pipeline.getHistory() }));
    },
    ping: (_command, ws) => {
      ws.send(JSON.stringify({ type: "pong" }));
    },
    audio_playback_done: (command) => {
      this.deps.onAudioPlaybackDone?.(command.utteranceId);
    },
  };

  private handleSubmitAudio(
    ws: WebSocket,
    command: Extract<ClientCommand, { type: "submit_audio" }>
  ): void {
    if (command.format !== "wav") {
      ws.send(JSON.stringify({ type: "error", message: `未対応の音声形式です: ${String(command.format)}` }));
      return;
    }
    try {
      const decoded = decodeAudioPayload(command.data);
      const expected = this.deps.config.getAudio().sample_rate;
      if (decoded.sampleRate !== expected) {
        this.logger.warn(`音声のサンプリングレートが ${decoded.sampleRate}Hz です（想定 ${expected}Hz）`);
      }
      if (decoded.durationMs <= 0) {
        ws.send(JSON.stringify({ type: "error", message: "音声が空でした。もう一度お話しください。" }));
        return;
      }
      this.logger.info(
        `ブラウザから音声を受信: ${decoded.durationMs}ms / ${decoded.buffer.length} bytes / ${decoded.sampleRate}Hz`
      );
      void this.deps.pipeline.submitAudio(decoded.buffer);
    } catch (error) {
      const message =
        error instanceof AudioPayloadError ? error.message : "音声データを処理できませんでした";
      this.logger.warn(`音声データの受信に失敗: ${message}`);
      ws.send(JSON.stringify({ type: "error", message }));
    }
  }

  broadcast(message: ServerMessage): void {
    if (message.type === "event" && message.event.type === "tts_audio") {
      this.sendToPrimary(message);
      return;
    }
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /** primary（音声を鳴らす担当）にだけ送る。送れたら true */
  sendToPrimary(message: ServerMessage): boolean {
    const target = [...this.clients].find(
      (client) => this.clientIds.get(client) === this.primaryId && client.readyState === WebSocket.OPEN
    );
    if (!target) {
      return false;
    }
    target.send(JSON.stringify(message));
    return true;
  }

  /** 音声を鳴らせるクライアントが接続しているか */
  hasPrimaryClient(): boolean {
    if (!this.primaryId) {
      return false;
    }
    return [...this.clients].some(
      (client) => this.clientIds.get(client) === this.primaryId && client.readyState === WebSocket.OPEN
    );
  }

  /** 接続中のクライアントから primary を選び直す（display 優先） */
  private refreshPrimary(): void {
    const identities: ClientIdentity[] = [];
    for (const client of this.clients) {
      const id = this.clientIds.get(client);
      if (id && client.readyState === WebSocket.OPEN) {
        identities.push({ id, role: this.clientRoles.get(client) ?? "control" });
      }
    }
    this.primaryId = pickPrimaryClientId(identities);
  }

  /** アバターのモデル候補（毎回の走査は軽い。失敗しても hello は返す） */
  private avatarModels(): AvatarModelInfo[] {
    try {
      return listAvatarModels(this.deps.config.rootDir);
    } catch (error) {
      this.logger.warn("アバターモデルの列挙に失敗しました", error);
      return [];
    }
  }

  private checkAlive(): void {
    for (const client of this.clients) {
      if (this.alive.get(client) === false) {
        this.logger.warn("応答のないクライアントを切断します");
        client.terminate();
        this.clients.delete(client);
        continue;
      }
      this.alive.set(client, false);
      try {
        client.ping();
      } catch {
        // ping 失敗は無視（close イベントで掃除される）
      }
    }
  }

  async dispose(): Promise<void> {
    clearInterval(this.heartbeat);
    this.offPipeline();
    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // 無視
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
