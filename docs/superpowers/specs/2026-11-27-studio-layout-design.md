# studio レイアウト設計（2026-11-27）

対象: `smart_speaker_ts` フロントエンド（`src/frontend/`）
基準コミット: `32ce2a6`（develop）
作業ブランチ: `develop`
目的: 左カラムを廃止し、チャット以外の UI をハンバーガーメニューへ集約する。
チャットは右側のキャラクター画面へ統合し、キャラクター中心の画面にする。

---

## 1. 背景と目的

現在の `split` レイアウトは、左カラムに「ヘッダー・キャラ情報・チャット・マイク・入力・操作・診断・設定」を置き、
右カラムにアバターと字幕を置いている。情報量が多く、キャラクターより UI が目立つ。

本設計では次を実現する。

1. 左カラムを廃止し、チャット以外の UI を左のハンバーガードロワーへ集約する
2. チャットを右のキャラクター画面へ統合する（左下のフローティングカード、常時表示）
3. 聞き取り開始/停止・状態・マイクレベルだけは常時表示し、主要操作を 1 クリックに保つ
4. キャラクター情報（名前・ラベル・サービス状態）は右のキャラクター画面に残す
5. 既存の `split` / `chat` / `stage`（配信）モードを壊さない

---

## 2. 決定事項（ユーザー承認済み）

| 項目 | 決定 |
|---|---|
| 常時表示する操作 | マイク/停止、状態、マイクレベル |
| チャットの配置 | 右のキャラクター画面の左下にフローティングカード |
| チャットの表示 | 常時表示（折りたたみなし） |
| キャラクター情報 | 右のキャラクター画面に残す（名前・顔文字・サービス状態） |
| 新モード | `studio` を追加し、既定を `studio` にする |
| 既存モード | `split` / `chat` / `stage` は維持 |
| 字幕 | `studio` では非表示（チャットが字幕を兼ねる）。`split` / `stage` では従来どおり |

---

## 3. モード設計

`StageMode` を `"chat" | "stage" | "split" | "studio"` に拡張する。

| モード | 用途 | レイアウト |
|---|---|---|
| `studio`（新規・既定） | 通常利用 | 全面キャラクター + 左下チャット + 上部バー + 左ドロワー |
| `split`（互換） | 従来の 2 画面 | 左: 上部バー + キャラ情報 + チャット / 右: アバター + 字幕 |
| `chat`（互換） | チャットのみ | 上部バー + キャラ情報 + 全面チャット |
| `stage`（配信） | OBS など | アバター + 字幕のみ。既存挙動を維持 |

- `src/shared/ui/stageMode.ts` の既定を `studio` に変更する
- `start.bat` の既定を `studio` にし、`/studio` を追加する（`/split`・`/chat`・`/stage` は維持）
- `?mode=studio` で直接指定できる。`?mode=stage&transparent=1` の配信は不変
- `stage` モードの `transparent` と `client-role` の挙動は変えない

### 3.1 モードごとの表示

| 要素 | studio | split | chat | stage |
|---|---|---|---|---|
| `#stage`（アバター） | 全面 | 右カラム | 非表示 | 全面 |
| `#caption`（大きな字幕） | 非表示 | 表示 | 非表示 | 表示 |
| `#studioBar`（上部バー） | 表示 | 左ヘッダー | 表示 | 非表示 |
| `#characterInfo`（キャラ情報） | 右上 | 左 | 上部（コンパクト） | 非表示 |
| `#chatOverlay`（チャット） | 左下カード | 左カラム | 全面 | 非表示 |
| `#menuDrawer` / `#menuBackdrop` | 使用可 | 使用可 | 使用可 | 非表示 |
| `#toast` | 表示 | 表示 | 表示 | 既存どおり |

---

## 4. studio のレイアウト

```
┌────────────────────────────────────────────┐
│ ☰   ●待機中   🎤 停止   ▁▂▃       さくら │  ← #studioBar
│                                            │
│              （アバター）                   │
│                                            │
│  ┌──────────────────────┐                  │
│  │ あなた: ...           │                  │  ← #chatOverlay
│  │ さくら: ...           │                  │     （常時表示）
│  │ [テキスト入力....][送信]│                 │
│  └──────────────────────┘                  │
└────────────────────────────────────────────┘
```

