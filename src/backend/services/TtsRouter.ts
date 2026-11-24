import { ConfigManager } from "../config/ConfigManager";
import type { LanguageMode, TtsProfile } from "../config/schema";
import { Logger } from "../core/logger";
import { TextToSpeech, TtsOptions, TtsSpeaker } from "../core/ports";
import { GptSovitsTtsService } from "./GptSovitsTtsService";
import { OpenAiSpeechTtsService } from "./OpenAiSpeechTtsService";
import { VoicevoxTtsService } from "./VoicevoxTtsService";
import { describeProfile, resolveJaProfile } from "./ttsProfiles";
import { normalizeWav, NormalizeWavOptions } from "./wavNormalize";

interface ResolvedTts {
  signature: string;
  language: LanguageMode;
  impl: TextToSpeech;
  describe: string;
}

/**
 * 言語モードに応じて読み上げ実装を選ぶファサード。
 *
 * - ja: `[tts.ja]`（未指定キーは `[tts]` 直下。既定は VOICEVOX）
 * - en: `[tts.en]`
 *
 * **B 案（日英で同じ声）**: `[tts.ja]` と `[tts.en]` に同じエンジン・同じ参照音声を書けば、
 * 日英とも同じ TTS（例: GPT-SoVITS）で読み上げる。
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
      normalize?: (wav: Buffer, options: NormalizeWavOptions) => Promise<Buffer>;
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
      onError: (error) =>
        this.logger.warn("WAV を 16bit PCM へ変換できませんでした（口パクが無効になります）", error),
    });
  }

  /** 言語とプロファイルから実装を作る（署名が変わらなければ再利用する） */
  private build(): ResolvedTts {
    const config = this.deps.config;
    const language = config.getLanguage();
    const profile = this.currentProfile();
    const signature = JSON.stringify({ language, profile });
    return {
      signature,
      language,
      impl: this.createImpl(profile, language),
      describe: describeProfile(profile),
    };
  }

  /**
   * 現在の言語モードに対応する実効プロファイル。
   * ja は `[tts.ja]`（未指定キーは `[tts]` 直下）、en は `[tts.en]`。
   */
  private currentProfile(): TtsProfile {
    const tts = this.deps.config.getTTS();
    return this.deps.config.getLanguage() === "en" ? tts.en : resolveJaProfile(tts);
  }

  private createImpl(profile: TtsProfile, language: LanguageMode): TextToSpeech {
    const config = this.deps.config;
    if (profile.engine === "voicevox") {
      if (language === "en") {
        // 英語音声は VOICEVOX では出せないが、設定を尊重してそのまま使う（動作確認用）
        this.logger.warn("tts.en.engine=voicevox は英語の読み上げに適していません");
      }
      return new VoicevoxTtsService({
        config,
        logger: this.logger,
        profile: () => this.currentProfile(),
      });
    }
    if (profile.engine === "gpt_sovits") {
      return new GptSovitsTtsService({
        config,
        profile: () => this.currentProfile(),
        textLanguage: () => (language === "en" ? "en" : "ja"),
        logger: this.logger,
      });
    }
    return new OpenAiSpeechTtsService({
      config,
      profile: () => this.currentProfile(),
      logger: this.logger,
    });
  }
}
