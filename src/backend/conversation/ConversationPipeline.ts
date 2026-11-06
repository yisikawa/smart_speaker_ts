import type {
  AssistantState,
  CaptureStats,
  ChatMessage,
  PipelineEvent,
  SkipStats,
} from "../../shared/protocol";
import { ConfigManager } from "../config/ConfigManager";
import {
  AudioIO,
  CaptureHandle,
  LanguageModel,
  PlaybackHandle,
  SpeechToText,
  TextToSpeech,
} from "../core/ports";
import { Logger } from "../core/logger";
import { ConversationHistory } from "./ConversationHistory";
import { ListeningHooks, ListeningLoop } from "./ListeningLoop";
import { PlaybackLoop } from "./PlaybackLoop";
import { PromptBuilder } from "./PromptBuilder";
import { SpeechGate } from "./SpeechGate";
import { TurnHooks, TurnRunner } from "./TurnRunner";
import { TranscriptionOutcome, TranscriptionRunner } from "./TranscriptionRunner";

/** 連続して破棄されたときに聞き取りを諦める回数（無限ループ防止） */
const MAX_CONSECUTIVE_SKIPS = 3;

export interface PipelineDeps {
  config: ConfigManager;
  history: ConversationHistory;
  promptBuilder: PromptBuilder;
  audio: AudioIO;
  stt: SpeechToText;
  llm: LanguageModel;
  tts: TextToSpeech;
  logger: Logger;
}

export type PipelineListener = (event: PipelineEvent) => void;

/**
 * 会話パイプライン（状態機械）。
 *
 * idle → recording → transcribing → thinking → speaking → (followup) → idle
 *
 * - 録音は VAD により「発話開始〜無音」で自動区切る（固定 10 秒録音は廃止）
 * - フォローアップ（連続会話）とバージイン（発話で再生を中断）に対応
 * - すべての処理は AbortController で中断可能
 */
export class ConversationPipeline {
  private readonly listeners = new Set<PipelineListener>();
  private state: AssistantState = "idle";
  /** ターンループを継続するか */
  private active = false;
  /** ターンループ実行中か（多重起動防止） */
  private busy = false;
  private abort: AbortController | null = null;
  private capture: CaptureHandle | null = null;
  private playback: PlaybackHandle | null = null;
  private turnCounter = 0;
  /** 認識結果の採否（幻聴・エコー・短断片・繰り返し） */
  private readonly gate = new SpeechGate();
  /** 1 ターン分の実行（LLM → TTS → 再生） */
  private readonly turnRunner: TurnRunner;
  /** 1 回分の録音（VAD・レベル通知・失敗案内） */
  private readonly listening: ListeningLoop;
  /** 読み上げとバージイン監視 */
  private readonly playbackLoop: PlaybackLoop;
  /** 音声認識と採否判定 */
  private readonly transcription: TranscriptionRunner;

  constructor(private readonly deps: PipelineDeps) {
    this.turnRunner = new TurnRunner({
      config: deps.config,
      history: deps.history,
      promptBuilder: deps.promptBuilder,
      llm: deps.llm,
      tts: deps.tts,
      logger: deps.logger,
    });
    this.listening = new ListeningLoop({ config: deps.config, audio: deps.audio });
    this.playbackLoop = new PlaybackLoop({ config: deps.config, audio: deps.audio });
    this.transcription = new TranscriptionRunner({ stt: deps.stt, gate: this.gate, logger: deps.logger });
  }

  /** ListeningLoop に渡すコールバック（状態・イベント・録音ハンドルの橋渡し） */
  private listeningHooks(): ListeningHooks {
    return {
      emit: (event) => this.emit(event),
      setState: (state) => this.setState(state),
      onCapture: (handle) => {
        this.capture = handle;
      },
      isActive: () => this.active,
    };
  }

  on(listener: PipelineListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): AssistantState {
    return this.state;
  }

  getHistory(): ChatMessage[] {
    return this.deps.history.all();
  }

  /** 障害切り分け用のスナップショット（`/api/diagnostics` が使う） */
  getDiagnostics(): {
    state: AssistantState;
    busy: boolean;
    skips: SkipStats;
    lastSkip: { reason: string; text: string; at: number } | null;
    capture: CaptureStats | null;
  } {
    return {
      state: this.state,
      busy: this.busy,
      skips: this.gate.stats,
      lastSkip: this.gate.lastSkip,
      capture: this.listening.captureStats,
    };
  }

  get isBusy(): boolean {
    return this.busy;
  }

  clearHistory(): void {
    this.deps.history.clear();
    this.turnCounter = 0;
    this.emitHistory();
  }

