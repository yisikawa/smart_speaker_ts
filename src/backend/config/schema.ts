/**
 * 設定スキーマ（単一の真実源）。
 *
 * - 型定義と既定値を同一ファイルに置き、既定値の欠落をコンパイル時に検出する
 * - 設定ファイル（TOML）はこの型に対して部分指定できる（深いマージで補完）
 */

// フロントエンドと共有する型（内向き依存: backend → shared）
import type { SherpaModelTypeName, SttEngineName } from "../../shared/protocol";
import type { LanguageMode } from "../../shared/i18n/languagePack";

export type { LanguageMode } from "../../shared/i18n/languagePack";

export interface AudioConfig {
  /** STT / VAD が前提とするサンプリングレート（Whisper は 16kHz 必須） */
  sample_rate: number;
  /** VAD のフレーム長（ms） */
  frame_ms: number;
  /** 発話検出時に遡って取り込むプリロール（ms） */
  pre_roll_ms: number;
  /** 1 発話の最大長（秒） */
  max_record_seconds: number;
  /** 無音とみなす RMS しきい値（0..1） */
  silence_threshold: number;
  /** この秒数だけ無音が続いたら発話終了 */
  silence_duration: number;
  /** 発話開始までの待ち時間（秒）。超えたら「無音」と判定 */
  no_speech_timeout: number;
  /** 入力ゲイン（レベル計算にのみ適用） */
  input_gain: number;
  /** 出力音量（0..1） */
  output_volume: number;
  /** 入力デバイス名（空なら自動検出） */
  input_device: string;
  /** 出力デバイス名（現状は既定デバイスのみ対応・予約） */
  output_device: string;
  /** レベルの指数移動平均係数 */
  smoothing_alpha: number;
  /** 暗騒音に対する相対しきい値の倍率 */
  relative_threshold_multiplier: number;
  /**
   * 相対しきい値の上限（0..1）。
   * タイピング・物音・空調などの環境音で暗騒音が膨らんでも、これ以上は上げない。
   */
  silence_threshold_max: number;
  /** 起動時キャリブレーション時間（秒） */
  calibration_duration: number;
  /** 連続何フレームで発話開始と判定するか */
  debounce_frames: number;
  /** ffmpeg 実行パス（PATH 解決できない場合に指定） */
  ffmpeg_path: string;
  /** 再生バックエンド: auto | ffplay | soundplayer */
  player: "auto" | "ffplay" | "soundplayer";
  /** 録音セッション間で待つ時間（ms）。マイクの解放待ち */
  device_settle_ms: number;
  /** 音声入力の方式: browser（ブラウザのマイク） / server（ffmpeg で録音） */
  input_mode: "browser" | "server";
  /** 再生の出力先: server（ffplay）/ browser（WebAudio） */
  playback_target: "server" | "browser";
}

export interface WakewordConfig {
  /** ウェイクワードモデル（.rpw 等）。空配列ならエンジン無効 */
  wakeword_path: string[];
  threshold: number;
  avg_threshold: number;
  min_scores: number;
}

export interface ConversationConfig {
  /** 応答言語（ja: 日本語 / en: 英語）。STT・プロンプト・TTS・UI が追従する */
  language: LanguageMode;
  /** 言語を切り替えたときに会話履歴を消すか */
  reset_history_on_language_change: boolean;
  /** 起動直後に自動で聞き取りを開始するか */
  auto_start: boolean;
  followup_enabled: boolean;
  max_followup_turns: number;
  followup_timeout_seconds: number;
  /** 応答直後にマイクを開くまでの待ち（エコー防止, ms） */
  followup_guard_ms: number;
  /**
   * フォローアップ回数の上限に達しても聞き取りを続けるか。
   * true の間は「停止」を押すまで待機し続ける（スマートスピーカー的な使い方）。
   */
  keep_listening: boolean;
  barge_in_enabled: boolean;
  /** バージイン判定の RMS しきい値（0..1） */
  barge_in_min_score: number;
}

/** 認識エンジン（whisper: whisper.cpp / sherpa: sherpa-onnx） */
export type SttEngine = SttEngineName;

