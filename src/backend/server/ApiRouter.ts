import { Router, Request, RequestHandler, Response } from "express";
import type { HealthReport, ServiceStatus } from "../../shared/protocol";
import { ConfigManager } from "../config/ConfigManager";
import { AppConfig, DeepPartial } from "../config/schema";
import { ConversationPipeline } from "../conversation/ConversationPipeline";
import { Logger } from "../core/logger";
import { AudioIO, LanguageModel, SpeechToText, TextToSpeech } from "../core/ports";
import { CharacterService } from "../services/CharacterService";

export interface ApiDeps {
  config: ConfigManager;
  pipeline: ConversationPipeline;
  audio: AudioIO;
  llm: LanguageModel;
  stt: SpeechToText;
  tts: TextToSpeech;
  character: CharacterService;
  version: string;
  startedAt: number;
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/**
 * REST API。設定・履歴・ヘルスチェック・デバイス一覧などを提供する。
 * 会話の実行は WebSocket を主経路とし、HTTP は管理・補助用途に限定する。
 */
export function createApiRouter(deps: ApiDeps): Router {
  const router = Router();
  const logger = new Logger("API");

  const serviceStatus = async (): Promise<ServiceStatus> => {
    const [llm, tts, stt] = await Promise.all([
      deps.llm.isAvailable(),
      deps.tts.isAvailable(),
      deps.stt.isAvailable(),
    ]);
    return { llm, tts, stt };
  };

  router.get(
    "/health",
    asyncHandler(async (_req, res) => {
      const services = await serviceStatus();
      let audioDevices = 0;
      try {
        audioDevices = (await deps.audio.listInputDevices()).length;
      } catch {
        audioDevices = 0;
      }
      const report: HealthReport = {
        ok: services.llm && services.tts && services.stt,
        version: deps.version,
        uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
        services,
        audioDevices,
        warnings: deps.config.getWarnings(),
      };
      res.json(report);
    })
  );

  router.get("/state", (_req, res) => {
    res.json({ state: deps.pipeline.getState(), busy: deps.pipeline.isBusy });
  });

  router.get("/character", (_req, res) => {
    res.json(deps.character.get());
  });

  router.get("/config", (_req, res) => {
    res.json(deps.config.getMasked());
  });

  router.patch("/config", (req, res) => {
    const patch = req.body as DeepPartial<AppConfig> | undefined;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      res.status(400).json({ error: "設定パッチが不正です（JSON オブジェクトを送信してください）" });
      return;
    }
    try {
      deps.config.update(patch);
      deps.character.reload();
      res.json(deps.config.getMasked());
    } catch (error) {
      logger.error("設定の更新に失敗しました", error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/config/reload", (_req, res) => {
    deps.config.reload();
    deps.character.reload();
    res.json(deps.config.getMasked());
  });

  router.get("/history", (_req, res) => {
    res.json({ messages: deps.pipeline.getHistory() });
  });

  const clearHistory = (_req: Request, res: Response): void => {
    deps.pipeline.clearHistory();
    res.json({ success: true });
  };
  router.delete("/history", clearHistory);
  router.post("/history/clear", clearHistory);

  router.get(
    "/audio-devices",
    asyncHandler(async (_req, res) => {
      try {
        const devices = await deps.audio.listInputDevices();
        res.json({ devices });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    })
  );

  router.post(
    "/tts",
    asyncHandler(async (req, res) => {
      const text = typeof req.body?.text === "string" ? req.body.text : "";
      if (!text.trim()) {
        res.status(400).json({ error: "text は必須です" });
        return;
      }
      await deps.pipeline.speak(text);
      res.json({ success: true });
    })
  );

  return router;
}
