# VTuber 化 P3（アバター描画・ステージモード・口パク）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `?mode=stage` で「アバター + 字幕だけ」の配信向け画面を出し、`volumes` に合わせて口を動かす。Live2D が無くても CSS 立ち絵（sprite）で動く。

**Architecture:** `shared/avatar/lipSync.ts`（純粋）で口の開きを計算し、`frontend/avatar/` の `AvatarRenderer` 抽象（sprite / null）と `AvatarStage` が描画を担う。`StageView` が body クラス・字幕・マウントを受け持ち、`app.ts` は「イベントを誰に渡すか」だけを持つ。

**Tech Stack:** TypeScript 5（strict）/ esbuild IIFE / CSS / `node:test`

## Global Constraints

- `develop` ブランチ。日本語コミット。作業後に `npm run verify`。
- 純粋ロジックは `src/shared`（`node:test`）。DOM/Canvas はテストしない（型と `frontend-script` テストで担保）。
- フロントは esbuild の IIFE のみ。
- **`renderer: "live2d"` は P3 では sprite にフォールバック**（P4 で本実装）。CI とモデル無し環境で必ず動くこと。
- 透過は OBS のブラウザソースで追加 CSS 不要（`body.transparent`）。
- 実測環境: Edge 157 / RTX 3060 12GB / OBS 30 系。

## スコープ

P3 のみ（設計書 §6）。感情タグ（P5）と Live2D 実装（P4）は対象外。

---

## ファイル構成

| パス | 役割 |
|---|---|
| `src/shared/avatar/lipSync.ts`（新規） | `mouthLevelAt()`（純粋） |
| `src/shared/ui/stageMode.ts`（新規） | `?mode=stage&transparent=1` の解釈（純粋） |
| `src/frontend/avatar/types.ts`（新規） | `AvatarRenderer` インターフェース |
| `src/frontend/avatar/NullRenderer.ts` / `SpriteRenderer.ts`（新規） | 実装 |
| `src/frontend/avatar/AvatarStage.ts`（新規） | 生成・フォールバック・口パク転送 |
| `src/frontend/avatar/LipSyncDriver.ts`（新規） | rAF で口を更新 |
| `src/frontend/StageView.ts`（新規） | body クラス・字幕・マウント |
| `src/frontend/AudioPlayer.ts`（変更） | `isPlaying` / `elapsedMs` / `currentVolumes` |
| `src/frontend/index.html` / `style.css`（変更） | `#stage` / `#caption` / `.stage-mode` / `.transparent` |
| `src/frontend/app.ts`（変更） | 組み立て |
| `src/backend/server/avatarPayload.ts`（変更） | モデル無し → `sprite` |
| `tests/lip-sync.test.ts` / `tests/stage-mode.test.ts`（新規） | 回帰 |

---

### Task 1: `mouthLevelAt`（口の開き・純粋）

**Files:**
- Create: `src/shared/avatar/lipSync.ts`
- Test: `tests/lip-sync.test.ts`（新規）

**Interfaces:**
- Produces: `mouthLevelAt(volumes: number[], sliceMs: number, elapsedMs: number, options?: { previous?: number; smoothing?: number }): number`

- [ ] **Step 1: 失敗するテストを書く**

`tests/lip-sync.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mouthLevelAt } from "../src/shared/avatar/lipSync";

test("音量列が空なら 0", () => {
  assert.equal(mouthLevelAt([], 20, 100), 0);
});

test("再生時刻のスライス値を返す", () => {
  const volumes = [0.2, 0.6, 1];
  assert.equal(mouthLevelAt(volumes, 20, 0), 0.2);
  assert.equal(mouthLevelAt(volumes, 20, 20), 0.6);
  assert.equal(mouthLevelAt(volumes, 20, 40), 1);
});

test("スライスの間は線形補間する", () => {
  const volumes = [0, 1];
  assert.equal(mouthLevelAt(volumes, 20, 10), 0.5);
});

test("末尾を超えたら 0（口を閉じる）", () => {
  assert.equal(mouthLevelAt([1, 1], 20, 1000), 0);
});

test("smoothing で前回値から追従する", () => {
  assert.equal(mouthLevelAt([1], 20, 0, { previous: 0, smoothing: 0.5 }), 0.5);
  assert.equal(mouthLevelAt([1], 20, 0, { previous: 0.5, smoothing: 1 }), 1);
  assert.equal(mouthLevelAt([1], 20, 0, { previous: 0.5, smoothing: 0 }), 0.5);
});

test("値は 0..1 に収まる", () => {
  assert.equal(mouthLevelAt([2], 20, 0), 1);
  assert.equal(mouthLevelAt([-1], 20, 0), 0);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsc -p tsconfig.test.json`
