import type { AssistantState, ChatMessage, PipelineEvent } from "../../shared/protocol";
import { ConfigManager } from "../config/ConfigManager";
import { LlmMessage } from "../core/messages";
import {
  AudioIO,
  CaptureHandle,
  LanguageModel,
  PlaybackHandle,
  SpeechToText,
  TextToSpeech,
} from "../core/ports";
import { Logger } from "../core/logger";
import { wavDurationMs } from "../services/wav";
import { ConversationHistory } from "./ConversationHistory";
import { PromptBuilder } from "./PromptBuilder";

/** 中断起因のエラーか（AbortController / socket 由来） */
function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || /abort/i.test(error.message);
  }
  return false;
}

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

  constructor(private readonly deps: PipelineDeps) {}

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
    if (this.busy) {
      this.emit({
        type: "error",
        scope: "pipeline",
        message: "現在応答中です。完了してからもう一度お試しください。",
      });
      return;
    }
    this.emit({ type: "wakeword_detected", phrase });
    this.deps.history.setMaxTurns(this.deps.config.getLLM().history_turns);
    await this.runLoop({});
  }

  /** テキスト入力（音声認識をスキップして応答する） */
  async submitText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (this.busy) {
      this.emit({
        type: "error",
        scope: "pipeline",
        message: "現在応答中です。完了してからもう一度お試しください。",
      });
      return;
    }
    this.deps.history.setMaxTurns(this.deps.config.getLLM().history_turns);
    await this.runLoop({ initialText: trimmed });
  }

  /** 読み上げのみ（会話履歴には残さない） */
  async speak(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (this.busy) {
      this.emit({ type: "error", scope: "pipeline", message: "現在応答中です。" });
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

  /**
   * ターンループ本体。バージイン発話・フォローアップをまたいで継続する。
   */
  /** ブラウザから送られた発話（WAV）を 1 ターン処理する */
  async submitAudio(wav: Buffer): Promise<void> {
    if (this.busy) {
      this.emit({
        type: "error",
        scope: "pipeline",
        message: "現在応答中です。完了してからもう一度お試しください。",
      });
      return;
    }
    this.busy = true;
    this.active = true;
    this.turnCounter = 0;
    this.deps.history.setMaxTurns(this.deps.config.getLLM().history_turns);

    try {
      const text = await this.transcribe(wav);
      if (!text || !this.active) {
        return;
      }
      this.turnCounter += 1;
      await this.respond(text);
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

  /** 音声を認識してテキストを返す（失敗時は null。エラーはイベントで通知する） */
  private async transcribe(wav: Buffer): Promise<string | null> {
    this.setState("transcribing");
    this.emit({ type: "stt_started" });
    try {
      const controller = this.newAbort();
      const transcript = await this.deps.stt.transcribe(wav, { signal: controller.signal });
      if (!this.active) {
        return null;
      }
      const text = transcript.text.trim();
      if (!text) {
        // 認識結果が空のときは UI に空の吹き出しを出さない
        this.emit({
          type: "error",
          scope: "stt",
          message: "音声を認識できませんでした。もう一度お話しください。",
        });
        return null;
      }
      this.emit({
        type: "stt_complete",
        text,
        language: transcript.language,
        elapsedMs: transcript.elapsedMs,
      });
      return text;
    } catch (error) {
      if (!this.active || isAbortError(error)) {
        return null;
      }
      this.emitError("stt", error);
      return null;
    }
  }

  private async runLoop(options: { initialWav?: Buffer; initialText?: string }): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.active = true;
    this.turnCounter = 0;

    const conv = this.deps.config.getConversation();
    const audio = this.deps.config.getAudio();
    let pendingWav = options.initialWav;
    let pendingText = options.initialText;
    let followup = 0;

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
            // 応答直後は自分の声を拾わないよう少し待つ
            if (followup > 0) {
              await this.sleep(conv.followup_guard_ms);
              if (!this.active) {
                break;
              }
            }

            this.setState("recording");
            this.emit({ type: "recording_started" });
            const startTimeoutMs =
              (followup > 0 ? conv.followup_timeout_seconds : audio.no_speech_timeout) * 1000;
            let lastLevelAt = 0;
            const capture = this.deps.audio.capture({
              maxDurationMs: audio.max_record_seconds * 1000,
              startTimeoutMs,
              onLevel: (level, threshold) => {
                const now = Date.now();
                if (now - lastLevelAt < 100) {
                  return; // UI へは 10Hz 程度に間引いて送る
                }
                lastLevelAt = now;
                this.emit({
                  type: "level",
                  level: Number(level.toFixed(3)),
                  threshold: Number(threshold.toFixed(3)),
                });
              },
            });
            this.capture = capture;
            const result = await capture.result;
            this.capture = null;
            this.emit({
              type: "recording_stopped",
              durationMs: result.durationMs,
              reason: result.reason,
            });

            if (!this.active) {
              break;
            }
            if (!result.hasSpeech) {
              if (result.reason === "device_error") {
                this.emit({
                  type: "error",
                  scope: "audio",
                  message:
                    "マイク入力を開始できませんでした。音声デバイスの設定（audio.input_device）を確認してください。",
                });
              } else if (result.frames === 0 && result.reason !== "aborted") {
                this.emit({
                  type: "error",
                  scope: "audio",
                  message:
                    "マイクから音声データが取得できませんでした（他アプリがマイクを使用中／ミュート／デバイス設定を確認してください）。",
                });
              } else if (
                followup === 0 &&
                result.peakLevel !== undefined &&
                result.peakLevel < audio.silence_threshold * 0.5
              ) {
                // 録音はできているがレベルがほぼ 0（ミュート・入力レベル 0 など）
                this.emit({
                  type: "error",
                  scope: "audio",
                  message: `マイクの入力レベルがほぼ 0 です（peak=${result.peakLevel}）。Windows のサウンド設定でミュート／入力レベルを確認してください。`,
                });
              }
              break;
            }
            wav = result.wav;
          }

          const recognized = await this.transcribe(wav);
          if (recognized === null) {
            break;
          }
          text = recognized;
        }

        this.turnCounter += 1;
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
  private async respond(userText: string): Promise<Buffer | undefined> {
    this.deps.history.add("user", userText);
    this.emitHistory();

    this.setState("thinking");
    this.emit({ type: "llm_started" });
    const llmStartedAt = Date.now();
    let reply = "";
    try {
      const controller = this.newAbort();
      reply = await this.deps.llm.chatStream(
        this.buildMessages(),
        (delta) => {
          this.emit({ type: "llm_delta", content: delta });
        },
        { signal: controller.signal }
      );
    } catch (error) {
      if (isAbortError(error)) {
        return undefined;
      }
      this.emitError("llm", error);
      return undefined;
    }

    reply = reply.trim();
    this.emit({ type: "llm_complete", text: reply, elapsedMs: Date.now() - llmStartedAt });
    if (!reply) {
      this.emit({ type: "error", scope: "llm", message: "LLM の応答が空でした" });
      return undefined;
    }
    this.deps.history.add("assistant", reply);
    this.emitHistory();

    this.setState("speaking");
    this.emit({ type: "tts_started" });
    const ttsStartedAt = Date.now();
    let wav: Buffer;
    try {
      const controller = this.newAbort();
      wav = await this.deps.tts.synthesize(reply, { signal: controller.signal });
    } catch (error) {
      if (isAbortError(error)) {
        return undefined;
      }
      this.emitError("tts", error);
      return undefined;
    }
    this.emit({ type: "tts_complete", elapsedMs: Date.now() - ttsStartedAt });

    return this.playWithBargeIn(wav);
  }

  /**
   * 再生とバージイン監視。
   * 再生中に発話を検知したら再生を止め、その発話を次ターンの入力として返す。
   */
  private async playWithBargeIn(wav: Buffer): Promise<Buffer | undefined> {
    const conv = this.deps.config.getConversation();
    const audio = this.deps.config.getAudio();

    const playback = this.deps.audio.play(wav);
    this.playback = playback;
    this.emit({ type: "speaking_started" });

    if (!conv.barge_in_enabled || audio.input_mode === "browser") {
      // ブラウザ入力モードでは、クライアントがマイクを監視して stop_speaking を送る
      await playback.finished;
      this.playback = null;
      this.emit({ type: "speaking_finished" });
      return undefined;
    }

    let bargedIn = false;
    const playbackMs = Math.max(1000, wavDurationMs(wav, audio.sample_rate));
    const capture = this.deps.audio.capture({
      maxDurationMs: playbackMs + audio.max_record_seconds * 1000,
      // バージインは応答音声を拾わないよう通常より高めのしきい値を使う
      threshold: Math.max(audio.silence_threshold, conv.barge_in_min_score),
      onSpeechStart: () => {
        bargedIn = true;
        playback.stop();
      },
    });
    this.capture = capture;

    await playback.finished;
    this.playback = null;

    if (!bargedIn) {
      capture.stop("aborted");
      await capture.result.catch(() => undefined);
      this.capture = null;
      this.emit({ type: "speaking_finished" });
      return undefined;
    }

    this.emit({ type: "barge_in" });
    this.emit({ type: "speaking_finished" });
    const result = await capture.result;
    this.capture = null;
    return this.active && result.hasSpeech ? result.wav : undefined;
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

  private buildMessages(): LlmMessage[] {
    return [
      { role: "system", content: this.deps.promptBuilder.build() },
      ...this.deps.history.forPrompt(),
    ];
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