- `#app` は `height: 100vh`、`max-width: none`、`padding: 0`、`position: relative`、`overflow: hidden`
- `#stage` は `position: absolute; inset: 0` で全面に置く
- `#studioBar` は上部に浮かせる（半透明のグラデーション背景）
- `#characterInfo` は右上に小さく置く
- `#chatOverlay` は左下のカードとして置く
- 大きな字幕 `#caption` は `studio` では非表示にする
- アバターの表示位置は既存の中央配置を基本とし、上部バーと左下カードが顔を隠さない範囲に調整する
- `split` のアバター位置（中央）を基本にし、`stage` 用の下中央配置は `studio` では使わない

### 4.1 アバター表示

- `AvatarStage` のレンダラー選択（live2d / sprite / none）は変えない
- `renderer === "none"` の場合、`split` / `chat` では従来どおり `#stage` を隠す
- `studio` では `#stage` 自体は残し、背景だけを表示する（キャラ情報とチャットのフォールバック）。
  そのため `StageView.mountAvatar()` の `#stage` 非表示条件は `renderer === "none" && mode !== "studio"` とする
- Live2D / sprite の表示サイズ・位置は既存の CSS を基本とし、`studio` 用の微調整だけを追加する

---

## 5. DOM 構成

既存の ID はすべて維持する。要素の移動だけを行い、`ChatView` / `SettingsPanel` の参照を壊さない。

```html
<div id="app">
  <section id="stage" class="stage hidden">
    <div id="caption" class="caption hidden"></div>
  </section>

  <div id="studioBar" class="studio-bar">
    <button id="btnMenu" type="button" aria-label="メニュー"
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
```

- `#stage` / `#caption` の ID と `StageView` の責務は変えない
- `#conversation` / `#textInput` / `#btnSend` はチャットカード内へ移動する
- `#btnListen` / `#btnStop` / `#status` / `#levelFill` / `#levelHint` は上部バーへ移動する
- `#characterFace` / `#characterLabel` / `#services` はキャラ情報へ移動する
- `#languageSelect` / `#inputDevice` / `#btnMicTest` / `#btnSettings` / `#settingsPanel` /
  `#btnDiagnostics` / `#diagnostics` / `#btnClear` / `#version` はドロワーへ移動する
- `#characterName` はドロワーの見出しに置く（`ChatView.setCharacter()` の設定先を維持）

---

## 6. ハンバーガーメニュー

### 6.1 構成

新規 `src/frontend/MenuDrawer.ts` が開閉・フォーカス・キーボード操作を担当する。

- 対象要素: `#btnMenu`（開く）、`#btnMenuClose`（閉じる）、`#menuDrawer`、`#menuBackdrop`
- 開く: `body` に `menu-open` を付け、ドロワーを左からスライドインする。
  `btnMenu` の `aria-expanded=true`、ドロワーの `aria-hidden=false`。最初のフォーカスは `#btnMenuClose` へ。
- 閉じる: `Esc`、背景クリック、`#btnMenuClose`。`aria-expanded=false`、`aria-hidden=true`、
  フォーカスを `#btnMenu` へ戻す。
- フォーカストラップ: 開いている間は `Tab` / `Shift+Tab` をドロワー内に閉じ込める。
- 背景スクロール: `body.menu-open` で `overflow: hidden`。ドロワー自身は `overflow-y: auto`。
- 閉じている間は `#menuDrawer` / `#menuBackdrop` を `visibility: hidden; pointer-events: none` にする。
- `prefers-reduced-motion: reduce` ではスライドのトランジションを無効化する。
- レイアウトモードが変わったときはドロワーを閉じる（`app.ts` で `stage.apply()` の後に
  `menuDrawer.close()` を呼ぶ）。

### 6.2 内容

ドロワーに移すもの:

- 音声入力: `#inputDevice`、`#btnMicTest`
- モデル設定: `#btnSettings`（セクション見出し）と `#settingsPanel`
- 言語: `#languageSelect`
- 診断: `#btnDiagnostics` と `#diagnostics`
- 履歴: `#btnClear`
- フッター: `#version`、ローカル完結の注記