Expected: FAIL（モジュールが見つからない）

- [ ] **Step 3: 実装する**

`src/shared/avatar/lipSync.ts`:

```ts
/**
 * 音量列（20ms スライスの 0..1）から、その時点の口の開きを求める。
 * `previous` を渡すと前回値から `smoothing`（0..1）で追従する。
 */
export function mouthLevelAt(
  volumes: number[],
  sliceMs: number,
  elapsedMs: number,
  options: { previous?: number; smoothing?: number } = {}
): number {
  const target = sample(volumes, sliceMs, elapsedMs);
  const previous = clamp01(options.previous ?? target);
  const smoothing = clamp01(options.smoothing ?? 1);
  return clamp01(previous + (target - previous) * smoothing);
}

function sample(volumes: number[], sliceMs: number, elapsedMs: number): number {
  if (volumes.length === 0 || sliceMs <= 0 || elapsedMs < 0) {
    return 0;
  }
  const position = elapsedMs / sliceMs;
  const index = Math.floor(position);
  if (index >= volumes.length) {
    return 0;
  }
  const next = volumes[index + 1];
  if (next === undefined) {
    return clamp01(volumes[index]);
  }
  const fraction = position - index;
  return clamp01(volumes[index] * (1 - fraction) + next * fraction);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
```

- [ ] **Step 4: テストを通す**

Run: `npx tsc -p tsconfig.test.json; node --test --test-timeout=30000 "dist-test/tests/lip-sync.test.js"`
Expected: PASS（6 件）

- [ ] **Step 5: コミット**

```bash
git add src/shared/avatar/lipSync.ts tests/lip-sync.test.ts
git commit -m "feat(avatar): 音量列から口の開きを求める mouthLevelAt を追加"
```

---

### Task 2: `?mode=stage` の解釈（純粋）

**Files:**
- Create: `src/shared/ui/stageMode.ts`
- Test: `tests/stage-mode.test.ts`（新規）

**Interfaces:**
- Produces: `parseStageOptions(search: string): { mode: "chat" | "stage"; transparent: boolean }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/stage-mode.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseStageOptions } from "../src/shared/ui/stageMode";

test("既定はチャットモード", () => {
  assert.deepEqual(parseStageOptions(""), { mode: "chat", transparent: false });
  assert.deepEqual(parseStageOptions("?"), { mode: "chat", transparent: false });
});

test("mode=stage を読む", () => {
  assert.deepEqual(parseStageOptions("?mode=stage"), { mode: "stage", transparent: false });
});

test("transparent=1 を読む", () => {
  assert.deepEqual(parseStageOptions("?mode=stage&transparent=1"), { mode: "stage", transparent: true });
  assert.deepEqual(parseStageOptions("?transparent=true"), { mode: "chat", transparent: true });
});

test("未知の値は既定へ落とす", () => {
  assert.deepEqual(parseStageOptions("?mode=bogus&transparent=yes"), {
    mode: "chat",
    transparent: false,
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsc -p tsconfig.test.json`
Expected: FAIL

- [ ] **Step 3: 実装する**

`src/shared/ui/stageMode.ts`:

```ts
export interface StageOptions {
  mode: "chat" | "stage";
  transparent: boolean;
}

/** `location.search` からレイアウトの指定を読む（`?mode=stage&transparent=1`） */
export function parseStageOptions(search: string): StageOptions {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const mode = params.get("mode") === "stage" ? "stage" : "chat";
  const flag = params.get("transparent");
  const transparent = flag === "1" || flag === "true";
  return { mode, transparent };
}
```

- [ ] **Step 4: テストを通す**

Run: `npx tsc -p tsconfig.test.json; node --test --test-timeout=30000 "dist-test/tests/stage-mode.test.js"`
Expected: PASS（4 件）

- [ ] **Step 5: コミット**

```bash
git add src/shared/ui/stageMode.ts tests/stage-mode.test.ts
git commit -m "feat(ui): ステージモードと透過のクエリ解釈を追加"
```

---

### Task 3: モデルが無ければ `sprite` にする

**Files:**
- Modify: `src/backend/server/avatarPayload.ts`
- Test: `tests/avatar-payload.test.ts`（期待値を更新）

- [ ] **Step 1: テストの期待値を変える**

`tests/avatar-payload.test.ts` の `"モデルが無ければ none"` を:

```ts
test("モデルが無ければ sprite（CSS 立ち絵へフォールバック）", () => {
  const payload = buildAvatarPayload(DEFAULT_CONFIG.avatar, []);
  assert.equal(payload.renderer, "sprite");
  assert.equal(payload.modelUrl, "");
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`renderer` が `"none"`）

- [ ] **Step 3: 実装する**

`avatarPayload.ts` の `renderer` を:

```ts
    renderer: config.enabled ? (model ? "live2d" : "sprite") : "none",
```

- [ ] **Step 4: テストを通す**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/backend/server/avatarPayload.ts tests/avatar-payload.test.ts
git commit -m "feat(avatar): モデルが無いときは CSS 立ち絵（sprite）へフォールバックする"
```

---

### Task 4: レンダラ抽象とステージ

**Files:**
- Create: `src/frontend/avatar/types.ts` / `NullRenderer.ts` / `SpriteRenderer.ts` / `AvatarStage.ts` / `LipSyncDriver.ts` / `src/frontend/StageView.ts`
- Modify: `src/frontend/index.html` / `src/frontend/style.css`

**Interfaces:**
- Produces: `AvatarRenderer`（`mount/setMouth/setExpression/playMotion/destroy`）/ `AvatarStage.mount(container, config)` / `StageView.apply(options)` / `StageView.mountAvatar(config)` / `StageView.setCaption(text, final)` / `StageView.setMouth(level)`

- [ ] **Step 1: 抽象と実装を作る**

`src/frontend/avatar/types.ts`:

```ts
import type { AvatarConfigPayload } from "../../shared/protocol";

/** アバター描画の抽象（Live2D / CSS 立ち絵 / 無効） */
export interface AvatarRenderer {
  readonly name: "live2d" | "sprite" | "none";
  mount(container: HTMLElement, config: AvatarConfigPayload): Promise<void>;
  /** 口の開き 0..1 */
  setMouth(level: number): void;
  setExpression(name: string | null): void;
  playMotion(group: string, index?: number): void;
  destroy(): void;
}
```

`src/frontend/avatar/NullRenderer.ts`:

```ts
import type { AvatarConfigPayload } from "../../shared/protocol";
import type { AvatarRenderer } from "./types";

/** アバター無効時のダミー */
export class NullRenderer implements AvatarRenderer {
  readonly name = "none" as const;
  async mount(_container: HTMLElement, _config: AvatarConfigPayload): Promise<void> {
    // 何もしない
  }
  setMouth(_level: number): void {
    // 何もしない
  }
  setExpression(_name: string | null): void {
    // 何もしない
  }
  playMotion(_group: string, _index?: number): void {
    // 何もしない
  }
  destroy(): void {
    // 何もしない
  }
}
```

`src/frontend/avatar/SpriteRenderer.ts`:

