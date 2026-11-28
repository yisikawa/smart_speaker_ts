import type {
  AssistantState,
  ClientCommand,
  DiagnosticsReport,
  HelloPayload,
  LanguageMode,
  PipelineEvent,
  ServerMessage,
} from "../shared/protocol";
import { getLanguagePack, isLanguageMode } from "../shared/i18n/languagePack";
import { errorText } from "../shared/errorText";
import { ChatView } from "./ChatView";
import { AudioPlayer } from "./AudioPlayer";
import { LipSyncDriver } from "./avatar/LipSyncDriver";
import { MenuDrawer } from "./MenuDrawer";
import { MicLoop } from "./MicLoop";
import { StageView } from "./StageView";
import { parseStageOptions } from "../shared/ui/stageMode";
import { SettingsPanel } from "./SettingsPanel";
import { WsClient } from "./WsClient";

/**
 * 画面の組み立て（Composition Root）。
 *
 * - 描画: `ChatView`
 * - 通信: `WsClient`（接続・再接続・hello 待ち）
 * - 録音: `MicLoop`（ブラウザのマイク・フォローアップ・バージイン監視）
 *
 * ここは「イベントを誰に渡すか」だけを持ち、DOM 操作・通信・録音の詳細は各担当に任せる。
 */
/** 言語切替を拒否する状態（録音・認識・生成・読み上げの最中） */
const LANGUAGE_SWITCH_BLOCKED: readonly AssistantState[] = [
  "recording",
  "transcribing",
  "thinking",
  "speaking",
];

class SumikaApp {
  private readonly view = new ChatView();
  private readonly ws: WsClient;
  private readonly micLoop: MicLoop;
  /** 設定メニュー（STT / LLM のモデル切り替え） */
  private readonly settings: SettingsPanel;
  /** ハンバーガーメニュー（左ドロワー） */
  private readonly menu = new MenuDrawer();
  /** ブラウザ再生（tts_audio）のキュー。`playbackTarget=browser` のときだけ作る */
  private audioPlayer: AudioPlayer | null = null;
  /** 配信向けステージ（アバター + 字幕） */
  private readonly stage = new StageView();
  private lipSync: LipSyncDriver | null = null;
  /** 字幕の組み立て用バッファ */
  private caption = "";
  /** 現在の音声入力方式（hello で更新。疎通表示に使う） */
  private inputMode: "browser" | "server" = "browser";
  /** 現在の応答言語（hello / language 通知で更新） */
  private language: LanguageMode = "ja";
  /** 現在の状態（言語切替を禁止する判定に使う） */
  private assistantState: AssistantState = "idle";
  /** 診断パネルを開いているか */
  private diagnosticsOpen = false;

  constructor() {
    this.ws = new WsClient({
      onOpen: () => {
        this.view.setServicesText("接続済み（状態を取得中…）");
        this.view.showToast("サーバーに接続しました", "info");
      },
      onMessage: (message) => this.handleMessage(message),
      onClose: () => {
        // 再接続でマイクや AudioContext が二重に開かないよう、先に解放する
        void this.micLoop.shutdown();
        this.audioPlayer?.stop();
        this.view.setServicesText("サーバー未接続（再接続中…）", true);
        this.setAssistantState("error");
        this.view.showToast("サーバーとの接続が切れました（再接続します）", "error");
      },
      onHelloTimeout: () => {
        if (this.view.servicesEl.textContent?.startsWith("接続済み")) {
          this.view.setServicesText("サーバーの応答がありません（ページを再読み込みしてください）", true);
        }
      },
    });
    this.micLoop = new MicLoop({
      view: this.view,
      send: (command) => this.send(command),
      isConnected: () => this.ws.isOpen,
      // 録音はブラウザが駆動するため、状態もここへ集約する（言語切替の判定と表示をずらさない）
      onStateChange: (state) => this.setAssistantState(state),
      // バージイン検出時はサーバーの応答を待たずにローカル再生を止める
      onBargeIn: () => this.audioPlayer?.stop(),
    });
    this.settings = new SettingsPanel(this.view, () => this.inputMode);
  }

