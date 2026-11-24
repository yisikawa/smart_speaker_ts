import * as fs from "fs";
import * as path from "path";
import { ConfigManager } from "./config/ConfigManager";
import { ConversationPipeline } from "./conversation/ConversationPipeline";
import { ConversationHistory } from "./conversation/ConversationHistory";
import { PlaybackRouter } from "./conversation/PlaybackRouter";
import { PromptBuilder } from "./conversation/PromptBuilder";
import { Logger, LogLevel } from "./core/logger";
import { findProjectRoot } from "./core/paths";
import { AppServer } from "./server/AppServer";
import { WsPlaybackSink } from "./server/WsPlaybackSink";
import { AudioService } from "./services/AudioService";
import { CharacterService } from "./services/CharacterService";
import { OllamaLlmService } from "./services/OllamaLlmService";
import { ServerPlaybackSink } from "./services/ServerPlaybackSink";
import { SttSwitcher } from "./services/SttSwitcher";
import { TtsRouter } from "./services/TtsRouter";
import { VoiceConversionService } from "./services/VoiceConversionService";

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
  // STT は画面からエンジン／モデルを切り替えられるよう、差し替え可能なファサードで包む
  const stt = new SttSwitcher({ config, logger: new Logger("STT") });
  const llm = new OllamaLlmService({ config, logger: new Logger("LLM") });
  // 読み上げは言語モードで実装を切り替える（ja: VOICEVOX / en: [tts.en] のプロファイル）
  // 声質変換（RVC）は `tts.voice_conversion` に従い、正規化の後に挟む（無効・失敗時は素通し）
  const voiceConversion = new VoiceConversionService({ config, logger: new Logger("RVC") });
  const tts = new TtsRouter({ config, logger: new Logger("TTS"), voiceConversion });

  // 3. 会話パイプライン
  // 読み上げの出力先（ブラウザ再生が本命。表示クライアントが居なければ ffplay へ落ちる）
  let appServer: AppServer | null = null;
  const serverPlayback = new ServerPlaybackSink({ audio });
  const browserPlayback = new WsPlaybackSink({
    send: (message) => appServer?.broadcast(message) ?? false,
    hasPrimaryClient: () => appServer?.hasPrimaryClient() ?? false,
    logger: new Logger("Playback"),
  });
  const playback = new PlaybackRouter({
    config,
    server: serverPlayback,
    browser: browserPlayback,
    logger: new Logger("Playback"),
  });

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
    playback,
  });

  // 4. サーバー
  const port = Number(process.env.PORT ?? 3000);
  appServer = new AppServer({
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
    playbackAck: { resolveDone: (utteranceId) => browserPlayback.resolveDone(utteranceId) },
  });
  const server = appServer;

  await server.start();

  // 設定が変わったら STT の実装を差し替え、疎通（🟢/🔴）も更新する。
  // 画面のモデル切替 / PATCH /api/config / POST /api/config/reload のすべてがここを通る。
  config.onChange(() => {
    if (stt.reconfigure()) {
      bootLogger.info(`STT を切り替えました: ${stt.describe()}`);
    }
    if (tts.reconfigure()) {
      bootLogger.info(`TTS を切り替えました: ${tts.describe()}`);
    }
    void server.refreshServices();
  });

  // 初回の疎通確認が終わるまで待つ（直後の警告が「実際は接続できているのに出る」のを防ぐ）
  await server.refreshServices();

  const services = server.serviceStatus();
  if (!services.llm) {
    bootLogger.warn(
      `Ollama に接続できません (${config.getLLM().endpoint})。\`ollama serve\` を起動してください。`
    );
  }
  if (!services.tts) {
    const engine = config.getTtsEngineName();
    const endpoint = config.getLanguage() === "en" ? config.getTTS().en.endpoint : config.getTTS().endpoint;
    bootLogger.warn(
      `TTS（${engine}）に接続できません (${endpoint})。[tts.ja] / [tts.en] の設定とサーバーの起動状態を確認してください。`
    );
  }
  if (!services.stt) {
    const sttConfig = config.getSTT();
    bootLogger.warn(
      sttConfig.engine === "sherpa"
        ? `sherpa-onnx のモデルが見つかりません（${sttConfig.sherpa_model_dir}）。scripts/setup-sherpa.ps1 を実行してください。`
        : "Whisper（whisper.cpp / ggml モデル）が見つかりません。models/ を確認してください。"
    );
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