```ts
import type { AvatarConfigPayload } from "../../shared/protocol";
import type { AvatarRenderer } from "./types";

/**
 * CSS 立ち絵のフォールバック。画像アセットが無くても必ず表示できるよう、
 * 顔・目・口を DOM で描く（Live2D / 画像が用意できたら差し替える）。
 */
export class SpriteRenderer implements AvatarRenderer {
  readonly name = "sprite" as const;
  private root: HTMLElement | null = null;
  private mouth: HTMLElement | null = null;
  private expression: HTMLElement | null = null;

  async mount(container: HTMLElement, config: AvatarConfigPayload): Promise<void> {
    this.destroy();
    const root = document.createElement("div");
    root.className = "avatar-sprite";
    root.style.setProperty("--avatar-scale", String(config.scale));
    root.style.background = config.background;
    root.style.left = `${config.offsetX * 100}%`;
    root.style.top = `${config.offsetY * 100}%`;

    const face = document.createElement("div");
    face.className = "avatar-face";

    const eyeLeft = document.createElement("div");
    eyeLeft.className = "avatar-eye avatar-eye-left";
    const eyeRight = document.createElement("div");
    eyeRight.className = "avatar-eye avatar-eye-right";

    const mouth = document.createElement("div");
    mouth.className = "avatar-mouth";

    const expression = document.createElement("div");
    expression.className = "avatar-expression";

    face.append(eyeLeft, eyeRight, mouth, expression);
    root.append(face);
    container.append(root);

    this.root = root;
    this.mouth = mouth;
    this.expression = expression;
  }

  setMouth(level: number): void {
    if (!this.mouth) {
      return;
    }
    const clamped = Math.min(1, Math.max(0, level));
    this.mouth.style.height = `${4 + clamped * 22}px`;
    this.mouth.style.borderRadius = `${clamped * 50}%`;
  }

  setExpression(name: string | null): void {
    if (!this.expression) {
      return;
    }
    this.expression.textContent = name ? `[${name}]` : "";
  }

  playMotion(_group: string, _index?: number): void {
    // sprite ではモーションを持たない
  }

  destroy(): void {
    this.root?.remove();
    this.root = null;
    this.mouth = null;
    this.expression = null;
  }
}
```

`src/frontend/avatar/AvatarStage.ts`:

```ts
import { Logger } from "../../backend/core/logger";
import type { AvatarConfigPayload } from "../../shared/protocol";
import { NullRenderer } from "./NullRenderer";
import { SpriteRenderer } from "./SpriteRenderer";
import type { AvatarRenderer } from "./types";

/**
 * 設定に応じてレンダラを選ぶ。
 * P3 では `live2d` を要求されても sprite へフォールバックする（P4 で本実装）。
 */
export class AvatarStage {
  private renderer: AvatarRenderer = new NullRenderer();
  private readonly logger = new Logger("Avatar");

  async mount(container: HTMLElement, config: AvatarConfigPayload): Promise<void> {
    this.destroy();
    if (!config.enabled) {
      this.renderer = new NullRenderer();
    } else {
      if (config.renderer === "live2d") {
        this.logger.info("Live2D は P4 で実装予定のため CSS 立ち絵で表示します");
      }
      this.renderer = new SpriteRenderer();
    }
    await this.renderer.mount(container, config);
  }

  setMouth(level: number): void {
    this.renderer.setMouth(level);
  }

  setExpression(name: string | null): void {
    this.renderer.setExpression(name);
  }

  playMotion(group: string, index?: number): void {
    this.renderer.playMotion(group, index);
  }

  destroy(): void {
    this.renderer.destroy();
    this.renderer = new NullRenderer();
  }
}
```

`src/frontend/avatar/LipSyncDriver.ts`:

```ts
import { mouthLevelAt } from "../../shared/avatar/lipSync";
import type { AudioPlayer } from "../AudioPlayer";

export interface LipSyncDeps {
  player: AudioPlayer;
  onLevel(level: number): void;
  /** 0..1（大きいほど追従が速い） */
  smoothing: number;
}

/** 再生時刻と音量列から口の開きを毎フレーム更新する */
export class LipSyncDriver {
  private raf = 0;
  private level = 0;
  private running = false;

  constructor(private readonly deps: LipSyncDeps) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const tick = (): void => {
      const info = this.deps.player.isPlaying() ? this.deps.player.currentVolumes() : null;
      const target = info
        ? mouthLevelAt(info.volumes, info.sliceMs, this.deps.player.elapsedMs(), {
            previous: this.level,
            smoothing: this.deps.smoothing,
          })
        : mouthLevelAt([], 20, 0, { previous: this.level, smoothing: this.deps.smoothing });
      this.level = target;
      this.deps.onLevel(target);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
```

`src/frontend/StageView.ts`:

```ts
import type { AvatarConfigPayload } from "../shared/protocol";
import type { StageOptions } from "../shared/ui/stageMode";
import { AvatarStage } from "./avatar/AvatarStage";
import { must } from "./dom";

/** ステージ（配信向けレイアウト）と字幕・アバターの表示を担当する */
export class StageView {
  private readonly stageEl = must<HTMLElement>("stage");
  private readonly captionEl = must<HTMLElement>("caption");
  private readonly avatar = new AvatarStage();
  private mode: "chat" | "stage" = "chat";

  apply(options: StageOptions): void {
    this.mode = options.mode;
    document.body.classList.toggle("stage-mode", options.mode === "stage");
    document.body.classList.toggle("transparent", options.transparent);
    this.stageEl.classList.toggle("hidden", options.mode !== "stage");
    this.captionEl.classList.toggle("hidden", options.mode !== "stage");
  }

  async mountAvatar(config: AvatarConfigPayload): Promise<void> {
    await this.avatar.mount(this.stageEl, config);
    const empty = config.renderer === "none";
    this.stageEl.classList.toggle("hidden", this.mode !== "stage" || empty);
  }

  setMouth(level: number): void {
    this.avatar.setMouth(level);
  }

  setCaption(text: string, final: boolean): void {
    this.captionEl.textContent = text;
    this.captionEl.classList.toggle("final", final);
    if (this.mode === "stage") {
      this.captionEl.classList.remove("hidden");
    }
  }
}
```

- [ ] **Step 2: `index.html` に要素を足す**

`<div id="app">` の直後:

```html
    <section id="stage" class="stage hidden"></section>
```

`<footer class="footer">` の前:

```html
    <div id="caption" class="caption hidden"></div>
```

- [ ] **Step 3: `style.css` に追記する**

```css
/* ---- VTuber ステージ ---- */
.stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 320px;
  overflow: hidden;
}

.avatar-sprite {
  position: relative;
  width: calc(220px * var(--avatar-scale, 1));
  height: calc(300px * var(--avatar-scale, 1));
  transform: translate(-50%, -50%);
  border-radius: 45% 45% 40% 40%;
  background: #1f2430;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
}

.avatar-face {
  position: absolute;
  inset: 12% 10% 10%;
  border-radius: 50% 50% 45% 45%;
  background: #f7e9de;
}

.avatar-eye {
  position: absolute;
  top: 38%;
  width: 12%;
  height: 8%;
  border-radius: 50%;
  background: #2b2b2b;
}
.avatar-eye-left { left: 22%; }
.avatar-eye-right { right: 22%; }

.avatar-mouth {
  position: absolute;
  left: 50%;
  bottom: 22%;
  width: 22%;
  height: 4px;
  transform: translateX(-50%);
  background: #b3455b;
  border-radius: 2px;
  transition: height 60ms linear;
}

.avatar-expression {
  position: absolute;
  right: 6%;
  bottom: 4%;
  font-size: 0.75rem;
  color: #6b7280;
}

.caption {
  position: fixed;
  left: 50%;
  bottom: 6vh;
  max-width: 80vw;
  transform: translateX(-50%);
  padding: 12px 22px;
  border-radius: 14px;
  background: rgba(15, 17, 23, 0.72);
  color: #fff;
  font-size: 34px;
  line-height: 1.45;
  text-align: center;
  white-space: pre-wrap;
}
.caption.final { opacity: 0.92; }

body.stage-mode { background: #0f1117; overflow: hidden; }
body.stage-mode #app { max-width: none; min-height: 100vh; padding: 0; }
body.stage-mode header,
body.stage-mode .character,
body.stage-mode .conversation,
body.stage-mode .mic-row,
body.stage-mode .composer,
body.stage-mode .controls,
body.stage-mode .diagnostics,
body.stage-mode .settings,
body.stage-mode footer { display: none; }
body.stage-mode #stage { min-height: 100vh; }

body.transparent { background: transparent !important; }
body.transparent #app { background: transparent; }
```