常時表示のままにするもの:

- `#btnListen` / `#btnStop` / `#status` / `#levelFill` / `#levelHint` / `#btnMenu`

`SettingsPanel` は既存の `btnSettings` / `settingsPanel` をそのまま使う。`btnSettings` を押すと
`settingsPanel` が開き、初回は `GET /api/models` を取得する（既存挙動を維持）。

---

## 7. CSS 設計

### 7.1 モードクラス

`StageView.apply()` で `body` に次のいずれかを付ける。

- `studio-mode`
- `split-mode`
- `chat-mode`
- `stage-mode`

`transparent` は既存どおり別クラスで付ける。`menu-open` は `MenuDrawer` が付ける。

`#stage` / `#caption` の表示制御:

```ts
this.stageEl.classList.toggle("hidden", mode === "chat");
this.captionEl.classList.toggle("hidden", mode === "chat" || mode === "studio");
```

### 7.2 studio

- `body.studio-mode { overflow: hidden; }`
- `body.studio-mode #app { max-width: none; height: 100vh; padding: 0; position: relative; overflow: hidden; }`
- `body.studio-mode #stage { position: absolute; inset: 0; height: 100%; border-radius: 0; }`
- `body.studio-mode #studioBar`:
  `position: absolute; top: 0; left: 0; right: 0; z-index: 4; display: flex; align-items: center; gap: 10px; padding: 12px 16px;`
  背景は半透明のグラデーション + `backdrop-filter: blur()`。
- `body.studio-mode #characterInfo`:
  `position: absolute; top: 64px; right: 24px; z-index: 4; text-align: right;`
  半透明の背景、小さめの顔文字、名前、サービス状態。
- `body.studio-mode #chatOverlay`:
  `position: absolute; left: 24px; bottom: 24px; z-index: 4; width: min(420px, calc(100% - 48px)); max-height: 45vh;`
  `display: flex; flex-direction: column; border-radius: 16px; background: rgba(15, 17, 23, 0.82);`
  `backdrop-filter: blur(10px); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);`
- `body.studio-mode #conversation`:
  `flex: 1 1 auto; min-height: 0; overflow-y: auto;`
- composer はカード内の下端に固定する（`flex: 0 0 auto`）
- `body.studio-mode #caption { display: none; }`
- `#stage` が `hidden` でも `#chatOverlay` / `#characterInfo` / `#studioBar` は表示される
  （チャットカードは `#stage` の外にあるため）

### 7.3 split（互換）

`#app` をグリッドにし、左カラムに `#studioBar` / `#characterInfo` / `#chatOverlay`、
右カラムに `#stage` を置く。

```
grid-template-columns: minmax(420px, 1fr) minmax(0, 1fr);
grid-template-rows: auto auto minmax(0, 1fr);
grid-template-areas:
  "bar stage"
  "info stage"
  "chat stage";
```

- `#studioBar` は左のヘッダー
- `#characterInfo` は左のキャラ情報（従来の `.character` 相当）
- `#chatOverlay` は左のチャット領域（従来の `main` 相当）
- `#stage` は右カラム全体（従来どおり）
- `#caption` は `#stage` 内で従来どおり表示
- `#menuDrawer` / `#menuBackdrop` は固定オーバーレイ

### 7.4 chat（互換）

- `#stage` / `#caption` は非表示
- `#app` は縦フレックス: `#studioBar`（上部）、`#characterInfo`（コンパクト）、`#chatOverlay`（残り全面）
- `#chatOverlay` は `flex: 1 1 auto; min-height: 0;` で全面チャット
- `#menuDrawer` / `#menuBackdrop` は固定オーバーレイ

### 7.5 stage（配信）

- `#studioBar` / `#characterInfo` / `#chatOverlay` / `#menuDrawer` / `#menuBackdrop` を非表示
- `#stage` / `#caption` のみ表示
- 既存の `body.stage-mode` のアバター位置（下中央）と `transparent` を維持

### 7.6 レスポンシブ

