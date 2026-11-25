import { Router, Request, RequestHandler, Response } from "express";
import * as fs from "fs";
import * as path from "path";
import type {
  DiagnosticsReport,
  HealthReport,
  ModelCatalog,
  ModelUpdateResult,
} from "../../shared/protocol";
import { isSherpaModelType } from "../../shared/stt/modelTypes";
import { ConfigManager } from "../config/ConfigManager";
import { AppConfig, DeepPartial, STTConfig } from "../config/schema";
import { ConversationPipeline } from "../conversation/ConversationPipeline";
import { Logger } from "../core/logger";
import { AudioIO, LanguageModel } from "../core/ports";
import { CharacterService } from "../services/CharacterService";
import { listAvatarModels } from "../services/avatarCatalog";
import {
  listSherpaModels,
  listWhisperModels,
  llmModelMissingMessage,
  pickLlmModel,
} from "../services/modelCatalog";
import { ServiceMonitor } from "./ServiceMonitor";

/** 設定へ保存するパスは `/` 区切りに統一する（TOML の可読性） */
function toConfigPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export interface ApiDeps {
  config: ConfigManager;
  pipeline: ConversationPipeline;
  audio: AudioIO;
  /** モデル一覧の取得に使う */
  llm: LanguageModel;
  character: CharacterService;
  /** 依存サービスの疎通（WebSocket の hello と同じ判定を共有する） */
  serviceMonitor: ServiceMonitor;
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

  const serviceStatus = async (): Promise<HealthReport["services"]> => deps.serviceMonitor.refresh();

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

  router.get("/avatar/models", (_req, res) => {
    res.json({ models: listAvatarModels(deps.config.rootDir) });
  });

  router.get("/state", (_req, res) => {
    res.json({ state: deps.pipeline.getState(), busy: deps.pipeline.isBusy });
  });

  /**
   * 診断用のスナップショット（障害切り分け用）。
   * 破棄の内訳は `SpeechGate` のカウンタを唯一の真実源とし、ログと同じ数字を返す。
   */
  router.get("/diagnostics", (_req, res) => {
    const audio = deps.config.getAudio();
    const report: DiagnosticsReport = {
      ...deps.pipeline.getDiagnostics(),
      services: deps.serviceMonitor.current,
      warnings: deps.config.getWarnings(),
      audio: {
        input_mode: audio.input_mode,
        silence_threshold: audio.silence_threshold,
        silence_threshold_max: audio.silence_threshold_max,
        silence_duration: audio.silence_duration,
        max_record_seconds: audio.max_record_seconds,
        barge_in_enabled: deps.config.getConversation().barge_in_enabled,
      },
    };
    res.json(report);
  });

  router.get("/character", (_req, res) => {
    res.json(deps.character.get());
  });

  /**
   * 設定レスポンス（マスク済みの現在値＋検証で補正された内容）。
   * `sanitize` の結果は `/api/health` と同じ `getWarnings()` を使う。
   */
  const configPayload = (): AppConfig & { warnings: string[] } => ({
    ...deps.config.getMasked(),
    warnings: deps.config.getWarnings(),
  });

  router.get("/config", (_req, res) => {
    res.json(configPayload());
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
      res.json(configPayload());
    } catch (error) {
      logger.error("設定の更新に失敗しました", error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/config/reload", (_req, res) => {
    deps.config.reload();
    deps.character.reload();
    res.json(configPayload());
  });

  /**
   * 画面のモデル選択に使う候補一覧。
   * Ollama が停止していても 200 を返し、`llm.available=false` で伝える（画面を壊さない）。
   */
  router.get(
    "/models",
    asyncHandler(async (_req, res) => {
      const sttConfig = deps.config.getSTT();
      const modelsDir = deps.config.resolvePath("models");

      let llmModels: string[] = [];
      let llmAvailable = false;
      try {
        llmModels = await deps.llm.listModels();
        llmAvailable = true;
      } catch {
        llmAvailable = false;
      }

      const catalog: ModelCatalog = {
        stt: {
          engine: sttConfig.engine,
          current: {
            modelPath: sttConfig.model_path,
            sherpaModelDir: sttConfig.sherpa_model_dir,
            sherpaModelType: sttConfig.sherpa_model_type,
          },
          whisper: listWhisperModels(modelsDir),
          sherpa: listSherpaModels(modelsDir),
        },
        llm: {
          model: deps.config.getLLM().model,
          models: llmModels,
          available: llmAvailable,
        },
      };
      res.json(catalog);
    })
  );

  /**
   * LLM モデルの切り替え。Ollama に無いモデルは 400 で拒否する
   * （存在しないまま保存すると次の応答が 404 になり、原因が分かりにくいため）。
   */
  router.put(
    "/models/llm",
    asyncHandler(async (req, res) => {
      const requested = typeof req.body?.model === "string" ? req.body.model.trim() : "";
      if (!requested) {
        res.status(400).json({ error: "model は必須です" });
        return;
      }

      let installed: string[] = [];
      try {
        installed = await deps.llm.listModels();
      } catch {
        res.status(400).json({
          error: `Ollama に接続できないためモデルを確認できません（${deps.config.getLLM().endpoint}）`,
        });
        return;
      }

      const matched = pickLlmModel(installed, requested);
      if (!matched) {
        res.status(400).json({ error: llmModelMissingMessage(installed, requested) });
        return;
      }

      // 保存すると ConfigManager の購読者（STT の再構成・疎通の再確認）が動く
      deps.config.update({ llm: { model: matched } });

      // 切替直後の初回発話が「モデル読み込み待ち」でタイムアウトしないよう、ここで読み込む
      // （Ollama は読み込み中のリクエストを中断されると読み込みごと中止するため、
      //   60 秒で切ると永久にタイムアウトし続ける）
      const warnings = [...deps.config.getWarnings()];
      let loadSeconds: number | null = null;
      if (deps.llm.prepare) {
        try {
          loadSeconds = (await deps.llm.prepare(matched)) / 1000;
        } catch (error) {
          warnings.push(
            `モデルの事前読み込みに失敗しました（最初の発話が遅くなる可能性があります）: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      const services = await deps.serviceMonitor.refresh();
      const timing = loadSeconds === null ? "" : `読み込み ${loadSeconds.toFixed(1)} 秒・`;
      const result: ModelUpdateResult = {
        ok: true,
        warnings,
        services,
        message: `LLM モデルを ${matched} に切り替えました（${timing}次の発話から使われます）`,
      };
      logger.info(result.message);
      res.json(result);
    })
  );

  /**
   * STT のエンジン・モデル切り替え。
   * パスの存在だけ検証し、疎通できない場合（sherpa-onnx-node 未導入など）は
   * 切替を許可したうえで `services.stt=false` と warnings で知らせる（原因が見えるようにする）。
   */
  router.put(
    "/models/stt",
    asyncHandler(async (req, res) => {
      const engine = req.body?.engine;
      if (engine !== "whisper" && engine !== "sherpa") {
        res.status(400).json({ error: 'engine は "whisper" か "sherpa" を指定してください' });
        return;
      }

      const sttPatch: DeepPartial<STTConfig> = { engine };
      let label: string;

      if (engine === "whisper") {
        const requested = typeof req.body?.model_path === "string" ? req.body.model_path.trim() : "";
        if (requested) {
          if (!fs.existsSync(deps.config.resolvePath(requested))) {
            res.status(400).json({
              error: `Whisper のモデルが見つかりません: ${requested}（models/*.bin を確認してください）`,
            });
            return;
          }
          sttPatch.model_path = toConfigPath(requested);
        }
        const modelPath = sttPatch.model_path ?? deps.config.getSTT().model_path;
        label = `whisper.cpp / ${path.basename(modelPath) || "未設定"}`;
      } else {
        const requested = typeof req.body?.sherpa_model_dir === "string" ? req.body.sherpa_model_dir.trim() : "";
        if (!requested) {
          res.status(400).json({ error: "sherpa を選ぶ場合は sherpa_model_dir が必要です" });
          return;
        }
        const absolute = deps.config.resolvePath(requested);
        if (!fs.existsSync(path.join(absolute, "tokens.txt"))) {
          res.status(400).json({
            error: `sherpa-onnx のモデルが見つかりません: ${requested}（tokens.txt がありません）`,
          });
          return;
        }
        sttPatch.sherpa_model_dir = toConfigPath(requested);

        const modelType = req.body?.sherpa_model_type;
        if (typeof modelType === "string" && modelType) {
          if (!isSherpaModelType(modelType)) {
            res.status(400).json({ error: `未対応の sherpa_model_type です: ${modelType}` });
            return;
          }
          sttPatch.sherpa_model_type = modelType;
        }
        label = `sherpa-onnx / ${path.basename(requested)}`;
      }

      deps.config.update({ stt: sttPatch });
      const services = await deps.serviceMonitor.refresh();
      const warnings = [...deps.config.getWarnings()];
      if (!services.stt) {
        warnings.push(
          "STT の疎通確認に失敗しました（モデル・whisper.cpp の実行ファイル・sherpa-onnx-node を確認してください）"
        );
      }
      if (deps.pipeline.isBusy) {
        warnings.push("進行中の発話は切り替え前の設定で処理されます");
      }

      const result: ModelUpdateResult = {
        ok: true,
        warnings,
        services,
        message: `音声認識を ${label} に切り替えました（次の発話から有効）`,
      };
      logger.info(result.message);
      res.json(result);
    })
  );

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
