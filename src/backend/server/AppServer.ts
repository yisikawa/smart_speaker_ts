import express, { Express, NextFunction, Request, Response } from "express";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import type { ServiceStatus } from "../../shared/protocol";
import { ConfigManager } from "../config/ConfigManager";
import { ConversationPipeline } from "../conversation/ConversationPipeline";
import { Logger } from "../core/logger";
import { AudioIO, LanguageModel, SpeechToText, TextToSpeech } from "../core/ports";
import { CharacterService } from "../services/CharacterService";
import { createApiRouter } from "./ApiRouter";
import { ServiceMonitor } from "./ServiceMonitor";
import { WsHub } from "./WsHub";

// 型定義パッケージ（@types/cors）への依存を避けるため require で読み込む
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cors = require("cors") as () => express.RequestHandler;

export interface AppServerDeps {
  config: ConfigManager;
  pipeline: ConversationPipeline;
  audio: AudioIO;
  llm: LanguageModel;
  stt: SpeechToText;
  tts: TextToSpeech;
  character: CharacterService;
  logger: Logger;
  version: string;
  port: number;
  /** 静的ファイル配信ディレクトリ（存在するものだけ使う） */
  frontendDirs: string[];
}

/** HTTP + WebSocket サーバー。DI されたサービス群を配線するだけの薄い層。 */
export class AppServer {
  private readonly app: Express;
  private readonly server: http.Server;
  private readonly logger: Logger;
  private readonly startedAt = Date.now();
  private hub: WsHub | null = null;
  /** 依存サービスの疎通（定期更新） */
  private readonly services: ServiceMonitor;

  constructor(private readonly deps: AppServerDeps) {
    this.logger = deps.logger ?? new Logger("Server");
    this.services = new ServiceMonitor({
      llm: deps.llm,
      tts: deps.tts,
      stt: deps.stt,
      logger: this.logger,
    });
    this.app = express();
    this.app.disable("x-powered-by");
    this.app.use(cors());
    this.app.use(express.json({ limit: "1mb" }));

    this.mountStatic();
    this.app.use(
      "/api",
      createApiRouter({
        config: deps.config,
        pipeline: deps.pipeline,
        audio: deps.audio,
        character: deps.character,
        serviceMonitor: this.services,
        version: deps.version,
        startedAt: this.startedAt,
      })
    );

    // 404（API 以外）は JSON で返す
    this.app.use((req, res) => {
      res.status(404).json({ error: `見つかりません: ${req.method} ${req.path}` });
    });

    this.app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
      this.logger.error("リクエスト処理でエラー", error);
      if (res.headersSent) {
        return;
      }
      res.status(500).json({ error: error.message });
    });

    this.server = http.createServer(this.app);
  }

  private mountStatic(): void {
    const dirs = this.deps.frontendDirs.filter((dir) => fs.existsSync(dir));
    for (const dir of dirs) {
      this.app.use(
        express.static(dir, {
          etag: false,
          lastModified: false,
          setHeaders: (res) => {
            // ビルドし直した JS/CSS をブラウザがキャッシュしないようにする
            res.setHeader("Cache-Control", "no-store");
          },
        })
      );
    }

    this.app.get("/", (_req, res) => {
      const index = dirs.map((dir) => path.join(dir, "index.html")).find((file) => fs.existsSync(file));
      if (index) {
        res.sendFile(index);
        return;
      }
      res.status(404).send("UI が見つかりません。`npm run build` を実行してください。");
    });

    if (dirs.length === 0) {
      this.logger.warn("フロントエンドのディレクトリが見つかりません（npm run build を実行してください）");
    }
  }

  /** WsHub の hello で使うサービス疎通状態（直近の定期確認結果） */
  serviceStatus(): ServiceStatus {
    return this.services.current;
  }

  async start(): Promise<void> {
    this.services.start();

    this.hub = new WsHub({
      server: this.server,
      pipeline: this.deps.pipeline,
      config: this.deps.config,
      character: this.deps.character,
      version: this.deps.version,
      serviceStatus: () => this.services.current,
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.removeListener("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.deps.port);
    });

    this.logger.info(`HTTP + WebSocket サーバー起動: http://localhost:${this.deps.port}`);
  }

  async stop(): Promise<void> {
    this.services.stop();
    if (this.hub) {
      await this.hub.dispose();
      this.hub = null;
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    this.logger.info("サーバーを停止しました");
  }
}