/** sherpa-onnx のモデル種別（使用する ONNX 一式の構成を決める） */
export type SherpaModelType = SherpaModelTypeName;

export interface STTConfig {
  /** 認識エンジン（whisper: whisper.cpp / sherpa: sherpa-onnx） */
  engine: SttEngine;
  model_path: string;
  /** whisper.cpp 実行ファイル */
  binary_path: string;
  language: string;
  use_gpu: boolean;
  flash_attn: boolean;
  beam_size: number;
  /** 推論スレッド数 */
  threads: number;
  /** 認識タイムアウト（秒） */
  timeout_seconds: number;
  /** 認識ヒント（専門用語など） */
  initial_prompt: string;
  /** 非音声トークンを抑制する（whisper.cpp `-sns`）。無音・雑音での幻聴対策 */
  suppress_non_speech: boolean;
  /** 直前の文脈トークン保持数（`-mc`）。0 で文脈を引き継がない＝同文の繰り返し幻聴を防ぐ */
  max_context: number;
  /** 「無音」と判定する確率しきい値（`-nth`）。大きいほど幻聴が出にくい */
  no_speech_thold: number;
  /** 区間の `no_speech_prob` がこの値以上なら破棄（JSON 出力を利用） */
  drop_no_speech_prob: number;
  /** 区間の `avg_logprob` がこの値未満なら破棄（JSON 出力を利用） */
  drop_avg_logprob: number;
  /** 定型句の幻聴（「ご視聴ありがとうございました」等）を破棄する */
  filter_hallucinations: boolean;
  /** この RMS（0..1）未満の入力は無音として認識しない（0 で無効） */
  min_input_rms: number;
  /** sherpa-onnx のモデルディレクトリ（*.onnx と tokens.txt を置く） */
  sherpa_model_dir: string;
  /** sherpa-onnx のモデル種別 */
  sherpa_model_type: SherpaModelType;
  /** 推論プロバイダ（cpu / cuda。GPU 版 onnxruntime を使う場合のみ変更） */
  sherpa_provider: string;
  /** SenseVoice の言語指定（auto / ja / en / zh / ko / yue） */
  sherpa_language: string;
  /**
   * 英語モード（`conversation.language = "en"`）のときだけ上書きする値。
   * 未指定のキーは日本語モードと同じ値を使う（`ConfigManager.getSTT()` が合成する）。
   */
  en: SttLanguageOverride;
}

/** 英語モード用の STT 上書き（既定は空＝日本語モードと同じ構成） */
export interface SttLanguageOverride {
  engine?: SttEngine;
  model_path?: string;
  binary_path?: string;
  language?: string;
  use_gpu?: boolean;
  threads?: number;
  timeout_seconds?: number;
  initial_prompt?: string;
  sherpa_model_dir?: string;
  sherpa_model_type?: SherpaModelType;
  sherpa_language?: string;
}


export interface LLMConfig {
  endpoint: string;
  model: string;
  character_file: string;
  temperature: number;
  max_tokens: number;
  response_timeout_seconds: number;
  /**
   * モデルの読み込みを待つ上限（秒）。
   * モデルを切り替えた直後の初回は読み込みに数十秒かかることがあり、
   * これを `response_timeout_seconds` と同じにすると読み込みごと打ち切られて
   * 「永遠にタイムアウトする」状態になる。
   */
  model_load_timeout_seconds: number;
  /** プロンプトに含める直近ターン数 */
  history_turns: number;
  /** 英語モードのキャラクター定義（空なら日本語と同じファイルを使う） */
  character_file_en: string;
  /** Ollama の keep_alive（切替直後の再読み込みを避ける） */
  keep_alive: string;
  /** コンテキスト長（VRAM 使用量に直結する） */
  num_ctx: number;
}

/** 読み上げエンジン（voicevox: 日本語 / openai_speech: OpenAI 互換 / gpt_sovits: GPT-SoVITS api_v2） */
export type TtsEngineName = "voicevox" | "openai_speech" | "gpt_sovits";

