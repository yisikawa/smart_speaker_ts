import * as http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientCommand, ServerMessage, ServiceStatus } from "../../shared/protocol";
import { ConfigManager } from "../config/ConfigManager";
import { ConversationPipeline } from "../conversation/ConversationPipeline";
import { Logger } from "../core/logger";
import { CharacterService } from "../services/CharacterService";
import { AudioPayloadError, decodeAudioPayload } from "./audioPayload";

export interface WsHubDeps {
  server: http.Server;
  path?: string;
  pipeline: ConversationPipeline;
  config: ConfigManager;
  character: CharacterService;
  version: string;
  serviceStatus: () => ServiceStatus;
  heartbeatMs?: number;
}

const CLIENT_COMMANDS = new Set([
  "start_listening",
  "stop_listening",
  "submit_text",
  "submit_audio",
  "speak",
  "stop_speaking",
  "simulate_wakeword",
  "clear_history",
  "get_state",
  "ping",
]);

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

  constructor(private readonly deps: WsHubDeps) {
    this.logger = new Logger("WS");
    this.wss = new WebSocketServer({ server: deps.server, path: deps.path ?? "/ws" });

    this.wss.on("connection", (ws) => this.handleConnection(ws));
    this.wss.on("error", (error) => this.logger.error("WebSocket サーバーエラー", error));

    this.offPipeline = deps.pipeline.on((event) => {
      this.broadcast({ type: "event", event });
    });

    const interval = deps.heartbeatMs ?? 30000;
    this.heartbeat = setInterval(() => this.checkAlive(), interval);
    this.heartbeat.unref?.();
  }

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.alive.set(ws, true);
    this.logger.info(`クライアント接続 (${this.clients.size})`);

    ws.on("pong", () => this.alive.set(ws, true));

    const audioConfig = this.deps.config.getAudio();
    const conversationConfig = this.deps.config.getConversation();

    ws.send(
      JSON.stringify({
        type: "hello",
        state: this.deps.pipeline.getState(),
        history: this.deps.pipeline.getHistory(),
        character: {
          name: this.deps.character.get().name,
          label: this.deps.character.get().label,
        },
        user: this.deps.config.getGUI().user_name,
        version: this.deps.version,
        services: this.deps.serviceStatus(),
        audio: {
          inputMode: audioConfig.input_mode,
          sampleRate: audioConfig.sample_rate,
          noSpeechTimeoutMs: audioConfig.no_speech_timeout * 1000,
          followup: {
            enabled: conversationConfig.followup_enabled,
            maxTurns: conversationConfig.max_followup_turns,
            timeoutMs: conversationConfig.followup_timeout_seconds * 1000,
            guardMs: conversationConfig.followup_guard_ms,
          },
          bargeIn: {
            enabled: conversationConfig.barge_in_enabled,
            minScore: conversationConfig.barge_in_min_score,
          },
          silenceThreshold: audioConfig.silence_threshold,
          maxRecordMs: audioConfig.max_record_seconds * 1000,
          vad: {
            frameMs: audioConfig.frame_ms,
            preRollMs: audioConfig.pre_roll_ms,
            silenceDurationMs: audioConfig.silence_duration * 1000,
            smoothingAlpha: audioConfig.smoothing_alpha,
            relativeThresholdMultiplier: audioConfig.relative_threshold_multiplier,
            calibrationMs: audioConfig.calibration_duration * 1000,
            debounceFrames: audioConfig.debounce_frames,
            inputGain: audioConfig.input_gain,
          },
        },
      })
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
      if (!command || typeof command.type !== "string" || !CLIENT_COMMANDS.has(command.type)) {
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
    switch (command.type) {
      case "start_listening":
        void this.deps.pipeline.handleWakeWord("UI");
        break;
      case "stop_listening":
        this.deps.pipeline.stop();
        break;
      case "submit_text":
        void this.deps.pipeline.submitText(String(command.text ?? ""));
        break;
      case "submit_audio":
        this.handleSubmitAudio(ws, command);
        break;
      case "stop_speaking":
        this.deps.pipeline.stopSpeaking();
        break;
      case "speak":
        void this.deps.pipeline.speak(String(command.text ?? ""));
        break;
      case "simulate_wakeword":
        void this.deps.pipeline.handleWakeWord(command.phrase ?? "さくら");
        break;
      case "clear_history":
        this.deps.pipeline.clearHistory();
        ws.send(JSON.stringify({ type: "history", messages: [] }));
        break;
      case "get_state":
        ws.send(JSON.stringify({ type: "state", state: this.deps.pipeline.getState() }));
        ws.send(JSON.stringify({ type: "history", messages: this.deps.pipeline.getHistory() }));
        break;
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
    }
  }

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
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
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
