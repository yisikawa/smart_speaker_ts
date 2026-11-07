import type {
  ModelCatalog,
  ModelSelection,
  ModelUpdateResult,
  SherpaModelTypeName,
} from "../shared/protocol";
import type { ChatView } from "./ChatView";

/**
 * 画面の「設定」メニュー（STT のエンジン／モデルと LLM モデルの切り替え）。
 *
 * - 一覧（`GET /api/models`）は**パネルを開いたときだけ**取得する（起動を重くしない）
 * - 変更は即保存（`PUT /api/models/*`）。結果と `warnings` をトースト／注記に出す
 * - サーバーは切替を次の発話から適用する（進行中の発話は旧設定のまま完遂する）
 */

const ENGINE_OPTIONS = [
  { value: "whisper", label: "whisper.cpp" },
  { value: "sherpa", label: "sherpa-onnx" },
];

const MODEL_TYPE_OPTIONS: { value: SherpaModelTypeName; label: string }[] = [
  { value: "nemo_ctc", label: "nemo_ctc（単一 model.onnx）" },
  { value: "nemo_transducer", label: "nemo_transducer（encoder/decoder/joiner）" },
  { value: "sense_voice", label: "sense_voice" },
  { value: "zipformer_transducer", label: "zipformer_transducer" },
];

/** JSON リクエスト。失敗時はサーバーの `error` 文言を投げる */
async function requestJson<T>(method: "GET" | "PUT", path: string, body?: unknown): Promise<T> {
  if (typeof fetch !== "function") {
    throw new Error(
      "この環境ではモデル設定を取得できません（start.bat で起動して http://localhost:3000 を開いてください）"
    );
  }
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    if (response.status === 404) {
      // 画面（静的ファイル）だけ新しく、起動中のサーバーが古いままの典型パターン
      throw new Error(
        `${path} が見つかりません。起動中のサーバーが古いままの可能性があります（アプリを再起動してください）`
      );
    }
    const message = (parsed as { error?: string } | null)?.error;
    throw new Error(message ?? `${path} が ${response.status} を返しました`);
  }
  return parsed as T;
}