- 幅 720px 未満:
  - `#chatOverlay` は `left: 8px; right: 8px; bottom: 8px; width: auto; max-height: 40vh;`
  - `#studioBar` は折り返し可能にし、レベル表示は省略または縮小
  - `#characterInfo` は右上の小さい表示を維持（必要ならサービス状態を省略）
  - `#menuDrawer` は `width: min(360px, 86vw)`
- 幅 480px 未満: キャラ情報のサービス状態を省略し、名前と顔文字だけにする

### 7.7 z-index

| 要素 | z-index |
|---|---|
| `#stage` / アバター | 1 |
| `#caption` | 3 |
| `#studioBar` / `#characterInfo` / `#chatOverlay` | 4 |
| `#menuBackdrop` | 9 |
| `#menuDrawer` | 10 |
| `#toast` | 50 |

---

## 8. チャットオーバーレイ

- `studio` では常時表示。折りたたみボタンは設けない
- 幅は最大 420px、高さは最大 45vh。会話は `#conversation` 内でスクロールする
- composer（`#textInput` / `#btnSend`）はカード内の下端に置く
- `#conversation` の `aria-live="polite"` は維持する
- `studio` では大きな字幕を出さない。アシスタントの発話テキストはチャットカードに表示される
- `split` では従来どおり左カラムのチャットとして表示し、字幕も `#stage` 内に表示する
- `chat` では全面チャットとして表示する
- `stage` では非表示

---

## 9. キャラクター情報

- `studio`: 右上に顔文字（状態バッジ）、名前ラベル、サービス状態を小さく表示する
- `split`: 左カラム上部に従来のキャラクター情報として表示する
- `chat`: 上部にコンパクトに表示する
- `stage`: 非表示
- 顔文字（`#characterFace`）は状態（🎤 / 💭 / 🌸 など）を示すバッジとして残す。
  Live2D がある場合も冗長に見えないよう小さくする
- `#characterName`（Sumika）はドロワーの見出しに置く
- `#characterLabel`（さくら）と `#services` はキャラクター情報に置く
- アバターが無い場合（`renderer === "none"`）は、`studio` では `#stage` の背景だけを残し、
  キャラクター情報とチャットカードを表示する

---

## 10. ファイル変更

| 種別 | パス | 変更内容 |
|---|---|---|
| 新規 | `src/frontend/MenuDrawer.ts` | ドロワーの開閉・フォーカストラップ・Esc・背景クリック |
| 変更 | `src/frontend/index.html` | `#studioBar` / `#characterInfo` / `#chatOverlay` / `#menuDrawer` / `#menuBackdrop` の追加と要素移動 |
| 変更 | `src/frontend/style.css` | `studio-mode` / `chat-mode` / ドロワー / チャットカード / レスポンシブ |
| 変更 | `src/frontend/StageView.ts` | `studio-mode` / `chat-mode` のクラス切替、字幕制御、`#stage` フォールバック |
| 変更 | `src/frontend/app.ts` | `MenuDrawer` の生成と `bind()` |
| 変更 | `src/shared/ui/stageMode.ts` | `studio` の追加、既定を `studio` に変更 |
| 変更 | `start.bat` | 既定 `LAYOUT=studio`、`/studio` の追加、ヒント表示 |
| 変更 | `README.md` / `AGENTS.md` | 既定モード、`?mode=`、ドロワーの説明 |
| 変更 | `tests/stage-mode.test.ts` | 既定 `studio`、`?mode=studio`、不正値フォールバック |
| 変更 | `tests/frontend-script.test.ts` | 必須 ID に `btnMenu` / `btnMenuClose` / `menuDrawer` / `menuBackdrop` を追加。ドロワー開閉のテストを追加 |

`src/frontend/ChatView.ts` / `src/frontend/SettingsPanel.ts` は、既存 ID を維持するため原則変更しない。
`SettingsPanel` の `btnSettings` / `settingsPanel` はドロワー内でそのまま動く。

---

## 11. テストと確認

### 自動テスト

- `tests/stage-mode.test.ts`:
  - 既定が `studio` であること
  - `?mode=studio`、`?mode=split`、`?mode=chat`、`?mode=stage` を読むこと
  - `?transparent=true` の既定が `studio` であること
  - 不正な `mode` が `studio` に落ちること
