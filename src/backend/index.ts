import * as fs from "fs";
import * as path from "path";
import { ConfigManager } from "./config/ConfigManager";
import { ConversationPipeline } from "./conversation/ConversationPipeline";
import { ConversationHistory } from "./conversation/ConversationHistory";
import { PromptBuilder } from "./conversation/PromptBuilder";
import { Logger, LogLevel } from "./core/logger";
import { findProjectRoot } from "./core/paths";
import { AppServer } from "./server/AppServer";
import { AudioService } from "./services/AudioService";
import { CharacterService } from "./services/CharacterService";
import { OllamaLlmService } from "./services/OllamaLlmService";
import { VoicevoxTtsService } from "./services/VoicevoxTtsService";
import { WhisperSttService } from "./services/WhisperSttService";

function readVersion(rootDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(rootDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function resolveLogLevel(): LogLevel {
  const level = (process.env.SUMIKA_LOG_LEVEL ?? "info").toLowerCase();
  return level === "debug" || level === "info" || level === "warn" || level === "error" ? level : "info";
}

async function main(): Promise<void> {
  const rootDir = findProjectRoot(__dirname);
  Logger.configure({ level: resolveLogLevel(), file: path.join(rootDir, "logs", "app.log") });

  const bootLogger = new Logger("Boot");
  const version = readVersion(rootDir);

  console.log("========================================");
  console.log(`   Sumika TypeScript v${version}`);
  console.log("========================================");
  console.log("");

  // 1. 設定
  const config = new ConfigManager({ rootDir, logger: new Logger("Config") });
  const character = new CharacterService({ config, logger: new Logger("Character") });

  // 2. サービス（ポート/アダプタ）
  const audio = new AudioService({ config, logger: new Logger("Audio") });
  const stt = new WhisperSttService({ config, logger: new Logger("STT") });
  const llm = new OllamaLlmService({ config, logger: new Logger("LLM") });
  const tts = new VoicevoxTtsService({ config, logger: new Logger("TTS") });

  // 3. 会話パイプライン
  const history = new ConversationHistory(config.getLLM().history_turns);
  const promptBuilder = new PromptBuilder({ config, character });
  const pipeline = new ConversationPipeline({
    config,
    history,
    promptBuilder,
    audio,
    stt,
    llm,
    tts,
    logger: new Logger("Pipeline"),
  });

  // 4. サーバー
  const port = Number(process.env.PORT ?? 3000);
  const server = new AppServer({
    config,
    pipeline,
    audio,
    stt,
    llm,
    tts,
    character,
    logger: new Logger("Server"),
    version,
    port,
    frontendDirs: [path.join(rootDir, "dist", "frontend"), path.join(rootDir, "src", "frontend")],
  });

  await server.start();

  const services = server.serviceStatus();
  if (!services.llm) {
    bootLogger.warn(
      `Ollama に接続できません (${config.getLLM().endpoint})。\`ollama serve\` を起動してください。`
    );
  }
  if (!services.tts) {
    bootLogger.warn(`VOICEVOX に接続できません (${config.getTTS().endpoint})。VOICEVOX を起動してください。`);
  }
  if (!services.stt) {
    bootLogger.warn("Whisper（whisper.cpp / ggml モデル）が見つかりません。models/ を確認してください。");
  }
  if (services.llm) {
    try {
      if (!(await llm.hasModel())) {
        bootLogger.warn(
          `Ollama にモデル '${config.getLLM().model}' がありません。\`ollama pull ${config.getLLM().model}\` を実行してください。`
        );
      }
    } catch {
      // モデル一覧の取得失敗は致命的ではない
    }
  }
  bootLogger.info(`ブラウザで http://localhost:${port} を開いてください。`);

  // 5. 会話ループ（auto_start が false の場合は UI / API から開始）
  pipeline.start();

  // 6. グレースフルシャットダウン
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    bootLogger.info(`${signal} を受信しました。終了します...`);
    try {
      await pipeline.dispose();
      await server.stop();
    } catch (error) {
      bootLogger.error("終了処理でエラー", error);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => bootLogger.error("未処理の Promise 拒否", reason));
  process.on("uncaughtException", (error) => bootLogger.error("未処理の例外", error));
}

main().catch((error) => {
  console.error("致命的なエラー:", error);
  process.exit(1);
});
