import { ConfigManager } from "../config/ConfigManager";
import type { LanguageMode, TtsProfile } from "../config/schema";
import { Logger } from "../core/logger";
import { TextToSpeech, TtsOptions, TtsSpeaker } from "../core/ports";
import { GptSovitsTtsService } from "./GptSovitsTtsService";
import { OpenAiSpeechTtsService } from "./OpenAiSpeechTtsService";
import { VoicevoxTtsService } from "./VoicevoxTtsService";
import { normalizeWav } from "./wavNormalize";

interface ResolvedTts {
  signature: string;
  language: LanguageMode;
  impl: TextToSpeech;
  describe: string;
}

/**
 * 言語モードに応じて読み上げ実装を選ぶファサード。
 *
 * - ja: VOICEVOX（従来どおり）
 * - en: `[tts.en]` のプロファイル（OpenAI 互換 / GPT-SoVITS）
 *
 * `SttSwitcher` と同じく「関連設定の署名」が変わったときだけ作り直す。
 * 合成結果は必ず 16bit PCM へ正規化してから返す（口パクの前提）。
 */
export class TtsRouter implements TextToSpeech {
  private readonly logger: Logger;
  private current: ResolvedTts;

  constructor(
    private readonly deps: {
      config: ConfigManager;
      logger?: Logger;
      /** 正規化の差し替え（テスト用） */
      normalize?: (wav: Buffer, options: { ffmpegPath?: string; signal?: AbortSignal }) => Promise<Buffer>;
    }
  ) {
    this.logger = deps.logger ?? new Logger("TTS");
    this.current = this.build();
  }

  get language(): LanguageMode {
    return this.deps.config.getLanguage();
  }

  /** 現在のエンジン表示（hello / 診断用） */
  describe(): string {
    return this.current.describe;
  }

  /** 設定変更を反映する。実装を作り直したら true */
  reconfigure(): boolean {
    const next = this.build();
    if (next.signature === this.current.signature) {
      return false;
    }
    this.current = next;
    this.logger.info(`TTS を切り替えました: ${next.describe} (${next.language})`);
    return true;
  }

  async isAvailable(): Promise<boolean> {
    return this.current.impl.isAvailable();
  }

  async listSpeakers(): Promise<TtsSpeaker[]> {
    return this.current.impl.listSpeakers();
  }

  async synthesize(text: string, options: TtsOptions = {}): Promise<Buffer> {
    const impl = this.current.impl;
    const wav = await impl.synthesize(text, options);
    const normalize = this.deps.normalize ?? normalizeWav;
    return normalize(wav, {
      ffmpegPath: this.deps.config.getAudio().ffmpeg_path,
      signal: options.signal,
    });
  }

  /** 言語とプロファイルから実装を作る（署名が変わらなければ再利用する） */
  private build(): ResolvedTts {
    const config = this.deps.config;
    const language = config.getLanguage();
    const tts = config.getTTS();
    const profile = tts.en;

    if (language === "ja") {
      const signature = JSON.stringify({
        language,
        engine: "voicevox",
        endpoint: tts.endpoint,
        speaker_id: tts.speaker_id,
        speed: tts.speed,
      });
      return {
        signature,
        language,
        impl: new VoicevoxTtsService({ config, logger: this.logger }),
        describe: `voicevox:${tts.speaker_id}`,
      };
    }

    const signature = JSON.stringify({ language, profile });
    const impl = this.createEnglishImpl(profile);
    return { signature, language, impl, describe: this.describeEnglish(profile) };
  }

  private createEnglishImpl(profile: TtsProfile): TextToSpeech {
    const config = this.deps.config;
    if (profile.engine === "gpt_sovits") {
      return new GptSovitsTtsService({
        config,
        profile: () => config.getTTS().en,
        textLanguage: () => "en",
        logger: this.logger,
      });
    }
    if (profile.engine === "voicevox") {
      // 英語音声は VOICEVOX では出せないが、設定を尊重してそのまま使う（動作確認用）
      this.logger.warn("tts.en.engine=voicevox は英語の読み上げに適していません");
      return new VoicevoxTtsService({ config, logger: this.logger });
    }
    return new OpenAiSpeechTtsService({
      config,
      profile: () => config.getTTS().en,
      logger: this.logger,
    });
  }

  private describeEnglish(profile: TtsProfile): string {
    if (profile.engine === "gpt_sovits") {
      return `gpt_sovits:${profile.reference_wav || "(no ref)"}`;
    }
    if (profile.engine === "voicevox") {
      return `voicevox:${this.deps.config.getTTS().speaker_id}`;
    }
    return `openai_speech:${profile.model}/${profile.voice}`;
  }
}