/** 英語モードの音声プロファイル（日本語は `[tts]` 直下の既存キーを使う） */
export interface TtsProfile {
  engine: TtsEngineName;
  /** エンジンの HTTP エンドポイント（voicevox は未使用） */
  endpoint: string;
  /** OpenAI 互換の model 名（openai_speech のみ） */
  model: string;
  /** OpenAI 互換の voice 名（openai_speech のみ） */
  voice: string;
  /** VOICEVOX のスタイル ID（en で voicevox を選んだ場合のみ） */
  speaker_id: number;
  /** 話速（1.0 が標準） */
  speed: number;
  /** GPT-SoVITS の参照音声（プロジェクトルート基準） */
  reference_wav: string;
  /** GPT-SoVITS の参照音声の書き起こし */
  reference_text: string;
  /** 参照音声の言語（ja / en / zh など） */
  prompt_lang: string;
}

/** 読み上げ後の声質変換（RVC など）。既定は無効 */
export interface VoiceConversionConfig {
  enabled: boolean;
  /** 変換ワーカーの HTTP エンドポイント（例: http://127.0.0.1:9890） */
  endpoint: string;
  /** RVC モデル（.pth）。プロジェクトルート基準 */
  model_path: string;
  /** RVC の index ファイル（.index）。空なら未使用 */
  index_path: string;
  /** ピッチ（半音） */
  pitch: number;
  /** ピッチ推定法（rmvpe / harvest / crepe など） */
  f0_method: string;
  /** index の混合率（0..1） */
  index_rate: number;
  /** 子音の保護（0..0.5） */
  protect: number;
  /** 変換タイムアウト（秒） */
  timeout_seconds: number;
}

export interface TTSConfig {
  engine: TtsEngineName;
  endpoint: string;
  speaker_id: number;
  speed: number;
  pitch: number;
  volume: number;
  /** 音声合成タイムアウト（秒） */
  timeout_seconds: number;
  /** 文単位でストリーミング合成する（P2 で使用） */
  split_sentences: boolean;
  /** 何文先まで合成を先読みするか */
  prefetch_depth: number;
  /** これ未満の文は次と結合する */
  min_sentence_chars: number;
  /** これ超の文は読点でも分割する */
  max_sentence_chars: number;
  /** 英語モードの音声プロファイル */
  en: TtsProfile;
  /**
   * 日本語モードの上書き（`[tts]` 直下の既存キーが既定値）。
   * B 案（日英で同じエンジン・同じ声）にするときは、ここに en と同じ設定を書く。
   */
  ja: TtsProfileOverride;
  /** 読み上げ後の声質変換（任意） */
  voice_conversion: VoiceConversionConfig;
}

/** `[tts.ja]` の上書き（未指定キーは `[tts]` 直下の値を使う） */
export type TtsProfileOverride = Partial<TtsProfile>;


/** アバター（Live2D / 立ち絵）の設定。P0 では設定と hello への配信のみ */
export interface AvatarConfig {
  enabled: boolean;
  /** model3.json のパス（プロジェクトルート基準・`/` 区切り） */
  model_path: string;
  /**
   * 立ち絵画像（PNG/WebP）のパス。空なら CSS 立ち絵。
   * `assets/avatar/<file>` に置くと `/avatar-assets/<file>` で配信される。
   */
  sprite_image: string;
  /** 拡大率とステージ内の相対位置（0..1） */
  scale: number;
  offset_x: number;
  offset_y: number;
  background: string;
  /** 待機モーションの間隔（秒）。0 で無効 */
  idle_motion_interval_seconds: number;
  /** 口パクの追従（0..1）と開き量 */
  lip_sync_smoothing: number;
  lip_sync_gain: number;
  emotion_tags_enabled: boolean;
  emotion_heuristic_enabled: boolean;
  /** 意味キー → モデルの表情名（空文字は「変えない」） */
  expressions: Record<string, string>;
  /** 意味キー → VOICEVOX のスタイル名（空なら tts.speaker_id） */
  emotion_styles: Record<string, string>;
  /** 意味キー → モデルのモーショングループ名 */
  motions: Record<string, string>;
}

