import { ConfigManager } from "../config/ConfigManager";
import type { TtsProfile } from "../config/schema";
import { Logger } from "../core/logger";
import { TextToSpeech, TtsOptions, TtsSpeaker } from "../core/ports";
import { isWav } from "./wav";

/**
 * GPT-SoVITS の `api_v2.py`（`POST /tts`）へ接続する。
 *
 * 5 秒程度の参照音声でクロスリンガル（ja ⇄ en）の読み上げができ、
 * Windows での実績もあるため、B 案（同一声質）の第一候補。
 * 参照音声のパスはプロジェクトルート基準で解決する。
 */
export class GptSovitsTtsService implements TextToSpeech {
  private readonly logger: Logger;

  constructor(
    private readonly deps: {
      config: ConfigManager;
      profile: () => TtsProfile;
      /** 出力するテキストの言語（en プロファイルなら "en"） */
      textLanguage: () => string;
      logger?: Logger;
    }
  ) {
    this.logger = deps.logger ?? new Logger("TTS");
  }

  private baseUrl(): string {
    const endpoint = this.deps.profile().endpoint.trim() || "http://127.0.0.1:9880";
    return endpoint.replace(/\/+$/, "");
  }

  async isAvailable(): Promise<boolean> {
    try {
      // api_v2 は `/docs`（FastAPI）を返す。ルートは 404 でもサーバー生存は確認できる
      const response = await fetch(`${this.baseUrl()}/docs`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  async listSpeakers(): Promise<TtsSpeaker[]> {
    // 話者は参照音声で決まるため一覧は持たない
    return [];
  }

  async synthesize(text: string, options: TtsOptions = {}): Promise<Buffer> {
    const profile = this.deps.profile();
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("音声合成するテキストが空です");
    }
    if (!profile.reference_wav.trim()) {
      throw new Error(
        "GPT-SoVITS の参照音声（tts.en.reference_wav）が未設定です。1〜5 秒の WAV を指定してください。"
      );
    }

    const timeoutMs = this.deps.config.getTTS().timeout_seconds * 1000;
    const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
    const body = {
      text: trimmed,
      text_lang: this.deps.textLanguage(),
      ref_audio_path: this.deps.config.resolvePath(profile.reference_wav),
      prompt_text: profile.reference_text,
      prompt_lang: profile.prompt_lang || "en",
      text_split_method: "cut5",
      batch_size: 1,
      media_type: "wav",
      streaming_mode: false,
      speed_factor: profile.speed || 1.0,
      parallel_infer: true,
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}/tts`, {
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
        `GPT-SoVITS へ接続できません（${this.baseUrl()}）: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`GPT-SoVITS /tts が ${response.status} を返しました: ${detail}`);
    }

    const wav = Buffer.from(await response.arrayBuffer());
    if (!isWav(wav)) {
      throw new Error("GPT-SoVITS の応答が WAV ではありません（media_type=wav を確認してください）");
    }
    this.logger.info(`音声合成完了 (gpt_sovits: ${trimmed.length} 文字, ${wav.length} bytes)`);
    return wav;
  }

  describe(): string {
    const profile = this.deps.profile();
    return `gpt_sovits:${profile.reference_wav || "(no ref)"}`;
  }
}
