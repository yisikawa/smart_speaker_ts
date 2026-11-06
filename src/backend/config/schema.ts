/**
 * 設定スキーマ（単一の真実源）。
 *
 * - 型定義と既定値を同一ファイルに置き、既定値の欠落をコンパイル時に検出する
 * - 設定ファイル（TOML）はこの型に対して部分指定できる（深いマージで補完）
 */

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
}

export interface WakewordConfig {
  /** ウェイクワードモデル（.rpw 等）。空配列ならエンジン無効 */
  wakeword_path: string[];
  threshold: number;
  avg_threshold: number;
  min_scores: number;
}

export interface ConversationConfig {
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
export type SttEngine = "whisper" | "sherpa";

/** sherpa-onnx のモデル種別（使用する ONNX 一式の構成を決める） */
export type SherpaModelType = "nemo_transducer" | "nemo_ctc" | "sense_voice" | "zipformer_transducer";

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
}

export interface LLMConfig {
  endpoint: string;
  model: string;
  character_file: string;
  temperature: number;
  max_tokens: number;
  response_timeout_seconds: number;
  /** プロンプトに含める直近ターン数 */
  history_turns: number;
}

export interface TTSConfig {
  engine: "voicevox";
  endpoint: string;
  speaker_id: number;
  speed: number;
  pitch: number;
  volume: number;
  /** 音声合成タイムアウト（秒） */
  timeout_seconds: number;
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
  },
  wakeword: {
    wakeword_path: [],
    threshold: 0.55,
    avg_threshold: 0.4,
    min_scores: 3,
  },
  conversation: {
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
  },
  llm: {
    endpoint: "http://127.0.0.1:11434",
    model: "gemma4:e2b-it-qat",
    character_file: "config/characters/sakura.toml",
    temperature: 0.7,
    max_tokens: 512,
    response_timeout_seconds: 60,
    history_turns: 6,
  },
  tts: {
    engine: "voicevox",
    endpoint: "http://127.0.0.1:50021",
    speaker_id: 2,
    speed: 1.0,
    pitch: 0.0,
    volume: 1.0,
    timeout_seconds: 30,
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