export interface RAGConfig {
  enabled: boolean;
  data_dir: string;
  embedding_model: string;
  top_k: number;
  similarity_threshold: number;
}

export interface RecipeDBConfig {
  enabled: boolean;
  db_path: string;
  master_dir: string;
}

export interface MusicConfig {
  spotify_client_id: string;
  spotify_redirect_uri: string;
  local_music_dir: string;
  default_volume: number;
  volume_step: number;
  duck_on_wakeword: boolean;
  duck_volume: number;
}

export interface GUIConfig {
  user_name: string;
  debug_mode: boolean;
  trace_turns: boolean;
  outfit: string;
  /** 画面レイアウト: chat（従来）/ stage（配信向け・P3） */
  layout: "chat" | "stage";
  caption_enabled: boolean;
  caption_font_size: number;
}

export interface ProactiveCategory {
  enabled: boolean;
  voice: boolean;
  ui: boolean;
}

export interface ProactiveTrigger {
  enabled: boolean;
  fire_time: string;
  text?: string;
  include_weather?: boolean;
  include_calendar?: boolean;
  include_shopping?: boolean;
  include_news?: boolean;
  news_url?: string;
  news_new_only?: boolean;
}

export interface ProactiveSpeechConfig {
  categories: {
    briefing: ProactiveCategory;
    reminder: ProactiveCategory;
    alert: ProactiveCategory;
    family_memo: ProactiveCategory;
    system: ProactiveCategory;
  };
  triggers: {
    demo: ProactiveTrigger;
    morning_briefing: ProactiveTrigger;
  };
}

export interface HomeAssistantConfig {
  base_url: string;
  token: string;
}

export interface AppConfig {
  audio: AudioConfig;
  wakeword: WakewordConfig;
  conversation: ConversationConfig;
  stt: STTConfig;
  llm: LLMConfig;
  tts: TTSConfig;
  avatar: AvatarConfig;
  rag: RAGConfig;
  recipe_db: RecipeDBConfig;
  music: MusicConfig;
  gui: GUIConfig;
  apps: {
    proactive_speech: ProactiveSpeechConfig;
    home_assistant: HomeAssistantConfig;
  };
}

