# studio レイアウト Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `studio` レイアウトを追加し、左カラムの非チャット UI をハンバーガードロワーへ、チャットを右のキャラクター画面の左下カードへ統合する。

**Architecture:** `StageMode` に `studio` を追加して既定にする。DOM は `#studioBar` / `#characterInfo` / `#chatOverlay` / `#menuDrawer` に再構成し、既存 ID を維持して `ChatView` / `SettingsPanel` の参照を壊さない。`MenuDrawer` がドロワーの開閉・フォーカスを担当し、CSS が `studio` / `split` / `chat` / `stage` の配置を切り替える。

**Tech Stack:** TypeScript 5 / esbuild（フロント IIFE バンドル） / `node:test` / 既存の Express バックエンド（変更なし）

## Global Constraints

- 作業ブランチは `develop`。設計書は `docs/superpowers/specs/2026-11-27-studio-layout-design.md`
- 新規依存を追加しない。バックエンド・WebSocket・音声パイプラインは変更しない
- `studio` を追加し、既定を `studio` にする。`split` / `chat` / `stage` は維持する
- `stage` モード（`?mode=stage&transparent=1`）の配信挙動を変えない
- `studio` では大きな字幕 `#caption` を非表示にし、チャットカードが字幕を兼ねる
- `studio` の常時表示: `#btnListen` / `#btnStop` / `#status` / `#levelFill` / `#levelHint` / `#btnMenu`
- `studio` のチャットカードは左下・常時表示。幅 `min(420px, calc(100% - 48px))`、最大高さ `45vh`
- キャラクター情報（`#characterFace` / `#characterLabel` / `#services`）は右のキャラクター画面に残す
- 既存の ID はすべて維持する。`ChatView` / `SettingsPanel` は原則変更しない
- ドロワーは `Esc` / 背景クリック / 閉じるボタンで閉じ、フォーカスを `#btnMenu` に戻す
- フロントのビルドは必ず esbuild（`npm run build`）。`tsc` 出力をブラウザで使わない
- 変更後は `npm run verify`（typecheck → test → build）を通す
- コミットはタスクごと。メッセージ末尾に `Co-Authored-By: Claude Code <noreply@anthropic.com>` を付ける

### ファイル構成（作成 / 変更）

| 種別 | パス | 責務 |
|---|---|---|
| 変更 | `src/shared/ui/stageMode.ts` | `studio` の追加、既定 `studio` |
| 変更 | `src/frontend/StageView.ts` | モードクラス、字幕制御、`#stage` フォールバック |
| 新規 | `src/frontend/MenuDrawer.ts` | ドロワー開閉・フォーカストラップ・Esc・背景クリック |
| 変更 | `src/frontend/app.ts` | `MenuDrawer` の生成・bind、モード切替時のドロワー close |
| 変更 | `src/frontend/index.html` | 新コンテナと要素移動 |
| 変更 | `src/frontend/style.css` | `studio` / `chat` / ドロワー / チャットカード / split/stage の再配置 |
| 変更 | `start.bat` | 既定 `studio`、`/studio` |
| 変更 | `README.md` / `AGENTS.md` | 既定モードとレイアウトの説明 |
| 変更 | `tests/stage-mode.test.ts` | 既定 `studio`、`?mode=studio` |
| 変更 | `tests/frontend-script.test.ts` | 必須 ID 追加、ドロワー開閉テスト |

---

### Task 1: `stageMode` に `studio` を追加し、既定を変更する

**Files:**
- Modify: `src/shared/ui/stageMode.ts`
- Test: `tests/stage-mode.test.ts`

**Interfaces:**
- Produces: `StageMode = "chat" | "stage" | "split" | "studio"`、`parseStageOptions()` の既定 `{ mode: "studio", transparent: false }`

- [ ] **Step 1: 失敗するテストに更新する**

`tests/stage-mode.test.ts` を次の内容に置き換える:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseStageOptions } from "../src/shared/ui/stageMode";

test("既定は studio（キャラクター + 左下チャット）", () => {
  assert.deepEqual(parseStageOptions(""), { mode: "studio", transparent: false });
  assert.deepEqual(parseStageOptions("?"), { mode: "studio", transparent: false });
});