  start(): void {
    this.stage.apply(parseStageOptions(window.location.search ?? ""));
    this.menu.bind();
    this.menu.close();
    this.bindEvents();
    this.settings.bind();
    // ページ破棄時にマイクと AudioContext を残さない（次回の起動で「使用中」にならない）
    window.addEventListener("beforeunload", () => {
      void this.micLoop.shutdown();
      this.audioPlayer?.dispose();
    });
    // connect() より先に初期状態を設定する（未接続時の表示を上書きしないため）
    this.setAssistantState("idle");
    this.connect();
  }

  private connect(): void {
    // start.bat を使わずに HTML を直接開いた場合は WebSocket を張れないため、明示する
    if (this.ws.isUnsupportedEnvironment) {
      this.view.setServicesText("未接続（start.bat で起動し、表示された URL を開いてください）", true);
      this.view.statusEl.className = "status error";
      this.view.statusEl.textContent = "未接続";
      return;
    }
    this.ws.connect();
  }

  private bindEvents(): void {
    const view = this.view;
    view.btnListen.addEventListener("click", () => {
      void this.audioPlayer?.prime();
      // ブラウザ入力モードでは、この画面がマイクを開いて発話単位で送信する
      if (this.micLoop.isBrowserMode) {
        void this.micLoop.start();
        return;
      }
      this.send({ type: "start_listening" });
    });
    view.btnStop.addEventListener("click", () => {
      void this.audioPlayer?.prime();
      this.audioPlayer?.stop();
      this.micLoop.stop();
      this.send({ type: "stop_listening" });
    });
    view.btnClear.addEventListener("click", () => this.send({ type: "clear_history" }));
    view.btnSend.addEventListener("click", () => {
      void this.audioPlayer?.prime();
      this.submitText();
    });
    view.btnMicTest.addEventListener("click", () => {
      void this.micLoop.checkMic();
    });
    view.btnDiagnostics.addEventListener("click", () => {
      void this.showDiagnostics();
    });
    view.languageSelect.addEventListener("change", () => {
      const next = view.languageSelect.value;
      if (isLanguageMode(next)) {
        void this.changeLanguage(next);
      }
    });
    view.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.submitText();
      }
    });
    view.deviceSelect.addEventListener("change", () => {
      if (this.micLoop.isBrowserMode) {
        void this.micLoop.switchDevice();
      }
    });
  }

  private submitText(): void {
    const text = this.view.inputEl.value.trim();
    if (!text) {
      return;
    }
    this.send({ type: "submit_text", text });
    this.view.inputEl.value = "";
  }

  private send(command: ClientCommand): void {
    if (!this.ws.send(command)) {
      this.view.showToast("サーバーに接続されていません", "error");
    }
  }

  /**
   * 言語モードを切り替える（設定へ保存し、次回以降の発話から有効）。
   *
   * サーバーは config 変更を検知して STT / TTS を再構成し、
   * 全クライアントへ `language` 通知を配る（ここでは楽観的に表示も更新する）。
   */
  /**
   * 状態表示を更新する（`assistantState` と `ChatView` を同時に更新する唯一の経路）。
   *
   * 言語切替の可否は `assistantState` で判定するため、`view.setState()` を直接呼ぶと
   * 判定と表示がずれる。ブラウザ駆動の録音も `MicLoop` からここを通す。
   */
  private setAssistantState(state: AssistantState): void {
    this.assistantState = state;
    this.view.setState(state);
  }

  private async changeLanguage(language: LanguageMode): Promise<void> {
    // 録音〜読み上げの最中に切り替えると、残りの文が新しい言語の声で読まれてしまう。
    // `error` / `waiting_wakeword` は「応答中」ではないので許可する（切り替え不能で固まらないように）
    if (LANGUAGE_SWITCH_BLOCKED.includes(this.assistantState)) {
      this.view.languageSelect.value = this.language;
      this.view.showToast("応答中は言語を切り替えられません（停止してから切り替えてください）", "info");
      return;
    }
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation: { language } }),
      });
      if (!res.ok) {
        throw new Error(`/api/config が ${res.status} を返しました`);
      }
      this.applyLanguage(language);
      const pack = getLanguagePack(language);
      this.view.showToast(pack.ui.switchedToast(pack.label), "info");
    } catch (error) {
      // 失敗したら表示を元へ戻す
      this.view.languageSelect.value = this.language;
      this.view.showToast(`言語を切り替えられませんでした: ${errorText(error)}`, "error");
    }
  }

  /** 言語表示（セレクト・キャラクター名）を反映する */
  private applyLanguage(language: LanguageMode): void {
    this.language = language;
    this.view.languageSelect.value = language;
  }

  /** 診断情報（/api/diagnostics）を取得して表示する。もう一度押すと閉じる */
  private async showDiagnostics(): Promise<void> {
    if (this.diagnosticsOpen) {
      this.diagnosticsOpen = false;
      this.view.renderDiagnostics(null);
      return;
    }
    try {
      const res = await fetch("/api/diagnostics");
      if (!res.ok) {
        throw new Error(`/api/diagnostics が ${res.status} を返しました`);
      }
      const report = (await res.json()) as DiagnosticsReport;
      this.diagnosticsOpen = true;
      this.view.renderDiagnostics(formatDiagnostics(report));
    } catch (error) {
      this.view.showToast(`診断情報を取得できませんでした: ${errorText(error)}`, "error");
    }
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "hello":
        this.applyHello(message);
        break;
      case "state":
        this.setAssistantState(message.state);
        break;
      case "history":
        this.view.renderHistory(message.messages);
        break;
      case "language":
        this.applyLanguage(message.language);
        this.view.setCharacter(message.character.name, message.character.label);
        break;
      case "event":
        this.handleEvent(message.event);
        break;
      case "error":
        this.view.showToast(message.message, "error");
        break;
      case "pong":
        break;
    }
  }

  private applyHello(hello: HelloPayload): void {
    this.ws.helloReceived();
    // 再接続時は旧インスタンスを必ず止める（AudioContext・口パクのリーク防止）
    this.lipSync?.stop();
    this.lipSync = null;
    this.audioPlayer?.dispose();
    this.audioPlayer = null;
    this.view.setServicesText("");
    this.applyLanguage(hello.language ?? "ja");
    this.view.setNames(hello.character.name, hello.user);
    this.view.setCharacter(hello.character.name, hello.character.label);
    this.view.setVersion(hello.version);
    this.inputMode = hello.audio.inputMode;
    this.micLoop.configure(hello.audio);
    if (hello.audio.inputMode === "browser") {
      void this.micLoop.refreshDevices();
    }
    this.view.renderHistory(hello.history);
    this.view.renderServices(hello.services, hello.audio.inputMode, hello.models);
    this.settings.updateSelection(hello.models);
    this.setAssistantState(hello.state);
    if (hello.audio.playbackTarget === "browser") {
      this.audioPlayer = new AudioPlayer({ send: (command) => this.send(command) });
      this.audioPlayer.configure(hello.audio);
    }

    if (hello.avatar) {
      void this.stage.mountAvatar(hello.avatar);
    }
    if (this.audioPlayer && hello.avatar) {
      this.lipSync = new LipSyncDriver({
        player: this.audioPlayer,
        onLevel: (level) => this.stage.setMouth(level),
        smoothing: hello.avatar.lipSync.smoothing,
      });
      this.lipSync.start();
    }
  }

  private handleEvent(event: PipelineEvent): void {
    const view = this.view;
    switch (event.type) {
      case "state":
        this.setAssistantState(event.state);
        // 中断（停止ボタン等）で llm_complete が来なかった場合、途中までの吹き出しが残る。
        // そのままにすると次の応答が古い吹き出しへ追記されるため、ここで切り離す。
        view.discardStreamIfIdle(event.state);
        break;
      case "wakeword_detected":
        view.addSystemNote(`「${event.phrase}」で起動しました`);
        break;
      case "level":
        view.updateLevel(event.level, event.threshold);
        break;
      case "recording_started":
        view.setFace("🎤");
        break;
      case "recording_stopped":
        view.setFace("💭");
        view.resetLevel();
        break;
      case "stt_complete":
        view.addMessage("user", event.text);
        break;
      case "llm_started":
        this.caption = "";
        this.stage.setCaption("", false);
        break;
      case "llm_delta":
        view.appendStreamChunk(event.content);
        this.caption += event.content;
        this.stage.setCaption(this.caption, false);
        break;
      case "llm_complete":
        view.finalizeStream(event.text);
        view.setFace("🌸");
        this.caption = event.text;
        this.stage.setCaption(event.text, true);
        break;
      case "speaking_started":
        view.setFace("🗣️");
        // ブラウザ入力モードでは、再生中の割り込み（バージイン）をブラウザ側で監視する
        this.micLoop.startBargeMonitor();
        break;
      case "tts_audio":
        this.stage.setExpression(event.expression ?? null);
        this.audioPlayer?.enqueue(event);
        break;
      case "speech_reset":
        // 言語ガードの読み直し。旧言語の音声・キューの世代を進めて破棄する
        this.audioPlayer?.stop();
        view.addSystemNote(getLanguagePack(this.language).prompt.speechResetNote);
        break;
      case "speaking_finished":
        view.setFace("🌸");
        this.stage.setExpression(null);
        break;
      case "barge_in":
        this.audioPlayer?.stop();
        view.addSystemNote("発話を検出したため再生を中断しました");
        break;
      case "followup_wait":
        view.addSystemNote(
          `続けて話しかけてください（${event.turn}/${event.maxTurns}・${Math.round(
            event.timeoutMs / 1000
          )} 秒）`
        );
        break;
      case "history_updated":
        view.renderHistory(event.messages);
        break;
      case "turn_complete":
      case "turn_skipped":
        // turn_skipped はターンが成立していない（幻聴・エコー等）。待機を解いて聞き取りを続ける。
        // ここで待機を解かないとクライアントが「応答待ち」のまま固まる。
        this.micLoop.resolveTurn(true);
        break;
      case "error":
        this.micLoop.resolveTurn(false);
        view.showToast(event.message, "error");
        break;
      default:
        break;
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  new SumikaApp().start();
});