- [ ] **Step 4: 型とビルドを通す**

Run: `npm run typecheck`
Expected: エラーなし（`StageView` はまだ未使用でも可）

Run: `npm run build`
Expected: `dist/frontend/index.html` に `#stage` が含まれ、`app.js` が生成される

- [ ] **Step 5: コミット**

```bash
git add src/frontend/avatar src/frontend/StageView.ts src/frontend/index.html src/frontend/style.css
git commit -m "feat(ui): アバター描画の抽象（sprite / null）とステージ・字幕の土台を追加"
```

---

### Task 5: 口パクの配線と字幕

**Files:**
- Modify: `src/frontend/AudioPlayer.ts`（再生位置・音量列の公開）
- Modify: `src/frontend/app.ts`
- Modify: `tests/frontend-script.test.ts`（スタブ DOM の拡張）

**Interfaces:**
- Consumes: `StageView` / `LipSyncDriver` / `parseStageOptions`（Task 2・4）
- Produces: `AudioPlayer.isPlaying(): boolean` / `elapsedMs(): number` / `currentVolumes(): { volumes: number[]; sliceMs: number } | null`

- [ ] **Step 1: `AudioPlayer` に再生位置を足す**

フィールドに:

```ts
  private currentVolumesInfo: { volumes: number[]; sliceMs: number } | null = null;
  private startedAt = 0;
```

`pump()` で `source.start();` の直前に:

```ts
    this.startedAt = this.context().currentTime;
    this.currentVolumesInfo = { volumes: next.event.volumes, sliceMs: next.event.sliceMs };
```

`source.onended` と `stop()` で `this.currentVolumesInfo = null;` を足す。メソッド:

```ts
  isPlaying(): boolean {
    return this.playing;
  }

  /** 現在の音声の再生位置（ms） */
  elapsedMs(): number {
    return this.ctx ? Math.max(0, (this.ctx.currentTime - this.startedAt) * 1000) : 0;
  }

  /** 再生中の音量列（口パク用）。停止中は null */
  currentVolumes(): { volumes: number[]; sliceMs: number } | null {
    return this.currentVolumesInfo;
  }
```

- [ ] **Step 2: `app.ts` にステージと口パクを組み込む**

import に:

```ts
import { LipSyncDriver } from "./avatar/LipSyncDriver";
import { StageView } from "./StageView";
import { parseStageOptions } from "../shared/ui/stageMode";
```

フィールド:

```ts
  /** 配信向けステージ（アバター + 字幕） */
  private readonly stage = new StageView();
  private lipSync: LipSyncDriver | null = null;
  /** 字幕の組み立て用バッファ */
  private caption = "";
```

`start()` の `this.bindEvents();` の前に:

```ts
    this.stage.apply(parseStageOptions(window.location.search));
```

`applyHello()` の末尾（`audioPlayer` の生成後）:

```ts
    void this.stage.mountAvatar(hello.avatar);
    if (this.audioPlayer) {
      this.lipSync = new LipSyncDriver({
        player: this.audioPlayer,
        onLevel: (level) => this.stage.setMouth(level),
        smoothing: hello.avatar.lipSync.smoothing,
      });
      this.lipSync.start();
    }
```

`handleEvent()` の `switch` に:

```ts
      case "llm_started":
        this.caption = "";
        this.stage.setCaption("", false);
        break;
      case "llm_delta":
        this.caption += event.content;
        this.stage.setCaption(this.caption, false);
        break;
```