test("mode=chat / stage / split / studio を読む", () => {
  assert.deepEqual(parseStageOptions("?mode=chat"), { mode: "chat", transparent: false });
  assert.deepEqual(parseStageOptions("?mode=stage"), { mode: "stage", transparent: false });
  assert.deepEqual(parseStageOptions("?mode=split"), { mode: "split", transparent: false });
  assert.deepEqual(parseStageOptions("?mode=studio"), { mode: "studio", transparent: false });
});

test("transparent=1 を読む", () => {
  assert.deepEqual(parseStageOptions("?mode=stage&transparent=1"), { mode: "stage", transparent: true });
  assert.deepEqual(parseStageOptions("?transparent=true"), { mode: "studio", transparent: true });
});

test("未知の値は既定（studio）へ落とす", () => {
  assert.deepEqual(parseStageOptions("?mode=bogus&transparent=yes"), {
    mode: "studio",
    transparent: false,
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run:

```powershell
npm test
```

Expected: `stage-mode.test.ts` が失敗する（既定が `split` のため）。

- [ ] **Step 3: `stageMode.ts` を実装する**

```ts
/** 画面レイアウト（chat: チャットのみ / stage: 配信向け / split: チャット + ステージ / studio: キャラクター + 左下チャット） */
export type StageMode = "chat" | "stage" | "split" | "studio";

export interface StageOptions {
  mode: StageMode;
  transparent: boolean;
}

const MODES: StageMode[] = ["chat", "stage", "split", "studio"];

/**
 * `location.search` からレイアウトの指定を読む（`?mode=studio&transparent=1`）。
 * `mode` が無い場合は studio（キャラクター + 左下チャット）を既定にする。
 */
export function parseStageOptions(search: string): StageOptions {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw = params.get("mode");
  const mode: StageMode = raw && (MODES as string[]).includes(raw) ? (raw as StageMode) : "studio";
  const flag = params.get("transparent");
  const transparent = flag === "1" || flag === "true";
  return { mode, transparent };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run:

```powershell
npm test
```

Expected: すべて pass（`stage-mode.test.ts` を含む）。

- [ ] **Step 5: コミットする**

```powershell
git add src/shared/ui/stageMode.ts tests/stage-mode.test.ts
git commit -m "feat(ui): studio レイアウトを既定に追加" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `StageView` に studio / chat のモード制御を追加する

**Files:**
- Modify: `src/frontend/StageView.ts`

**Interfaces:**
- Consumes: `StageOptions["mode"]`（Task 1）
- Produces: `body` の `studio-mode` / `split-mode` / `chat-mode` / `stage-mode` クラス。`#caption` は `chat` / `studio` で非表示。`renderer === "none"` でも `studio` では `#stage` を残す

- [ ] **Step 1: `StageView.ts` を次の内容に置き換える**

```ts
import type { AvatarConfigPayload } from "../shared/protocol";
import type { StageOptions } from "../shared/ui/stageMode";
import { AvatarStage } from "./avatar/AvatarStage";
import { must } from "./dom";

/** 背景設定（色 / `assets/avatar/x.jpg` / URL）を CSS の background へ変換する */
function toBackground(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "#0f1117";
  }

  // ローカル素材は `/avatar-assets/` で配信されるため、URL へ読み替える
  const local = trimmed.match(/^assets[\\/]avatar[\\/](.+)$/i);
  const target = local ? `/avatar-assets/${local[1].replace(/\\/g, "/")}` : trimmed;

  const looksLikeImage =
    /^(https?:|\/|\.\/|data:image\/)/i.test(target) || /\.(png|jpe?g|webp|gif|avif)$/i.test(target);
  return looksLikeImage ? `url("${target}") center / cover no-repeat` : target;
}

/** ステージ（配信向けレイアウト）と字幕・アバターの表示を担当する */
export class StageView {
  private readonly stageEl = must<HTMLElement>("stage");
  private readonly captionEl = must<HTMLElement>("caption");
  private readonly avatar = new AvatarStage();
  private mode: StageOptions["mode"] = "studio";

  apply(options: StageOptions): void {
    this.mode = options.mode;
    document.body.classList.toggle("studio-mode", options.mode === "studio");
    document.body.classList.toggle("split-mode", options.mode === "split");
    document.body.classList.toggle("chat-mode", options.mode === "chat");
    document.body.classList.toggle("stage-mode", options.mode === "stage");
    document.body.classList.toggle("transparent", options.transparent);
    this.stageEl.classList.toggle("hidden", options.mode === "chat");
    // 字幕は配信向けの stage / split で使う。studio はチャットが字幕を兼ねる
    this.captionEl.classList.toggle(
      "hidden",
      options.mode === "chat" || options.mode === "studio"
    );
  }

  async mountAvatar(config: AvatarConfigPayload): Promise<void> {
    this.stageEl.style.setProperty?.("--stage-background", toBackground(config.background));
    // チャットのみの表示ではアバターは見えないため、Live2D のランタイム（pixi）を読み込まない
    if (this.mode === "chat") {
      return;
    }
    await this.avatar.mount(this.stageEl, config);
    const empty = config.renderer === "none";
    // studio は背景とキャラ情報を残す（アバター無しのフォールバック）
    this.stageEl.classList.toggle("hidden", empty && this.mode !== "studio");
  }

  setMouth(level: number): void {
    this.avatar.setMouth(level);
  }

  setExpression(name: string | null): void {
    this.avatar.setExpression(name);
  }

  setCaption(text: string, final: boolean): void {
    this.captionEl.textContent = text;
    this.captionEl.classList.toggle("final", final);
    if (this.mode !== "chat" && this.mode !== "studio") {
      this.captionEl.classList.remove("hidden");
    }
  }
}
```

- [ ] **Step 2: 型チェックと既存テストを実行する**

Run:

```powershell
npm run typecheck
npm test
```

Expected: typecheck OK、すべて pass。

- [ ] **Step 3: コミットする**

```powershell
git add src/frontend/StageView.ts
git commit -m "feat(ui): StageView に studio モードを追加" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: `MenuDrawer` と `app.ts` の配線、テストの必須 ID を追加する

**Files:**
- Create: `src/frontend/MenuDrawer.ts`
- Modify: `src/frontend/app.ts`
- Test: `tests/frontend-script.test.ts`

**Interfaces:**
- Consumes: `must()`（`src/frontend/dom.ts`）
- Produces: `MenuDrawer.bind()` / `open()` / `close()`。`#btnMenu` の `aria-expanded`、`#menuDrawer` の `aria-hidden` を更新する

- [ ] **Step 1: 失敗するテストを追加する**

`tests/frontend-script.test.ts` の `StubElement` と `createElement` を次の内容に置き換える。

```ts
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
```

```ts
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
```

`ELEMENT_IDS` に次を追加する:

```ts
  "btnMenu",
  "btnMenuClose",
  "menuDrawer",
  "menuBackdrop",
```

新しいテストを追加する:

```ts
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
```

- [ ] **Step 2: テストが失敗することを確認する**

Run:

```powershell
npm test
```

Expected: 新しいテストが失敗する（`btnMenu` にリスナーがなく、`aria-expanded` が `null`）。

- [ ] **Step 3: `MenuDrawer.ts` を作成する**

```ts
import { must } from "./dom";

/**
 * ハンバーガーメニューの開閉・フォーカス・キーボード操作を担当する。
 * ドロワー内の設定・言語・マイク・診断は既存の ChatView / SettingsPanel が扱う。
 */
export class MenuDrawer {
  private readonly btnMenu = must<HTMLButtonElement>("btnMenu");
  private readonly btnClose = must<HTMLButtonElement>("btnMenuClose");
  private readonly drawer = must<HTMLElement>("menuDrawer");
  private readonly backdrop = must<HTMLElement>("menuBackdrop");
  private open = false;
  private lastFocused: HTMLElement | null = null;

  bind(): void {
    this.btnMenu.addEventListener("click", () => this.toggle());
    this.btnClose.addEventListener("click", () => this.close());
    this.backdrop.addEventListener("click", () => this.close());
    document.addEventListener("keydown", (event) => {
      if (!this.open) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key === "Tab") {
        this.trapFocus(event);
      }
    });
  }

  close(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    document.body.classList.remove("menu-open");
    this.drawer.classList.remove("open");
    this.backdrop.classList.remove("open");
    this.drawer.setAttribute("aria-hidden", "true");
    this.btnMenu.setAttribute("aria-expanded", "false");
    const target = this.lastFocused ?? this.btnMenu;
    this.lastFocused = null;
    target.focus();
  }

  private toggle(): void {
    if (this.open) {
      this.close();
    } else {
      this.show();
    }
  }

  private show(): void {
    const active = document.activeElement as HTMLElement | null;
    this.lastFocused = active && typeof active.focus === "function" ? active : null;
    this.open = true;
    document.body.classList.add("menu-open");
    this.drawer.classList.add("open");
    this.backdrop.classList.add("open");
    this.drawer.setAttribute("aria-hidden", "false");
    this.btnMenu.setAttribute("aria-expanded", "true");
    this.btnClose.focus();
  }

  private trapFocus(event: KeyboardEvent): void {
    const focusable = Array.from(
      this.drawer.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => !element.hasAttribute("disabled"));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
```

- [ ] **Step 4: `app.ts` に配線する**

`import` に追加:

```ts
import { MenuDrawer } from "./MenuDrawer";
```

フィールドを追加:

```ts
  /** ハンバーガーメニュー（左ドロワー） */
  private readonly menu = new MenuDrawer();
```

`start()` を次のように変更する:

```ts
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
```

- [ ] **Step 5: テストが通ることを確認する**

Run:

```powershell
npm run typecheck
npm test
```

Expected: すべて pass。

- [ ] **Step 6: コミットする**

```powershell
git add src/frontend/MenuDrawer.ts src/frontend/app.ts tests/frontend-script.test.ts
git commit -m "feat(ui): ハンバーガーメニューを追加" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: `index.html` を新しい DOM 構成に置き換える

**Files:**
- Modify: `src/frontend/index.html`

**Interfaces:**
- Consumes: Task 3 の `MenuDrawer` が要求する `#btnMenu` / `#btnMenuClose` / `#menuDrawer` / `#menuBackdrop`
- Produces: `#studioBar` / `#characterInfo` / `#chatOverlay` / `#menuDrawer` / `#menuBackdrop` と、移動した既存 ID

- [ ] **Step 1: 新しい `index.html` を書く**

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sumika TypeScript</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app">
    <section id="stage" class="stage hidden">
      <div id="caption" class="caption hidden"></div>
    </section>

    <div id="studioBar" class="studio-bar">
      <button id="btnMenu" class="btn btn-ghost" type="button" aria-label="メニュー"
              aria-expanded="false" aria-controls="menuDrawer">☰</button>
      <div id="status" class="status idle">待機中</div>
      <button id="btnListen" class="btn btn-primary">聞き取り開始</button>
      <button id="btnStop" class="btn btn-danger" disabled>停止</button>
      <div class="level-row">
        <div class="level-bar"><span id="levelFill" class="level-fill"></span></div>
        <span id="levelHint" class="level-hint">マイクレベル</span>
      </div>
    </div>

    <section id="characterInfo" class="character-info">
      <div id="characterFace" class="character-face">🌸</div>
      <div class="character-info-text">
        <div id="characterLabel" class="character-name">さくら</div>
        <div id="services" class="services">サーバー接続待ち…</div>
      </div>
    </section>

    <section id="chatOverlay" class="chat-overlay" aria-label="会話">
      <section id="conversation" class="conversation" aria-live="polite"></section>
      <section class="composer">
        <textarea id="textInput" rows="1"
          placeholder="テキストでも話しかけられます（Enter で送信 / Shift+Enter で改行）"></textarea>
        <button id="btnSend" class="btn btn-primary">送信</button>
      </section>
    </section>

    <div id="menuBackdrop" class="menu-backdrop" aria-hidden="true"></div>
    <aside id="menuDrawer" class="menu-drawer" role="dialog" aria-modal="true"
           aria-labelledby="menuTitle" aria-hidden="true">
      <header class="menu-header">
        <h1 id="menuTitle">🎙️ <span id="characterName">Sumika</span></h1>
        <button id="btnMenuClose" type="button" class="btn btn-ghost" aria-label="メニューを閉じる">×</button>
      </header>

      <section class="menu-section">
        <h2>音声入力</h2>
        <label for="inputDevice">マイク</label>
        <select id="inputDevice"></select>
        <button id="btnMicTest" class="btn btn-secondary">マイク確認</button>
      </section>

      <section class="menu-section">
        <button id="btnSettings" class="btn btn-ghost" aria-expanded="false"
                aria-controls="settingsPanel">⚙️ モデル設定</button>
        <section id="settingsPanel" class="settings hidden" aria-label="モデル設定">
          <div class="settings-row">
            <label for="sttEngine">音声認識</label>
            <select id="sttEngine">
              <option value="whisper">whisper.cpp</option>
              <option value="sherpa">sherpa-onnx</option>
            </select>
            <select id="sttModel" aria-label="認識モデル"></select>
            <select id="sttModelType" class="hidden" aria-label="sherpa のモデル種別">
              <option value="nemo_ctc">nemo_ctc</option>
              <option value="nemo_transducer">nemo_transducer</option>
              <option value="sense_voice">sense_voice</option>
              <option value="zipformer_transducer">zipformer_transducer</option>
            </select>
          </div>
          <div class="settings-row">
            <label for="llmModel">LLM</label>
            <select id="llmModel" aria-label="LLM モデル"></select>
          </div>
          <div id="settingsNote" class="settings-note hidden"></div>
        </section>
      </section>

      <section class="menu-section">
        <label for="languageSelect">言語 / Language</label>
        <select id="languageSelect" class="language-select">
          <option value="ja">日本語</option>
          <option value="en">English</option>
        </select>
      </section>

      <section class="menu-section">
        <button id="btnDiagnostics" class="btn btn-secondary">診断</button>
        <section id="diagnostics" class="diagnostics hidden"></section>
      </section>

      <section class="menu-section">
        <button id="btnClear" class="btn btn-secondary">履歴クリア</button>
      </section>

      <footer class="menu-footer">
        <span id="version">v-</span>
        <span>ローカル完結（音声・テキストは外部送信されません）</span>
      </footer>
    </aside>

    <div id="toast" class="toast hidden"></div>
  </div>

  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 必須 ID がすべて存在することを確認する**

Run:

```powershell
$ids = @("stage","caption","conversation","status","levelFill","levelHint","characterFace","characterName","characterLabel","services","version","btnListen","btnStop","btnClear","btnSend","btnMicTest","btnDiagnostics","diagnostics","textInput","inputDevice","toast","btnSettings","languageSelect","settingsPanel","sttEngine","sttModel","sttModelType","llmModel","settingsNote","btnMenu","btnMenuClose","menuDrawer","menuBackdrop","studioBar","characterInfo","chatOverlay")
$missing = $ids | Where-Object { -not (Select-String -Path src\frontend\index.html -Pattern "id=`"$_`"" -Quiet) }
if ($missing) { $missing } else { "all IDs present" }
```

Expected: `all IDs present`

- [ ] **Step 3: ビルドとテストを実行する**

Run:

```powershell
npm run verify
```

Expected: すべて pass（HTML は実行時テストの対象外だが、ビルドと既存テストが通る）。

- [ ] **Step 4: コミットする**

```powershell
git add src/frontend/index.html
git commit -m "feat(ui): studio 用の DOM 構成に変更" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: `style.css` に studio / chat / ドロワー / チャットカードのレイアウトを追加する

**Files:**
- Modify: `src/frontend/style.css`

**Interfaces:**
- Consumes: Task 4 のコンテナ ID
- Produces: `body.studio-mode` / `body.split-mode` / `body.chat-mode` / `body.stage-mode` のレイアウト

- [ ] **Step 1: 既存のレイアウトブロックを置き換える**

`style.css` の `body.stage-mode` ブロック（hide リスト）と `body.split-mode` ブロックを、次の内容で置き換える。既存のコンポーネントスタイル（`.btn` / `.status` / `.level-*` / `.character-*` / `.conversation` / `.message*` / `.composer*` / `.settings*` / `.diagnostics` / `.language-select` / `.toast` / `.stage` / `.avatar-*` / `.caption`）は維持する。また、既存の `body.stage-mode .avatar-sprite` / `.avatar-sprite--image` / `.avatar-expression`（style.css:586-597）と `body.transparent`（600-601）はそのまま残す。

```css
/* ---- studio: 全面キャラクター + 左下チャット + 上部バー ---- */
body.studio-mode { overflow: hidden; }

body.studio-mode #app {
  max-width: none;
  height: 100vh;
  min-height: 0;
  padding: 0;
  position: relative;
  overflow: hidden;
}

body.studio-mode #stage {
  position: absolute;
  inset: 0;
  height: 100%;
  min-height: 0;
  border-radius: 0;
}

body.studio-mode #caption { display: none; }

body.studio-mode .avatar-sprite {
  top: 50%;
  height: calc(90% * var(--avatar-scale, 1));
  width: auto;
  min-width: 0;
  transform: translate(-50%, -50%);
}

.studio-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

body.studio-mode #studioBar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 4;
  padding: 12px 16px;
  background: linear-gradient(180deg, rgba(15, 17, 23, 0.78), rgba(15, 17, 23, 0.15));
  backdrop-filter: blur(8px);
}

body.studio-mode #studioBar .level-row {
  flex: 1 1 160px;
  min-width: 120px;
  margin-top: 0;
}

body.studio-mode #studioBar .level-hint {
  min-width: 0;
  font-size: 0.7rem;
}

.character-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.character-info-text { min-width: 0; }

body.studio-mode #characterInfo {
  position: absolute;
  top: 64px;
  right: 24px;
  z-index: 4;
  flex-direction: row-reverse;
  max-width: min(360px, 60vw);
  padding: 8px 12px;
  border-radius: 12px;
  background: rgba(15, 17, 23, 0.55);
  color: #fff;
  text-align: right;
}

body.studio-mode #characterInfo .character-face {
  font-size: 28px;
  animation: none;
}

body.studio-mode #characterInfo .character-name {
  color: #fff;
  font-size: 0.95rem;
}

body.studio-mode #characterInfo .services {
  color: rgba(255, 255, 255, 0.72);
  font-size: 0.7rem;
}

.chat-overlay {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

body.studio-mode #chatOverlay {
  position: absolute;
  left: 24px;
  bottom: 24px;
  z-index: 4;
  width: min(420px, calc(100% - 48px));
  max-height: 45vh;
  padding: 14px;
  border-radius: 16px;
  background: rgba(15, 17, 23, 0.82);
  backdrop-filter: blur(10px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}

body.studio-mode #conversation {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  margin-bottom: 10px;
  padding: 0 2px;
  border: none;
  background: transparent;
  color: #fff;
}

body.studio-mode #chatOverlay .message.assistant { background: rgba(255, 255, 255, 0.94); }
body.studio-mode #chatOverlay .message.user { background: #4f46e5; }
body.studio-mode #chatOverlay .system-note { color: rgba(255, 255, 255, 0.7); }
body.studio-mode #chatOverlay .composer { margin-bottom: 0; }
body.studio-mode #chatOverlay .composer textarea { background: rgba(255, 255, 255, 0.95); }

/* ---- ハンバーガードロワー ---- */
.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9;
  background: rgba(0, 0, 0, 0.45);
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s;
}

.menu-backdrop.open { opacity: 1; visibility: visible; }

.menu-drawer {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 10;
  width: min(360px, 86vw);
  padding: 18px;
  overflow-y: auto;
  background: #111827;
  color: #e5e7eb;
  transform: translateX(-100%);
  visibility: hidden;
  transition: transform 0.2s ease, visibility 0.2s;
}

.menu-drawer.open { transform: translateX(0); visibility: visible; }
body.menu-open { overflow: hidden; }

.menu-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}

.menu-header h1 { color: #fff; font-size: 1.25rem; }

.menu-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
}

.menu-section h2 { color: #c7d2fe; font-size: 0.9rem; }
.menu-section label { color: #cbd5e1; font-size: 0.8rem; }

.menu-section select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #475569;
  border-radius: 8px;
  background: #1f2937;
  color: #e5e7eb;
  font-family: inherit;
}

.menu-footer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  color: #94a3b8;
  font-size: 0.72rem;
}

/* ---- split（互換） ---- */
body.split-mode #app {
  max-width: none;
  height: 100vh;
  min-height: 0;
  padding: 18px 22px;
  display: grid;
  grid-template-columns: minmax(420px, 1fr) minmax(0, 1fr);
  grid-template-rows: auto auto minmax(0, 1fr);
  grid-template-areas:
    "bar stage"
    "info stage"
    "chat stage";
  gap: 14px 18px;
}

body.split-mode #studioBar {
  grid-area: bar;
  padding: 0;
  background: none;
  backdrop-filter: none;
}

body.split-mode #characterInfo {
  grid-area: info;
  padding: 0;
  background: none;
  color: inherit;
}

body.split-mode #characterInfo .character-name { color: #4f46e5; }
body.split-mode #characterInfo .services { color: #64748b; }
body.split-mode #characterInfo .character-face {
  font-size: 48px;
  animation: float 3s ease-in-out infinite;
}

body.split-mode #chatOverlay {
  grid-area: chat;
  position: static;
  width: auto;
  max-height: none;
  padding: 0;
  background: none;
  box-shadow: none;
  backdrop-filter: none;
}

body.split-mode #conversation {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  margin-bottom: 12px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  color: inherit;
}

body.split-mode #stage {
  grid-area: stage;
  min-height: 0;
  height: 100%;
}

body.split-mode .avatar-sprite {
  top: 50%;
  height: calc(90% * var(--avatar-scale, 1));
  width: auto;
  min-width: 0;
  transform: translate(-50%, -50%);
}

body.split-mode .caption {
  bottom: 24px;
  max-width: 86%;
  padding: 10px 18px;
  font-size: 26px;
}

body.split-mode:has(#stage.hidden) #app {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "bar" "info" "chat";
}

/* ---- chat（互換） ---- */
body.chat-mode #app {
  max-width: 820px;
  height: 100vh;
  min-height: 0;
  padding: 20px;
  display: flex;
  flex-direction: column;
}

body.chat-mode #studioBar { order: 0; }
body.chat-mode #characterInfo { order: 1; }
body.chat-mode #chatOverlay { order: 2; flex: 1 1 auto; min-height: 0; }
body.chat-mode #stage,
body.chat-mode #caption { display: none !important; }

body.chat-mode #conversation {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
}

/* ---- stage（配信） ---- */
body.stage-mode #app { max-width: none; min-height: 100vh; padding: 0; }

body.stage-mode #studioBar,
body.stage-mode #characterInfo,
body.stage-mode #chatOverlay,
body.stage-mode #menuDrawer,
body.stage-mode #menuBackdrop { display: none; }

body.stage-mode #stage { min-height: 100vh; }
```

- [ ] **Step 2: レスポンシブを追加する**

`style.css` の末尾に追加:

```css
@media (max-width: 720px) {
  body.studio-mode #chatOverlay {
    left: 8px;
    right: 8px;
    bottom: 8px;
    width: auto;
    max-height: 40vh;
  }

  body.studio-mode #studioBar {
    gap: 6px;
    padding: 10px 12px;
  }

  body.studio-mode #studioBar .level-row {
    flex-basis: 100%;
    min-width: 0;
  }

  body.studio-mode #characterInfo {
    top: 96px;
    right: 12px;
    max-width: 70vw;
  }

  .menu-drawer { width: min(360px, 86vw); }
}

@media (max-width: 480px) {
  body.studio-mode #characterInfo .services { display: none; }
  body.studio-mode #characterInfo .character-face { font-size: 22px; }
  body.studio-mode #characterInfo .character-name { font-size: 0.85rem; }
}

@media (prefers-reduced-motion: reduce) {
  .menu-drawer { transition: none; }
  .menu-backdrop { transition: none; }
}
```

- [ ] **Step 3: ビルドと既存テストを実行する**

Run:

```powershell
npm run verify
```

Expected: すべて pass。

- [ ] **Step 4: コミットする**

```powershell
git add src/frontend/style.css
git commit -m "feat(ui): studio レイアウトとハンバーガードロワーを追加" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: `start.bat` の既定を studio にし、README / AGENTS を更新する

**Files:**
- Modify: `start.bat`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `?mode=studio`（Task 1）
- Produces: 既定 URL `?mode=studio`、`start.bat /studio`、ドキュメント

- [ ] **Step 1: `start.bat` を変更する**

`set "LAYOUT=split"` を `set "LAYOUT=studio"` に変更する。

`:parse_args` に追加:

```bat
if /i "%~1"=="/studio" set "LAYOUT=studio"
```

ヒント表示を更新:

```bat
echo   レイアウト: studio=キャラクター + 左下チャット（既定） / split=従来の 2 画面 / chat=チャットのみ / stage=配信画面
echo   指定: start.bat /studio /split /chat /stage /nobrowser
```

- [ ] **Step 2: README を更新する**

`## 起動` セクションのレイアウト例を次のように更新する:

```markdown
.\start.bat              # 既定: studio（全面キャラクター + 左下チャット）
.\start.bat /studio      # studio を明示
.\start.bat /split       # 従来の 2 画面（左: チャット / 右: アバター）
.\start.bat /chat        # チャットのみ
.\start.bat /stage       # 配信画面（アバター + 字幕）
.\start.bat /nobrowser   # ブラウザを自動で開かない
```

`start.bat` の既定 URL の説明を `?mode=studio` に更新する。

- [ ] **Step 3: AGENTS.md の 12-12 を更新する**

`12-12.` の末尾の `StageView` の記述を次のように置き換える:

```markdown
    `StageView` は既定を **studio（全面キャラクター + 左下チャット + 上部バー + 左ドロワー）** にし、
    `?mode=split`（従来の 2 画面）/ `?mode=chat`（チャットのみ）/
    `?mode=stage&transparent=1`（配信画面）で切り替える。字幕は `#stage` の中に置き、
    split / stage で表示する（studio ではチャットが字幕を兼ねる）。
    ハンバーガーメニューは `frontend/MenuDrawer.ts`、常時表示はマイク/停止・状態・レベル。
```

- [ ] **Step 4: 静的チェックを実行する**

Run:

```powershell
findstr /C:"LAYOUT=studio" start.bat
findstr /C:"/studio" start.bat
findstr /C:"studio" README.md
findstr /C:"studio" AGENTS.md
```

Expected: 4 つすべて一致する。

- [ ] **Step 5: コミットする**

```powershell
git add start.bat README.md AGENTS.md
git commit -m "docs(ui): studio レイアウトを既定に変更" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: 結合確認

**Files:**
- Test: 既存の手動シナリオ（コード変更なし）

**Interfaces:**
- Consumes: Task 1〜6 のすべて
- Produces: 受け入れ条件の確認結果

- [ ] **Step 1: 全体検証を実行する**

Run:

```powershell
npm run verify
```

Expected: typecheck / test / build がすべて成功する。

- [ ] **Step 2: ブラウザで studio を確認する**

Run:

```powershell
.\start.bat /nobrowser
```

ブラウザで `http://localhost:3000/?mode=studio` を開き、次を確認する:

1. 全面キャラクター + 左下チャット + 上部バー
2. マイク/停止・状態・レベルが常時表示
3. ☰ でドロワーが開き、言語・マイク・モデル設定・診断・履歴クリアが使える
4. `Esc` / 背景クリック / × で閉じ、フォーカスが ☰ に戻る
5. チャットカードでテキスト送信・履歴・ストリーミング表示が動く
6. 字幕が表示されない（チャットが字幕を兼ねる）

- [ ] **Step 3: 既存モードを確認する**

`?mode=split` / `?mode=chat` / `?mode=stage&transparent=1` を開き、従来どおり動くことを確認する。
`stage` ではアバター + 字幕のみで、上部バー・チャット・ドロワーが表示されないこと。

- [ ] **Step 4: フォールバックとレスポンシブを確認する**

1. `avatar.enabled = false` または `renderer = "none"` で studio を開き、背景・キャラ情報・チャットが表示される
2. ブラウザ幅を 720px / 480px 未満にして、チャットカード・ドロワー・キャラ情報が崩れない

- [ ] **Step 5: 変更を確認する**

```powershell
git status --short
git log --oneline -6
```

Expected: 意図したファイルだけが変更・コミットされている。未コミットの変更があれば、対応するタスクのコミットへ含める。

---

## 最終レビュー追補（2026-11-27）

最終レビューで以下を修正した。Task 5 の CSS を再適用するときは、この追補を優先すること。

- split の狭幅レイアウト（`@media (max-width: 1100px)`）を復元した（Task 5 で一度削除されていた）。
  `body.split-mode #app` は 1 カラムで `grid-template-areas: "bar" "info" "chat" "stage"`、
  `height: auto; min-height: 100vh`。`body.split-mode #stage` は `height: 48vh; min-height: 320px`、
  `body.split-mode #conversation` は `max-height: 46vh`。stage はチャットの下に積まれる。
- split / chat の `#characterInfo` は白カードに戻した。紫のグラデーション上で `#4f46e5` / `#64748b` が
  読めないため、`padding: 10px 14px; border-radius: 14px; background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);` を適用する。split の `padding: 0; background: none;`
  は使わない。studio の暗いピルは変更しない。