/** 深い部分型（設定パッチ用） */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export const DEFAULT_CONFIG: AppConfig = {
  audio: {
    sample_rate: 16000,
    frame_ms: 20,
    pre_roll_ms: 300,
    max_record_seconds: 30,
    silence_threshold: 0.02,
    silence_duration: 1.5,
    no_speech_timeout: 3.0,
    input_gain: 1.0,
    output_volume: 1.0,
    input_device: "",
    output_device: "",
    smoothing_alpha: 0.1,
    relative_threshold_multiplier: 2.0,
    silence_threshold_max: 0.06,
    calibration_duration: 0.5,
    debounce_frames: 3,
    ffmpeg_path: "",
    player: "auto",
    device_settle_ms: 250,
    input_mode: "browser",
    playback_target: "server",
  },
  wakeword: {
    wakeword_path: [],
    threshold: 0.55,
    avg_threshold: 0.4,
    min_scores: 3,
  },
  conversation: {
    language: "ja",
    reset_history_on_language_change: false,
    auto_start: false,
    followup_enabled: true,
    max_followup_turns: 3,
    followup_timeout_seconds: 6.0,
    followup_guard_ms: 250,
    keep_listening: true,
    barge_in_enabled: false,
    barge_in_min_score: 0.08,
  },
  stt: {
    engine: "whisper",
    model_path: "models/ggml-large-v3-turbo.bin",
    binary_path: "whisper.cpp/main.exe",
    language: "ja",
    use_gpu: true,
    flash_attn: true,
    beam_size: 1,
    threads: 4,
    timeout_seconds: 60,
    initial_prompt: "",
    suppress_non_speech: true,
    max_context: 0,
    no_speech_thold: 0.6,
    drop_no_speech_prob: 0.75,
    drop_avg_logprob: -1.0,
    filter_hallucinations: true,
    min_input_rms: 0.002,
    sherpa_model_dir: "models/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8",
    sherpa_model_type: "nemo_ctc",
    sherpa_provider: "cpu",
    sherpa_language: "ja",
    en: {
      // 英語モードでは whisper の多言語モデルへ切り替える（sherpa の日本語専用モデルを避ける）
      engine: "whisper",
      language: "en",
      sherpa_language: "en",
    },
  },
  llm: {
    endpoint: "http://127.0.0.1:11434",
    model: "gemma4:e2b-it-qat",
    character_file: "config/characters/sakura.toml",
    temperature: 0.7,
    max_tokens: 512,
    response_timeout_seconds: 60,
    model_load_timeout_seconds: 180,
    history_turns: 6,
    character_file_en: "config/characters/sakura.en.toml",
    keep_alive: "30m",
    num_ctx: 4096,
  },
  tts: {
    engine: "voicevox",
    endpoint: "http://127.0.0.1:50021",
    speaker_id: 2,
    speed: 1.0,
    pitch: 0.0,
    volume: 1.0,
    timeout_seconds: 30,
    split_sentences: true,
    prefetch_depth: 1,
    min_sentence_chars: 4,
    max_sentence_chars: 60,
    en: {
      engine: "openai_speech",
      endpoint: "http://127.0.0.1:8880",
      model: "kokoro",
      voice: "af_heart",
      speaker_id: 0,
      speed: 1.0,
      reference_wav: "",
      reference_text: "",
      prompt_lang: "en",
    },
    ja: {},
    voice_conversion: {
      enabled: false,
      endpoint: "http://127.0.0.1:9890",
      model_path: "",
      index_path: "",
      pitch: 0,
      f0_method: "rmvpe",
      index_rate: 0.75,
      protect: 0.33,
      timeout_seconds: 60,
    },
  },
  avatar: {
    enabled: true,
    model_path: "live2d-models/hiyori/hiyori.model3.json",
    sprite_image: "",
    scale: 1.0,
    offset_x: 0.5,
    offset_y: 0.85,
    background: "linear-gradient(160deg, #f6e3c5 0%, #e3cbaa 45%, #b99a75 100%)",
    idle_motion_interval_seconds: 20,
    lip_sync_smoothing: 0.4,
    lip_sync_gain: 1.0,
    emotion_tags_enabled: true,
    emotion_heuristic_enabled: true,
    expressions: { happy: "", angry: "", sad: "", surprised: "", shy: "", thinking: "" },
    emotion_styles: { happy: "", angry: "", sad: "" },
    motions: { greeting: "", nod: "" },
  },
  rag: {
    enabled: true,
    data_dir: "data",
    embedding_model: "nomic-embed-text",
    top_k: 3,
    similarity_threshold: 0.3,
  },
  recipe_db: {
    enabled: true,
    db_path: "data/recipedb/recipes.sqlite",
    master_dir: "data/recipedb",
  },
  music: {
    spotify_client_id: "",
    spotify_redirect_uri: "http://localhost:8765/callback",
    local_music_dir: "music",
    default_volume: 0.7,
    volume_step: 0.1,
    duck_on_wakeword: true,
    duck_volume: 0.15,
  },
  gui: {
    user_name: "You",
    debug_mode: false,
    trace_turns: false,
    outfit: "home",
    layout: "chat",
    caption_enabled: true,
    caption_font_size: 34,
  },
  apps: {
    proactive_speech: {
      categories: {
        briefing: { enabled: true, voice: true, ui: true },
        reminder: { enabled: true, voice: true, ui: true },
        alert: { enabled: true, voice: true, ui: true },
        family_memo: { enabled: true, voice: false, ui: true },
        system: { enabled: true, voice: false, ui: true },
      },
      triggers: {
        demo: {
          enabled: false,
          fire_time: "07:00",
          text: "プロアクティブ発話デモ: 設定通りに発火しました",
        },
        morning_briefing: {
          enabled: false,
          fire_time: "07:00",
          include_weather: true,
          include_calendar: true,
          include_shopping: true,
          include_news: false,
          news_url: "http://127.0.0.1:5000",
          news_new_only: true,
        },
      },
    },
    home_assistant: {
      base_url: "",
      token: "",
    },
  },
};

