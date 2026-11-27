import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const APP_JS = path.join(PROJECT_ROOT, "dist", "frontend", "app.js");

interface StubElement {
  id?: string;
  className: string;
  textContent: string;
  innerHTML: string;
  value: string;
  disabled: boolean;
  style: Record<string, string>;
  scrollTop: number;
  scrollHeight: number;
  children: StubElement[];
  attributes: Record<string, string>;
  classList: {
    toggle(): void;
    add(): void;
    remove(): void;
    contains(): boolean;
  };
  focus(): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelectorAll(): StubElement[];
  addEventListener(type: string, handler: (event?: unknown) => void): void;
  appendChild(child: StubElement): StubElement;
  append(...nodes: StubElement[]): void;
  trigger(type: string): void;
}

function createElement(id?: string): StubElement {
  const listeners: Record<string, (event?: unknown) => void> = {};
  const attributes: Record<string, string> = {};
  const element: StubElement = {
    id,
    className: "",
    textContent: "",
    innerHTML: "",
    value: "",
    disabled: false,
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    children: [],
    attributes,
    classList: {
      toggle: () => undefined,
      add: () => undefined,
      remove: () => undefined,
      contains: () => false,
    },
    focus: () => undefined,
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => name in attributes,
    querySelectorAll: () => [],
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
    appendChild: (child) => {
      element.children.push(child);
      return child;
    },
    append: (...nodes) => {
      element.children.push(...nodes);
    },
    trigger: (type) => {
      listeners[type]?.();
    },
  };
  return element;
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }
}

const ELEMENT_IDS = [
  "stage",
  "caption",
  "conversation",
  "status",
  "levelFill",
  "levelHint",
  "characterFace",
  "characterName",
  "characterLabel",
  "services",
  "version",
  "btnListen",
  "btnStop",
  "btnClear",
  "btnSend",
  "btnMicTest",
  "btnDiagnostics",
  "diagnostics",
  "textInput",
  "inputDevice",
  "toast",
  "btnSettings",
  "languageSelect",
  "settingsPanel",
  "sttEngine",
  "sttModel",
  "sttModelType",
  "llmModel",
  "settingsNote",
  "btnMenu",
  "btnMenuClose",
  "menuDrawer",
  "menuBackdrop",
];

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

/** GET /api/models の応答（設定パネルの描画に必要な最小構成） */
const CATALOG = {
  stt: {
    engine: "whisper",
    current: {
      modelPath: "models/ggml-large-v3-turbo-q5_0.bin",
      sherpaModelDir: "models/sherpa-ctc",
      sherpaModelType: "nemo_ctc",
    },
    whisper: [
      { path: "models/ggml-large-v3-turbo-q5_0.bin", label: "ggml-large-v3-turbo-q5_0.bin", sizeBytes: 574000000 },
      { path: "models/ggml-large-v3-turbo.bin", label: "ggml-large-v3-turbo.bin", sizeBytes: 1624000000 },
    ],
    sherpa: [{ dir: "models/sherpa-ctc", label: "sherpa-ctc", suggestedModelType: "nemo_ctc" }],
  },
  llm: { model: "llama3.2:1b", models: ["llama3.2:1b", "gemma4:e2b-it-qat"], available: true },
};