function formatSize(bytes: number): string {
  return bytes > 0 ? `${Math.round(bytes / (1024 * 1024))} MB` : "サイズ不明";
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

export class SettingsPanel {
  private catalog: ModelCatalog | null = null;
  private selection: ModelSelection | null = null;
  private loading = false;

  constructor(
    private readonly view: ChatView,
    /** 現在の音声入力方式（サービス表示の更新に使う） */
    private readonly inputMode: () => string
  ) {}

  /** イベントを配線する（Composition Root から 1 回だけ呼ぶ） */
  bind(): void {
    const view = this.view;
    view.btnSettings.addEventListener("click", () => {
      void this.toggle();
    });
    view.sttEngine.addEventListener("change", () => {
      this.renderSttModels();
      void this.applyStt();
    });
    view.sttModel.addEventListener("change", () => {
      this.syncSherpaModelType();
      void this.applyStt();
    });
    view.sttModelType.addEventListener("change", () => {
      void this.applyStt();
    });
    view.llmModel.addEventListener("change", () => {
      void this.applyLlm();
    });
  }

  /** hello で受け取った現在値を記憶する（一覧が取れないときの表示に使う） */
  updateSelection(selection: ModelSelection | undefined): void {
    if (!selection) {
      return;
    }
    this.selection = selection;
    if (!this.catalog) {
      this.view.setSelectOptions(this.view.sttEngine, ENGINE_OPTIONS, selection.stt.engine);
    }
  }

  /** 開閉（初回だけ一覧を取得する） */
  private async toggle(): Promise<void> {
    const open = this.view.toggleSettings();
    if (open && !this.catalog) {
      await this.load();
    }
  }

  /** 候補一覧を取得してセレクトへ反映する */
  private async load(): Promise<void> {
    if (this.loading) {
      return;
    }
    this.loading = true;
    try {
      this.catalog = await requestJson<ModelCatalog>("GET", "/api/models");
      this.render();
    } catch (error) {
      this.view.showToast(`モデル一覧を取得できませんでした: ${errorText(error)}`, "error");
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    const catalog = this.catalog;
    if (!catalog) {
      return;
    }
    const view = this.view;

    view.setSelectOptions(view.sttEngine, ENGINE_OPTIONS, catalog.stt.engine);
    this.renderSttModels();

    const llmOptions = catalog.llm.models.map((model) => ({
      value: model,
      label: model === catalog.llm.model ? `${model}（使用中）` : model,
    }));
    view.setSelectOptions(view.llmModel, llmOptions, catalog.llm.model);

    const notes: string[] = [];
    if (catalog.stt.whisper.length === 0) {
      notes.push("whisper のモデルがありません（models/*.bin を配置してください）");
    }
    if (catalog.stt.sherpa.length === 0) {
      notes.push("sherpa のモデルがありません（scripts/setup-sherpa.ps1 を実行してください）");
    }
    if (!catalog.llm.available) {
      notes.push("Ollama に接続できないため LLM のモデル一覧を取得できませんでした");
    }
    view.setSettingsNote(notes.length > 0 ? notes.join(" / ") : null);
  }

  /** 選択中のエンジンに応じてモデル候補を差し替える */
  private renderSttModels(): void {
    const catalog = this.catalog;
    if (!catalog) {
      return;
    }
    const view = this.view;

    if (view.sttEngine.value !== "sherpa") {
      view.setSelectOptions(
        view.sttModel,
        catalog.stt.whisper.map((model) => ({
          value: model.path,
          label: `${model.label}（${formatSize(model.sizeBytes)}）`,
        })),
        catalog.stt.current.modelPath
      );
      view.sttModelType.className = "hidden";
      return;
    }

    view.setSelectOptions(
      view.sttModel,
      catalog.stt.sherpa.map((model) => ({ value: model.dir, label: model.label })),
      catalog.stt.current.sherpaModelDir
    );
    this.syncSherpaModelType();
    view.sttModelType.className = "";
  }

  /** 選んだモデルディレクトリに合わせて種別の推定値を選び直す */
  private syncSherpaModelType(): void {
    const catalog = this.catalog;
    if (!catalog || this.view.sttEngine.value !== "sherpa") {
      return;
    }
    const suggested =
      catalog.stt.sherpa.find((model) => model.dir === this.view.sttModel.value)?.suggestedModelType ??
      catalog.stt.current.sherpaModelType;
    this.view.setSelectOptions(this.view.sttModelType, MODEL_TYPE_OPTIONS, suggested);
  }

  private async applyStt(): Promise<void> {
    const view = this.view;
    const engine = view.sttEngine.value === "sherpa" ? "sherpa" : "whisper";
    const body: Record<string, string> = { engine };

    if (engine === "sherpa") {
      if (view.sttModel.value) {
        body.sherpa_model_dir = view.sttModel.value;
      }
      body.sherpa_model_type = this.selectedModelType();
    } else if (view.sttModel.value) {
      body.model_path = view.sttModel.value;
    }

    await this.send("/api/models/stt", body);
  }

  private async applyLlm(): Promise<void> {
    const model = this.view.llmModel.value;
    if (!model) {
      return;
    }
    await this.send("/api/models/llm", { model });
  }

  private selectedModelType(): SherpaModelTypeName {
    const value = this.view.sttModelType.value as SherpaModelTypeName;
    return MODEL_TYPE_OPTIONS.some((option) => option.value === value) ? value : "nemo_ctc";
  }

  /** 設定を保存し、結果（トースト・警告・疎通表示）を画面へ反映する */
  private async send(path: string, body: unknown): Promise<void> {
    const view = this.view;
    try {
      const result = await requestJson<ModelUpdateResult>("PUT", path, body);
      view.showToast(result.message, "info");
      view.setSettingsNote(result.warnings.length > 0 ? result.warnings.join(" / ") : null);
      await this.load();
      view.renderServices(result.services, this.inputMode(), this.currentSelection());
    } catch (error) {
      view.showToast(errorText(error), "error");
      // 拒否された場合は保存されていないので、画面の選択を現在値へ戻す
      await this.load();
    }
  }

  private currentSelection(): ModelSelection | undefined {
    const catalog = this.catalog;
    if (!catalog) {
      return this.selection ?? undefined;
    }
    return {
      stt: { engine: catalog.stt.engine, label: catalog.stt.engine },
      llm: { model: catalog.llm.model },
    };
  }
}