`case "llm_complete":` に:

```ts
        this.caption = event.text;
        this.stage.setCaption(event.text, true);
```

- [ ] **Step 3: フロントのテストスタブを新しい DOM に合わせる**

`tests/frontend-script.test.ts`:

1. `createElement` の返り値に `classList` を足す:

```ts
    classList: {
      toggle: () => undefined,
      add: () => undefined,
      remove: () => undefined,
      contains: () => false,
    },
```

2. `documentStub` に `body: createElement()` を足す。

3. `ELEMENT_IDS` に `"stage"` と `"caption"` を足す。

4. `vm.runInNewContext` の sandbox に `requestAnimationFrame: () => 0, cancelAnimationFrame: () => undefined,` を足す。

- [ ] **Step 4: 型・テスト・ビルドを通す**

Run: `npm run verify`
Expected: すべて PASS（`frontend-script` の既存 6 件も緑のまま）

- [ ] **Step 5: 手動確認**

1. `npm start` → `http://localhost:3000/?mode=stage&transparent=1`
2. アバター（CSS 立ち絵）と字幕だけが表示され、ヘッダ・入力欄・設定が消える
3. 送信 → 字幕がストリーミングで伸び、**口が動く**（sprite の口の高さが変わる）
4. `?mode=stage` なし（通常）では従来のチャット画面のまま

- [ ] **Step 6: コミット**

```bash
git add src/frontend/AudioPlayer.ts src/frontend/app.ts tests/frontend-script.test.ts
git commit -m "feat(ui): ステージ表示と音量連動の口パクを配線する"
```

---

### Task 6: ドキュメントと最終検証

- [ ] **Step 1: ドキュメント更新**

`README.md` の VTuber モード節に:

```markdown
- 画面: `http://localhost:3000/?mode=stage&transparent=1` で「アバター + 字幕」だけの配信画面。
  OBS のブラウザソース（1920×1080 / 30fps）にそのまま入れられる
- アバター: モデルが無いときは CSS 立ち絵（`renderer: "sprite"`）で表示し、`volumes` に合わせて口が動く
```

`AGENTS.md` の 12 章に:

```markdown
12-12. **アバター描画は `AvatarRenderer` 抽象**（`frontend/avatar/`）。P3 は `sprite`（CSS 立ち絵）と `none` のみで、
    `live2d` を要求されても sprite にフォールバックする。口パクは `mouthLevelAt()`（`shared/avatar/lipSync.ts`）に
    再生位置と `volumes` を渡す。`StageView` は `?mode=stage&transparent=1` で body クラスを切り替える。
```

`docs/REDESIGN.md` に「13.5 アバター描画とステージ（P3）」を追記（抽象・フォールバック・口パク・字幕）。

- [ ] **Step 2: 最終検証**

Run: `npm run verify`
Expected: typecheck ✅ / テスト ✅ / build ✅

Run: `git status --porcelain`
Expected: 意図したファイルのみ

- [ ] **Step 3: コミット**

```bash
git add README.md AGENTS.md docs/REDESIGN.md
git commit -m "docs: ステージモードと口パクの使い方を追記"
```

---

## 計画のセルフレビュー（実施済み）

| 仕様（設計書 §6） | タスク |
|---|---|
| 6.1 `AvatarRenderer` 抽象とフォールバック | Task 4 |
| 6.2 モデル不在時の sprite | Task 3 / 4 |
| 6.3 `mouthLevelAt` と `LipSyncDriver` | Task 1 / 4 / 5 |
| 6.4 `?mode=stage` / 透過 / 字幕 | Task 2 / 4 / 5 |
| 6.5 状態との対応（口を閉じる・字幕） | Task 5 |

**実装上の注意（計画時点で判明）**

- `frontend` から `backend/core/logger` を import しない（`fs` 依存でブラウザバンドルが壊れる）。`AvatarStage` は `console.info` を使う。
- フロントのスタブ DOM には `body` / `classList` / `requestAnimationFrame` が無いため、Task 5 でスタブを拡張する。