  /** 起動時の初期化（auto_start が有効なら自動でターンを開始） */
  start(): void {
    if (this.deps.config.getConversation().auto_start) {
      void this.handleWakeWord("起動");
      return;
    }
    this.setState("idle");
  }

  /** ウェイクワード（または UI の「聞き取り開始」）からターンループを開始する */
  async handleWakeWord(phrase = "ウェイクワード"): Promise<void> {
    if (this.deps.config.getAudio().input_mode === "browser") {
      this.emit({
        type: "error",
        scope: "pipeline",
        message:
          "音声入力はブラウザのマイクを使用しています。画面の「聞き取り開始」から操作してください。",
      });
      return;
    }
    if (this.rejectIfBusy()) {
      return;
    }
    this.emit({ type: "wakeword_detected", phrase });
    await this.startTurn({});
  }

  /** テキスト入力（音声認識をスキップして応答する） */
  async submitText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.rejectIfBusy()) {
      return;
    }
    await this.startTurn({ initialText: trimmed });
  }

  /** 読み上げのみ（会話履歴には残さない） */
  async speak(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.rejectIfBusy("現在応答中です")) {
      return;
    }
    this.busy = true;
    this.active = true;
    try {
      this.setState("speaking");
      this.emit({ type: "tts_started" });
      const started = Date.now();
      const controller = this.newAbort();
      const wav = await this.deps.tts.synthesize(trimmed, { signal: controller.signal });
      this.emit({ type: "tts_complete", elapsedMs: Date.now() - started });
      const playback = this.deps.audio.play(wav);
      this.playback = playback;
      this.emit({ type: "speaking_started" });
      await playback.finished;
      this.emit({ type: "speaking_finished" });
    } catch (error) {
      this.emitError("tts", error);
    } finally {
      this.playback = null;
      this.busy = false;
      this.active = false;
      this.setState("idle");
    }
  }

  /** 進行中の処理を中断する（録音・推論・再生すべて） */
  stop(): void {
    this.active = false;
    this.abort?.abort();
    this.capture?.stop("aborted");
    this.playback?.stop();
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.deps.audio.dispose();
  }

  /** ブラウザから送られた発話（WAV）を 1 ターン処理する */
  async submitAudio(wav: Buffer): Promise<void> {
    if (this.rejectIfBusy()) {
      return;
    }
    this.busy = true;
    this.active = true;
    this.turnCounter = 0;
    this.deps.history.setMaxTurns(this.deps.config.getLLM().history_turns);

    try {
      const outcome = await this.transcribe(wav);
      if (outcome.kind === "ignored") {
        // 破棄したことをクライアントへ伝える（伝えないと「応答待ち」のまま固まる）
        this.emit({ type: "turn_skipped", reason: outcome.reason });
        return;
      }
      if (outcome.kind !== "text") {
        return;
      }
      if (!this.active) {
        this.deps.logger.warn("応答前に停止されたため、このターンは破棄しました");
        return;
      }
      this.turnCounter += 1;
      await this.respond(outcome.text);
      if (this.active) {
        this.emit({ type: "turn_complete", turn: this.turnCounter });
      }
    } finally {
      this.active = false;
      this.busy = false;
      this.abort = null;
      this.playback = null;
      this.setState("idle");
    }
  }

  /** 再生のみ停止する（ブラウザからのバージイン用） */
  stopSpeaking(): void {
    this.playback?.stop();
  }

  /** 音声を認識する（実装は `TranscriptionRunner`。破棄は `ignored` として返る） */
  private transcribe(wav: Buffer): Promise<TranscriptionOutcome> {
    const controller = this.newAbort();
    return this.transcription.run(wav, {
      signal: controller.signal,
      hooks: {
        setState: (state) => this.setState(state),
        emit: (event) => this.emit(event),
        onError: (scope, error) => this.emitError(scope, error),
        isActive: () => this.active,
      },
    });
  }

  /** 応答中ならエラーを通知して true を返す（多重実行の防止） */
  private rejectIfBusy(message = "現在応答中です。完了してからもう一度お試しください。"): boolean {
    if (!this.busy) {
      return false;
    }
    this.emit({ type: "error", scope: "pipeline", message });
    return true;
  }

  /** ターンループを開始する（履歴の上限を設定してから実行） */
  private startTurn(options: { initialWav?: Buffer; initialText?: string }): Promise<void> {
    this.deps.history.setMaxTurns(this.deps.config.getLLM().history_turns);
    return this.runLoop(options);
  }

  private async runLoop(options: { initialWav?: Buffer; initialText?: string }): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.active = true;
    this.turnCounter = 0;

    const conv = this.deps.config.getConversation();
    let pendingWav = options.initialWav;
    let pendingText = options.initialText;
    let followup = 0;
    /** 幻聴・エコーとして破棄した連続回数 */
    let ignoredCount = 0;

    try {
      while (this.active) {
        let wav = pendingWav;
        pendingWav = undefined;
        let text: string | null = null;

        if (pendingText !== undefined) {
          text = pendingText;
          pendingText = undefined;
        } else {
          if (!wav) {
            const captured = await this.listening.capture(this.listeningHooks(), { followup: followup > 0 });
            if (!captured) {
              break;
            }
            wav = captured;
          }

          const outcome = await this.transcribe(wav);
          if (outcome.kind === "empty") {
            break;
          }
          if (outcome.kind === "ignored") {
            // 幻聴・自分の声・同じ結果は会話に載せず、聞き取りを続ける。
            // ただし連続で破棄され続ける場合はループを抜ける（無限ループ防止）。
            this.emit({ type: "turn_skipped", reason: outcome.reason });
            ignoredCount += 1;
            if (ignoredCount >= MAX_CONSECUTIVE_SKIPS) {
              this.deps.logger.warn("破棄が続くため聞き取りを停止します");
              break;
            }
            continue;
          }
          text = outcome.text;
        }

        this.turnCounter += 1;
        ignoredCount = 0;
        const bargeWav = await this.respond(text);
        if (!this.active) {
          break;
        }
        this.emit({ type: "turn_complete", turn: this.turnCounter });

        if (bargeWav) {
          // バージインで取得した発話をそのまま次のターンとして処理する
          pendingWav = bargeWav;
          followup = 0;
          continue;
        }

        // ブラウザ入力モードでは録音をクライアントが駆動する。
        // サーバー側で ffmpeg を開くとマイクを奪い、busy も残るため、ここでループを終える。
        if (this.deps.config.getAudio().input_mode === "browser") {
          break;
        }

        if (!conv.followup_enabled) {
          break;
        }
        const maxFollowupTurns = conv.keep_listening
          ? Number.POSITIVE_INFINITY
          : conv.max_followup_turns;
        if (followup >= maxFollowupTurns) {
          break;
        }
        followup += 1;
        if (followup <= conv.max_followup_turns) {
          this.emit({
            type: "followup_wait",
            turn: followup,
            maxTurns: conv.max_followup_turns,
            timeoutMs: conv.followup_timeout_seconds * 1000,
          });
        }
        this.setState("recording");
      }
    } finally {
      this.capture = null;
      this.playback = null;
      this.active = false;
      this.busy = false;
      this.abort = null;
      this.setState("idle");
    }
  }

  /** 1 ターン分の応答生成（LLM → TTS → 再生）。バージイン発話があれば WAV を返す */
  private respond(userText: string): Promise<Buffer | undefined> {
    const controller = this.newAbort();
    const hooks: TurnHooks = {
      setState: (state) => this.setState(state),
      emit: (event) => this.emit(event),
      onError: (scope, error) => this.emitError(scope, error),
      onHistoryChanged: () => this.emitHistory(),
      onReply: (reply) => {
        this.gate.rememberReply(reply);
        // 応答が成立したので「同じ発話の連続」カウントをリセットする
        // （幻聴ループ対策の判定が、正当な聞き返しまで落とさないようにする）
        this.gate.resetRepeat();
      },
      play: (wav) => this.playWithBargeIn(wav),
    };
    return this.turnRunner.run(userText, hooks, controller.signal);
  }

  /**
   * 再生とバージイン監視（実装は `PlaybackLoop`）。
   * 再生中に発話を検知したら再生を止め、その発話を次ターンの入力として返す。
   */
  private playWithBargeIn(wav: Buffer): Promise<Buffer | undefined> {
    return this.playbackLoop.play(wav, {
      emit: (event) => this.emit(event),
      onPlayback: (handle) => {
        this.playback = handle;
      },
      onCapture: (handle) => {
        this.capture = handle;
      },
      isActive: () => this.active,
    });
  }

  private newAbort(): AbortController {
    this.abort = new AbortController();
    return this.abort;
  }

  private setState(next: AssistantState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.emit({ type: "state", state: next });
  }

  private emit(event: PipelineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.deps.logger.error("イベントリスナーでエラー", error);
      }
    }
  }

  private emitError(scope: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.deps.logger.error(`[${scope}] ${message}`);
    this.emit({ type: "error", scope, message });
  }

  private emitHistory(): void {
    this.emit({ type: "history_updated", messages: this.deps.history.all() });
  }
}
