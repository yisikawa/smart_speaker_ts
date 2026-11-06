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
  addEventListener(type: string, handler: (event?: unknown) => void): void;
  appendChild(child: StubElement): StubElement;
  append(...nodes: StubElement[]): void;
  trigger(type: string): void;
}

function createElement(id?: string): StubElement {
  const listeners: Record<string, (event?: unknown) => void> = {};
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
  "textInput",
  "inputDevice",
  "toast",
];

function bootApp(
  location: { protocol: string; host: string } = { protocol: "http:", host: "localhost:3000" }
): { elements: Map<string, StubElement>; ws: FakeWebSocket | undefined } {
  const elements = new Map<string, StubElement>();
  for (const id of ELEMENT_IDS) {
    elements.set(id, createElement(id));
  }

  let domReady: (() => void) | null = null;
  const documentStub = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => createElement(),
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
  };

  const code = fs.readFileSync(APP_JS, "utf-8");
  vm.runInNewContext(code, {
    document: documentStub,
    window: windowStub,
    WebSocket: FakeWebSocket,
    navigator: { mediaDevices: undefined },
    console,
  });
  assert.ok(domReady, "DOMContentLoaded ハンドラが登録されること");
  (domReady as () => void)();

  return { elements, ws: FakeWebSocket.instances[0] };
}

const HELLO = {
  type: "hello",
  state: "idle",
  history: [],
  character: { name: "さくら", label: "明るい" },
  user: "You",
  version: "0.2.0",
  services: { llm: true, tts: true, stt: true },
  audio: {
    inputMode: "browser",
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
  assert.equal(elements.get("version")!.textContent, "v0.2.0");
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

test("file:// で開いた場合は WebSocket を作らず、起動方法を案内する", () => {
  const { elements, ws } = bootApp({ protocol: "file:", host: "" });

  assert.equal(ws, undefined);
  assert.match(elements.get("services")!.textContent, /start\.bat/);
  assert.match(elements.get("status")!.textContent, /未接続/);
});