/** PUT /api/models/* の応答（画面は warnings と services だけを見る） */
const UPDATE_RESULT = {
  ok: true,
  warnings: [],
  services: { llm: true, tts: true, stt: true },
  message: "テスト用に切り替えました",
};

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function bootApp(
  location: { protocol: string; host: string } = { protocol: "http:", host: "localhost:3000" }
): { elements: Map<string, StubElement>; ws: FakeWebSocket | undefined; fetchCalls: FetchCall[] } {
  const elements = new Map<string, StubElement>();
  for (const id of ELEMENT_IDS) {
    elements.set(id, createElement(id));
  }

  let domReady: (() => void) | null = null;
  const documentStub = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => createElement(),
    body: createElement(),
    addEventListener: (type: string, handler: () => void) => {
      if (type === "DOMContentLoaded") {
        domReady = handler;
      }
    },
  };

  FakeWebSocket.instances = [];
  const windowStub = {
    location,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    // beforeunload でのリソース解放を登録できるようにする（ブラウザでは常に存在する）
    addEventListener: () => undefined,
  };

  const code = fs.readFileSync(APP_JS, "utf-8");
  const fetchCalls: FetchCall[] = [];
  // 設定パネルは「開いたとき」だけ fetch する。未定義だとクリックで落ちるためスタブを渡す
  const fetchStub = async (url: string, init?: { method?: string; body?: string }): Promise<unknown> => {
    const method = init?.method ?? "GET";
    fetchCalls.push({
      method,
      path: String(url),
      body: init?.body ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const payload = method === "PUT" ? UPDATE_RESULT : CATALOG;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };

  vm.runInNewContext(code, {
    document: documentStub,
    window: windowStub,
    WebSocket: FakeWebSocket,
    fetch: fetchStub,
    navigator: { mediaDevices: undefined },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    URLSearchParams,
    console,
  });
  assert.ok(domReady, "DOMContentLoaded ハンドラが登録されること");
  (domReady as () => void)();

  return { elements, ws: FakeWebSocket.instances[0], fetchCalls };
}

const HELLO = {
  type: "hello",
  state: "idle",
  history: [],
  character: { name: "さくら", label: "明るい" },
  language: "ja",
  user: "You",
  version: "0.3.0",
  services: { llm: true, tts: true, stt: true },
  models: {
    stt: { engine: "whisper", label: "whisper.cpp / ggml-large-v3-turbo.bin" },
    llm: { model: "llama3.2:1b" },
  },
  avatar: {
    enabled: true,
    renderer: "sprite",
    modelUrl: "",
    scale: 1,
    offsetX: 0.5,
    offsetY: 0.85,
    background: "#0f1117",
    expressions: {},
    motions: {},
    emotionStyles: {},
    idleMotionIntervalSeconds: 20,
    lipSync: { sliceMs: 20, smoothing: 0.4, gain: 1 },
    emotionTags: [],
  },
  audio: {
    inputMode: "browser",
    playbackTarget: "server",
    isPrimary: true,
    outputVolume: 1,
    sampleRate: 16000,
    noSpeechTimeoutMs: 3000,
    followup: { enabled: true, maxTurns: 3, timeoutMs: 6000, guardMs: 250, keepListening: true },
    bargeIn: { enabled: true, minScore: 0.08 },
    silenceThreshold: 0.02,
    maxRecordMs: 12000,
    vad: {
      frameMs: 20,
      preRollMs: 300,
      silenceDurationMs: 1000,
      smoothingAlpha: 0.1,
      relativeThresholdMultiplier: 3,
    maxSilenceThreshold: 0.06,
      calibrationMs: 500,
      debounceFrames: 2,
      inputGain: 1,
    },
  },
};

test("app.js は classic script として構文エラーなく実行できる（export 構文を含まない）", () => {
  const code = fs.readFileSync(APP_JS, "utf-8");

  assert.equal(/^export\s/m.test(code), false, "export 文が残っていると ブラウザで SyntaxError になる");
  assert.equal(/(^|\W)require\(/.test(code), false, "require が残っているとブラウザで動かない");
  assert.doesNotThrow(() => new vm.Script(code));
});

test("読み込み直後に WebSocket へ接続し、hello でサービス状態とバージョンを表示する", () => {
  const { elements, ws } = bootApp();
  assert.ok(ws, "WebSocket が生成されること");
  assert.equal(ws?.url, "ws://localhost:3000/ws");

  ws?.onopen?.();
  assert.match(elements.get("services")!.textContent, /接続済み/);

  ws?.onmessage?.({ data: JSON.stringify(HELLO) });

  const services = elements.get("services")!.textContent;
  assert.match(services, /LLM/);
  assert.match(services, /TTS/);
  assert.match(services, /STT/);
  assert.match(services, /🟢/);
  assert.match(services, /マイク: ブラウザ/);
  assert.equal(elements.get("version")!.textContent, "v0.3.0");
  assert.equal(elements.get("status")!.textContent, "待機中");
});

test("「聞き取り開始」ボタンで start_listening がサーバーへ送られる", () => {
  const { elements, ws } = bootApp();
  ws?.onopen?.();
  elements.get("btnListen")!.trigger("click");

  assert.deepEqual(ws?.sent, [JSON.stringify({ type: "start_listening" })]);
});

test("テキスト入力の送信で submit_text が送られる", () => {
  const { elements, ws } = bootApp();
  ws?.onopen?.();
  elements.get("textInput")!.value = "こんにちは";
  elements.get("btnSend")!.trigger("click");

  assert.deepEqual(ws?.sent, [JSON.stringify({ type: "submit_text", text: "こんにちは" })]);
  assert.equal(elements.get("textInput")!.value, "");
});

test("中断で llm_complete が来なくても、次の応答は新しい吹き出しになる", () => {
  const { elements, ws } = bootApp();
  ws?.onopen?.();
  ws?.onmessage?.({ data: JSON.stringify(HELLO) });
  const conversation = elements.get("conversation")!;
  const send = (event: unknown): void => {
    ws?.onmessage?.({ data: JSON.stringify({ type: "event", event }) });
  };

  send({ type: "state", state: "thinking" });
  send({ type: "llm_delta", content: "途中まで" });
  // 停止 → idle（llm_complete は届かない）
  send({ type: "state", state: "idle" });
  // 次のターンの応答
  send({ type: "state", state: "thinking" });
  send({ type: "llm_delta", content: "新しい応答" });

  const bubbles = conversation.children.filter((child) => child.className === "message assistant");
  assert.equal(bubbles.length, 2, "中断した吹き出しと新しい吹き出しが分かれること");
});

test("file:// で開いた場合は WebSocket を作らず、起動方法を案内する", () => {
  const { elements, ws } = bootApp({ protocol: "file:", host: "" });

  assert.equal(ws, undefined);
  assert.match(elements.get("services")!.textContent, /start\.bat/);
  assert.match(elements.get("status")!.textContent, /未接続/);
});

test("設定メニューを開くと GET /api/models で候補を取得して一覧に反映する", async () => {
  const { elements, ws, fetchCalls } = bootApp();
  ws?.onopen?.();
  ws?.onmessage?.({ data: JSON.stringify(HELLO) });

  elements.get("btnSettings")!.trigger("click");
  await flush();
  await flush();

  assert.equal(elements.get("settingsPanel")!.className, "settings", "パネルが開く");
  assert.equal(
    fetchCalls.some((call) => call.method === "GET" && call.path === "/api/models"),
    true,
    "候補一覧は開いたときに取得する"
  );
  assert.equal(elements.get("llmModel")!.value, "llama3.2:1b", "現在のモデルが選択される");
  assert.equal(elements.get("sttModel")!.value, "models/ggml-large-v3-turbo-q5_0.bin");
});

test("設定メニューの LLM モデル変更で PUT /api/models/llm が送られる", async () => {
  const { elements, ws, fetchCalls } = bootApp();
  ws?.onopen?.();
  ws?.onmessage?.({ data: JSON.stringify(HELLO) });
  elements.get("btnSettings")!.trigger("click");
  await flush();

  elements.get("llmModel")!.value = "gemma4:e2b-it-qat";
  elements.get("llmModel")!.trigger("change");
  await flush();
  await flush();

  const put = fetchCalls.find((call) => call.method === "PUT" && call.path === "/api/models/llm");
  assert.deepEqual(put?.body, { model: "gemma4:e2b-it-qat" });
});

test("設定メニューで STT を sherpa に切り替えるとエンジンとモデル種別が送られる", async () => {
  const { elements, ws, fetchCalls } = bootApp();
  ws?.onopen?.();
  ws?.onmessage?.({ data: JSON.stringify(HELLO) });
  elements.get("btnSettings")!.trigger("click");
  await flush();

  elements.get("sttEngine")!.value = "sherpa";
  elements.get("sttEngine")!.trigger("change");
  await flush();
  await flush();

  const put = fetchCalls.find((call) => call.method === "PUT" && call.path === "/api/models/stt");
  assert.deepEqual(put?.body, {
    engine: "sherpa",
    sherpa_model_dir: "models/sherpa-ctc",
    sherpa_model_type: "nemo_ctc",
  });
});

test("応答中（thinking/speaking など）は言語切替を送らない", async () => {
  const { elements, ws, fetchCalls } = bootApp();
  ws?.onopen?.();
  ws?.onmessage?.({ data: JSON.stringify({ ...HELLO, state: "speaking" }) });

  elements.get("languageSelect")!.value = "en";
  elements.get("languageSelect")!.trigger("change");
  await flush();

  const patch = fetchCalls.find((call) => call.method === "PATCH" && call.path === "/api/config");
  assert.equal(patch, undefined, "応答中は PATCH しない");
  assert.equal(elements.get("languageSelect")!.value, "ja", "表示は元に戻る");
  assert.match(elements.get("toast")!.textContent, /応答中は言語を切り替えられません/);
});

test("録音中（recording）も言語切替を送らない", async () => {
  const { elements, ws, fetchCalls } = bootApp();
  ws?.onopen?.();
  ws?.onmessage?.({ data: JSON.stringify({ ...HELLO, state: "recording" }) });

  elements.get("languageSelect")!.value = "en";
  elements.get("languageSelect")!.trigger("change");
  await flush();

  const patch = fetchCalls.find((call) => call.method === "PATCH" && call.path === "/api/config");
  assert.equal(patch, undefined, "録音中は PATCH しない");
  assert.equal(elements.get("languageSelect")!.value, "ja");
});

test("error 状態では言語切替できる（切り替え不能で固まらない）", async () => {
  const { elements, ws, fetchCalls } = bootApp();
  ws?.onopen?.();
  ws?.onmessage?.({ data: JSON.stringify({ ...HELLO, state: "error" }) });

  elements.get("languageSelect")!.value = "en";
  elements.get("languageSelect")!.trigger("change");
  await flush();

  const patch = fetchCalls.find((call) => call.method === "PATCH" && call.path === "/api/config");
  assert.ok(patch, "error では PATCH する");
  assert.deepEqual(patch?.body, { conversation: { language: "en" } });
});

test("言語セレクトの変更で PATCH /api/config が送られる（言語モード切替）", async () => {
  const { elements, ws, fetchCalls } = bootApp();
  ws?.onopen?.();
  ws?.onmessage?.({ data: JSON.stringify(HELLO) });
  assert.equal(elements.get("languageSelect")!.value, "ja", "hello の言語が選択される");

  elements.get("languageSelect")!.value = "en";
  elements.get("languageSelect")!.trigger("change");
  await flush();

  const patch = fetchCalls.find((call) => call.method === "PATCH" && call.path === "/api/config");
  assert.deepEqual(patch?.body, { conversation: { language: "en" } });
  assert.match(elements.get("toast")!.textContent, /English/);

  // サーバーからの language 通知で表示（セレクト・キャラクター名）が更新される
  ws?.onmessage?.({
    data: JSON.stringify({ type: "language", language: "en", character: { name: "Sakura", label: "Cheerful" } }),
  });
  assert.equal(elements.get("characterName")!.textContent, "Sakura");
});

test("ハンバーガーでドロワーを開閉できる", () => {
  const { elements } = bootApp();
  const btnMenu = elements.get("btnMenu")!;
  const drawer = elements.get("menuDrawer")!;

  btnMenu.trigger("click");
  assert.equal(btnMenu.getAttribute("aria-expanded"), "true");
  assert.equal(drawer.getAttribute("aria-hidden"), "false");

  elements.get("btnMenuClose")!.trigger("click");
  assert.equal(btnMenu.getAttribute("aria-expanded"), "false");
  assert.equal(drawer.getAttribute("aria-hidden"), "true");
});