- `tests/frontend-script.test.ts`:
  - `ELEMENT_IDS` に `btnMenu` / `btnMenuClose` / `menuDrawer` / `menuBackdrop` を追加する
  - `btnMenu` クリックでドロワーが開き、`btnMenuClose` で閉じることを検証する
  - 既存の `btnSettings` / `settingsPanel` テストが通ること
- `npm run verify`（typecheck → test → build）が通ること

### 手動確認

1. `start.bat` で studio が既定で開き、全面キャラクター + 左下チャット + 上部バーになる
2. ハンバーガーでドロワーが開き、言語・マイク・モデル設定・診断・履歴クリアが使える。
   `Esc` / 背景クリックで閉じ、フォーカスが ☰ に戻る
3. 聞き取り開始/停止・状態・レベルが常時表示で操作できる
4. チャットカードが常時表示され、テキスト送信・履歴・ストリーミング表示が動く
5. `?mode=split` が従来の 2 画面として動く（字幕あり）
6. `?mode=chat` がチャットのみで動く
7. `?mode=stage&transparent=1` が配信用のアバター + 字幕のみで動く
8. アバターが無い設定でも studio の背景・キャラ情報・チャットが表示される
9. 幅 720px / 480px 未満でチャットカード・ドロワー・キャラ情報が崩れない

---

## 12. リスクと代替案

### リスク

- DOM の再構成で `split` / `chat` の既存 CSS が壊れる可能性がある。モードごとのグリッドを明示し、
  既存モードの手動確認を必須にする
- `tests/frontend-script.test.ts` の必須 ID 追加を忘れると、`must()` で起動時に失敗する
- チャットカードがアバターの下部を覆う。顔と字幕を避ける配置にするが、完全な非重複は保証しない
- `studio` で大きな字幕を出さないため、配信向けの字幕とは見え方が異なる。`stage` モードで従来どおり
- アバター無しのときに `#stage` を隠す既存挙動を `studio` だけ変えるため、`StageView` の条件を誤ると
  背景が消える。テストで確認する

### 代替案（不採用）

| 代替案 | 不採用理由 |
|---|---|
| 下部分割（アバター上・チャット下） | ユーザーがフローティングオーバーレイを選択 |
| 左サイド全高チャットパネル | ユーザーが左下カードを選択 |
| チャットを折りたたみ | ユーザーが常時表示を選択 |
| 左カラムを細いレールとして残す | ユーザーの「左画面をメニューにまとめる」意図に合わない |
| 新モードを追加せず split を置き換える | 既存の split 利用と配信モードを壊すため |

---

## 13. 受け入れ条件

- [ ] `start.bat` の既定で `studio` が開き、`?mode=studio` でも同じ表示になる
- [ ] 左カラムがなく、チャット以外の UI がハンバーガードロワーに集約されている
- [ ] マイク/停止・状態・マイクレベルが常時表示されている
- [ ] チャットが右のキャラクター画面の左下に常時表示され、テキスト入力・送信ができる
- [ ] キャラクター情報（名前・ラベル・サービス状態）が右のキャラクター画面に表示される
- [ ] ドロワーが `Esc` / 背景クリック / 閉じるボタンで閉じ、フォーカスが ☰ に戻る
- [ ] `split` / `chat` / `stage` が従来どおり動作する（`stage` は字幕あり）
- [ ] アバター無しでも studio の背景・キャラ情報・チャットが表示される
- [ ] 幅 720px / 480px 未満でレイアウトが崩れない
- [ ] `npm run verify` が通る

---

## 14. 最終レビュー追補（2026-11-27）

- `split` は互換用のレガシーレイアウトとして維持する。`?mode=split` は 1100px 以下で縦積み
  （`bar` → `info` → `chat` → `stage`）になり、stage がチャットの下に来る。この挙動は Task 5 で
  一度削除されたが、最終レビューで復元した。
- `split` / `chat` の `#characterInfo` は白カードで表示し、紫の背景上でも文字が読めるようにする
  （`padding: 10px 14px; border-radius: 14px; background: rgba(255, 255, 255, 0.95);`）。
  `studio` の暗いピルはそのまま。