/** 診断レポートを 1 つのテキストへ整形する */
function formatDiagnostics(report: DiagnosticsReport): string {
  const skip = report.skips;
  const capture = report.capture
    ? `録音: ${report.capture.count} 回 / 直近 frames=${report.capture.lastFrames} peak=${report.capture.lastPeakLevel} reason=${report.capture.lastReason}`
    : "録音: サーバー録音モードでは未計測（ブラウザ入力では録音はクライアント側）";
  const lastSkip = report.lastSkip
    ? `直近の破棄: ${report.lastSkip.reason}「${report.lastSkip.text}」`
    : "直近の破棄: なし";
  const services = report.services;
  return [
    `状態: ${report.state}${report.busy ? "（応答中）" : ""}`,
    `サービス: LLM=${services.llm} TTS=${services.tts} STT=${services.stt}`,
    `破棄: 幻聴=${skip.hallucination} 短断片=${skip.short} エコー=${skip.echo} 繰り返し=${skip.repeat}`,
    lastSkip,
    capture,
    `音声: ${report.audio.input_mode} / しきい値=${report.audio.silence_threshold}（上限 ${report.audio.silence_threshold_max}） / 無音=${report.audio.silence_duration}s / 最大=${report.audio.max_record_seconds}s / バージイン=${report.audio.barge_in_enabled}`,
    report.warnings.length > 0 ? `設定の警告: ${report.warnings.join(" / ")}` : "設定の警告: なし",
  ].join("\n");
}
