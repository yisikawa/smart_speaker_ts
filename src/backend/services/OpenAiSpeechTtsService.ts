import { ConfigManager } from "../config/ConfigManager";
import type { TtsProfile } from "../config/schema";
import { Logger } from "../core/logger";
import { TextToSpeech, TtsOptions, TtsSpeaker } from "../core/ports";
import { isWav } from "./wav";

/**
 * OpenAI 互換の `/v1/audio/speech` を話す TTS サーバへ接続する。
 *
 * これ 1 つで Kokoro-FastAPI・openedai-speech（Piper）・vLLM-Omni 系の
 * マルチリンガル TTS などをまとめて扱える（B 案の共通アダプタ）。
 * 既定は `response_format: "wav"`。WAV 以外が返ったら設定誤りとして明示的に失敗する。
 */
export class OpenAiSpeechTtsService implements TextToSpeech {
  private readonly logger: Logger;

  constructor(
    private readonly deps: {
      config: ConfigManager;
      /** 現在の英語プロファイル（実行中に切り替わるため関数で受け取る） */
      profile: () => TtsProfile;
      logger?: Logger;
    }
  ) {
    this.logger = deps.logger ?? new Logger("TTS");
  }

  private baseUrl(): string {
    const endpoint = this.deps.profile().endpoint.trim() || "http://127.0.0.1:8880";
    return endpoint.replace(/\/+$/, "");
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl()}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listSpeakers(): Promise<TtsSpeaker[]> {
    // OpenAI 互換 API に話者一覧の標準は無い（voice 名は設定で指定する）
    return [];
  }

  async synthesize(text: string, options: TtsOptions = {}): Promise<Buffer> {
    const profile = this.deps.profile();
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("音声合成するテキストが空です");
    }

    const timeoutMs = this.deps.config.getTTS().timeout_seconds * 1000;
    const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
    const body = {
      model: profile.model || "kokoro",
      input: trimmed,
      voice: profile.voice || "af_heart",
      response_format: "wav",
      speed: profile.speed || 1.0,
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      throw new Error(
        `英語 TTS サーバへ接続できません（${this.baseUrl()}）: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`/v1/audio/speech が ${response.status} を返しました: ${detail}`);
    }

    const wav = Buffer.from(await response.arrayBuffer());
    if (!isWav(wav)) {
      throw new Error(
        "TTS の応答が WAV ではありません（設定で response_format=wav を返すサーバを指定してください）"
      );
    }
    this.logger.info(`音声合成完了 (openai_speech: ${trimmed.length} 文字, ${wav.length} bytes)`);
    return wav;
  }

  describe(): string {
    const profile = this.deps.profile();
    return `openai_speech:${profile.model}/${profile.voice}`;
  }
}
