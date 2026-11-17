# AGENTS.md — プロジェクトメモリー（作業引き継ぎ用）

このリポジトリで作業する AI エージェント／開発者向けの「記憶」。作業前に必ず読むこと。
仕様の詳細は `docs/DESIGN.md`（As-Is）と `docs/REDESIGN.md`（To-Be）を参照。

---

## 1. これは何か

ローカル完結型の AI 音声アシスタント（TypeScript。バックエンド Node.js + ブラウザ GUI）。

- STT: whisper.cpp（CUDA 版に差し替え済み）または sherpa-onnx（`stt.engine` で切替） / LLM: Ollama / TTS: VOICEVOX
- 音声入力: **既定はブラウザのマイク**（`getUserMedia`）。`audio.input_mode = "server"` で ffmpeg 録音に切替
- すべて localhost 完結。音声・テキストは外部送信しない

## 2. よく使うコマンド

| 目的 | コマンド |
|---|---|
| ビルド | `npm run build`（clean → backend tsc → frontend 型チェック → 静的コピー + esbuild バンドル） |
| テスト | `npm test`（`node:test` / 119 件 / `--test-timeout=30000`） |
| 型のみ | `npm run typecheck` |
| まとめて検証 | `npm run verify`（typecheck → test → build。**作業後はこれ 1 本**） |
| テスト成果物の掃除 | `npm run clean:tests`（`dist-test` を削除。`pretest` から自動実行） |
| 既定設定の同期 | `npm run config:default`（`schema.ts` の既定値を `settings.default.toml` へ反映。コメントは保持） |
| 起動 | `.\start.bat`（または `npm start` / `scripts\run.bat`） |
| 疎通確認 | 起動中に `npm run smoke`（`SMOKE_BASE` で URL 変更可） |
| マイク診断（サーバー録音） | `npm run check-audio` |
| CUDA 版 whisper.cpp | `powershell -ExecutionPolicy Bypass -File scripts\setup-whisper-cuda.ps1`（`-Restore` で CPU 版へ） |
| Live2D の Cubism Core | `powershell -ExecutionPolicy Bypass -File scripts\setup-live2d.ps1`（`-Force` で更新） |
| sherpa-onnx の日本語モデル | `powershell -ExecutionPolicy Bypass -File scripts\setup-sherpa.ps1`（要 `npm install sherpa-onnx-node`） |

## 3. アーキテクチャ（依存方向は内向き）

```
src/shared/protocol.ts, shared/audio/{pcm,vad}.ts   ← 型と純粋ロジック（ブラウザ・Node 共通）
src/backend/core/ports.ts                           ← AudioIO / STT / LLM / TTS のインターフェース
src/backend/services/*                              ← 具体実装（ffmpeg / whisper.cpp / Ollama / VOICEVOX）
  ├─ SttSwitcher.ts / modelCatalog.ts               ← STT の実行時切替・モデル候補の列挙と検証
src/backend/conversation/*                          ← 状態機械・履歴・プロンプト
src/backend/server/*                                ← Express + WebSocket
src/frontend/{app,mic}.ts                           ← UI・ブラウザ録音（esbuild でバンドル）
src/frontend/app.ts                                 ← 組み立て（Composition Root）
src/frontend/{WsClient,ChatView,MicLoop,SettingsPanel,dom}.ts ← 通信・描画・録音ループ・設定メニュー・DOM ヘルパ
src/backend/index.ts                                ← Composition Root（DI 配線）
```

- パイプラインは `core/ports.ts` のインターフェースにのみ依存。実装は `index.ts` で注入する。
- フロントは **esbuild の IIFE バンドル**（`dist/frontend/app.js`）。`tsc` の出力はブラウザで動かない。

## 4. ハマりどころ（重要・再発防止）

1. **フロントのビルドは必ず esbuild**
   `tsc` を CommonJS で出すと `exports`、ES2020 で出すと `export {}` が付き、
   `index.html` の classic script では `SyntaxError` で**全 JS が停止**する（症状: 画面が無反応）。
2. **AudioWorklet は 128 サンプル単位で届く**
   VAD のフレームは 16kHz × 20ms = 320 サンプル。端数を捨てると `frames=0` になる。
   → `splitInt16Frames()` で持ち越す（回帰テストあり）。
3. **AudioContext の自動再生ポリシー**
   初回のマイク許可ダイアログ待ちで `suspended` に戻る。クリック中に生成 + `resume()`、
   だめなら次の `pointerdown` で再開。`diagnostics()` を必ずトーストに出す。
4. **localhost は https 不要**（secure context）。LAN の IP で開くとマイク不可。
5. **whisper.cpp の `-ng` は「GPU 無効」**。`use_gpu=false` のときだけ付与。
6. **1.9 系で `main.exe` は廃止**（`whisper-cli.exe`）。互換のためスクリプトが `main.exe` も配置。
7. **VRAM 4GB では f16（1.6GB）が厳しい** → `ggml-large-v3-turbo-q5_0.bin`（547MB）を使用中。
8. **server（ffmpeg）モードはマイクを直列化**（`device_settle_ms=250` + 孤児プロセス防止）。
   バージイン監視とフォローアップが同時にマイクを開かないようにしている。
9. **`PATCH /api/config` は `settings.toml` を正規化**して保存する（コメントは失われる）。
10. **フォローアップ上限で勝手に止めない**（`conversation.keep_listening = true`）。
11. テストは**ハング防止**のため `--test-timeout` 必須。無限ループしうる設定（keep_listening）に注意。
12. 設定の既定値は `src/backend/config/schema.ts` が単一の真実源。`settings.default.toml` は
    `npm run config:default` で同期する（コメントは保持される）。同期漏れは
    `tests/config-defaults.test.ts` が検出する（実際に `silence_threshold_max` 追加時に陳腐化した）。
12-0. 未実装（設定のみ）のセクションは `UNSUPPORTED_SECTIONS` / `getUnsupportedSections()` が真実源。
    追加したら README / docs/DESIGN.md の「未実装」一覧も更新する。
12-1. **音声ユーティリティの実装は `src/shared/audio/pcm.ts` だけ**。`src/backend/services/wav.ts` は
    Buffer ⇔ Uint8Array の境界変換のみ（新しい処理は pcm.ts に追加してブラウザと共有する）。
12-2. **STT 実装は `BaseSttService` を継承する**（幻聴フィルタ・中断判定・`認識完了` ログを共通化）。
    具象クラスは `recognize()` と `isAvailable()` だけを実装する。
12-4. **会話まわりは役割ごとに分かれている**（`src/backend/conversation/`）
    - `ConversationPipeline` … 状態機械・調停（録音/破棄/フォローアップの方針）
    - `TurnRunner` … LLM → TTS（言語ガードの再生成を含む）
    - `TranscriptionRunner` … STT 呼び出し＋`SpeechGate` の採否＋イベント通知
    - `SpeechGate` … 幻聴・短断片・エコー・繰り返しの判定（**破棄は必ず `ignored` を返し、呼び出し側が `turn_skipped` を出す**）
    - `ListeningLoop` / `PlaybackLoop` … 録音と再生（バージイン）
    - ブラウザ入力モードでは**録音はクライアントが駆動**する。サーバー側で ffmpeg を開くとマイクを奪うため、
      `runLoop` は応答後にループを終える。
12-3. **Logger は `deps.logger ?? new Logger("Scope")`**。`child()` を使うと `[STT:STT]` のように二重表示になる。
12-5. **WebSocket のコマンドは `WsHub.commandHandlers` の完全マップで受ける**
    `ClientCommand` に追加したらマップにも実装する（未実装はコンパイルエラー）。`CLIENT_COMMANDS` のような Set を併設しない。
12-6. **サービスの疎通確認は `ServiceMonitor` に集約**（`/api/health` は `refresh()`、hello は `current`）。
12-7. **破棄の統計は `SpeechGate` のカウンタが真実源**。`/api/diagnostics` はそれを返すだけにし、
    ログと API で数字がずれないようにする。
12-8. **STT は `SttSwitcher` 経由で配線する**（`createSttService()` を直接 DI しない）。
    - `src/backend/services/SttSwitcher.ts` が「エンジンと関連設定の署名」を見て実装を作り直す
    - 反映は `ConfigManager.onChange` に集約（画面の `PUT /api/models/*`・`PATCH /api/config`・`reload` の共通経路）
    - **sherpa は recognizer をキャッシュする**ため、モデル変更時に再生成しないと設定が効かない（回帰テスト: `tests/stt-switcher.test.ts`）
    - 切替は次の発話から。`transcribe()` は呼び出し開始時の実装を捕捉するので進行中の認識は壊れない
    - モデル候補の列挙・検証は `src/backend/services/modelCatalog.ts`（純粋ロジック。`tests/model-catalog.test.ts`）
12-9. **画面のモデル一覧は `GET /api/models` だけを真実源にする**。`models/` のスキャン結果と
    `llm.listModels()`（Ollama）を合成して返し、Ollama 停止中でも 200 + `llm.available=false` とする
    （500 にすると画面が壊れる）。
12-10. **読み上げの出力先は `PlaybackSink`**（`core/ports.ts`）。`PlaybackRouter` が
    `audio.playback_target` と接続状況で server（ffplay）/ browser（WebAudio）を選ぶ。
    `tts_audio` は primary（`role=display`）のみへ送り、クライアントの `audio_playback_done` を待つ
    （来なくても `durationMs + 1500ms` で必ず解く）。`hello.avatar` は `buildAvatarPayload()` が組み立てる。

12-11. **読み上げは文単位（`SentenceSplitter` + `SpeechQueue`）**。`tts.split_sentences=false` で
    従来動作（全文 1 回）。`speaking_started` / `speaking_finished` は**ターン単位で 1 回**だけ出し、
    文ごとの再生は `announce: false` で `PlaybackLoop` のイベントを抑止する。
    言語ガードで読み直すときは `speech_reset` を出し、`hooks.stopPlayback()` で再生だけ止める。

12-12. **アバター描画は `AvatarRenderer` 抽象**（`frontend/avatar/`）。`AvatarStage` が
    `live2d` → `sprite` → `none` の順に選ぶ。Live2D は `Live2DRenderer` が pixi + `pixi-live2d-display`
    を **別バンドル `live2d.js`** として遅延ロードし、`vendor/live2d/live2dcubismcore.min.js`
    （`/live2d-core/` で配信・gitignore）が無い/失敗したら sprite へフォールバックする。
    モデルは `Live2DModels/` と `live2d-models/` の両方を見る（`AVATAR_MODEL_DIRS`）。
    口パクは `mouthLevelAt()`（`shared/avatar/lipSync.ts`）に再生位置と `volumes` を渡す。
    `StageView` は既定を **split（左: チャット / 右: アバター）** にし、`?mode=chat`（チャットのみ）と
    `?mode=stage&transparent=1`（配信画面）で切り替える。字幕は `#stage` の中に置き、split / stage で表示する。

12-13. **感情タグは TTS の前に必ず除去する**（`shared/avatar/emotion.ts` の `extractEmotion`）。
    タグ→表情名の対応は `avatar.expressions`（空文字は「変えない」）。タグが無ければ
    `emotion_heuristic_enabled` のときだけ語彙推定する。表情は `tts_audio.expression` で画面へ渡す。

13. **VAD のしきい値は「較正」で決まる**
    - 較正（既定 0.5 秒）は**中央値**を使い、`silence_threshold × 1.5` を超える音は「発話・物音」として学習しない
    - 相対しきい値は `silence_threshold_max`（既定 0.06）でクランプする
    - 以前は最大値×3 だったため、話し始めてからマイクが開くとしきい値が 0.14 まで跳ね上がり
      「検出しない／途中で切れる」を起こしていた（回帰テストあり）
14. **`max_record_seconds`（既定 30 秒）を超えると必ず `max_duration` で切れる**。長文の語尾切れはまずここを疑う。
15. **中断判定は「自分の AbortController が aborted か」で行う**
    Node は接続断で `Error: aborted` を投げるため、`/abort/i.test(message)` で判定すると
    Ollama 側の切断まで黙って握りつぶし「回答が返らない（ログも出ない）」になる（回帰テストあり）。
16. **エコーは必ず起きる前提で設計する**
    TTS は ffplay（ブラウザ外）で再生するため、ブラウザの `echoCancellation` では自分の声を消せない。
    - バージインは既定で無効（`conversation.barge_in_enabled = false`）。有効化はヘッドホン前提
    - 直近 3 件の応答と一致する断片（バイグラム一致率 0.6 以上を含む）と 2 文字以下の断片は破棄する
    - **破棄したら必ず `turn_skipped` を通知する**。通知しないとブラウザの `waitForTurn()` が解けず、
      画面が「待機中」のまま固まる（回帰テストあり）
17. **Ollama のモデル切替は「読み込み」に数十秒かかる（ここで詰まると永久に失敗する）**
    - 切替直後の初回リクエストはモデルの読み込みを含む。実測 27 秒、混雑時は 60 秒超
    - クライアント（このアプリ）が 60 秒で打ち切ると **Ollama は `client connection closed before
      llama-server finished loading, aborting load` で読み込みごと中止**し、以降も同じことが繰り返される
    - 対策: (1) `llm.model_load_timeout_seconds`（既定 180）まで**最初のチャンクを待つ**（2 段階タイムアウト）、
      (2) 切り替え時に `OllamaLlmService.prepare()`（`/api/generate` 空プロンプト + `keep_alive`）で事前読み込み
    - 判定は「最初のチャンクを受信したか」（`waitingForFirstChunk`）で行う。診断は
      `%LOCALAPPDATA%\Ollama\server.log` と `ollama ps`（`size_vram`）を見る

18. **`tts_audio` は primary client（`role=display`）にだけ送る**。全配信すると複数タブで二重再生する。
    クライアントの `audio_playback_done` が来なくても **`durationMs + 1500ms` で必ず resolve** する
    （解かないと `speaking` のまま固まる）。
19. **Live2D の Core とモデルはリポジトリに入れない**（`vendor/`・`live2d-models/`・`Live2DModels/` は gitignore）。
    CI はモデル無しで通る前提（`renderer: "sprite"` または `none`、`npm run verify` は vendor 無しでも緑）。

## 5. 環境前提（この PC）

- Windows / Node.js v24.11 / ffmpeg・ffplay あり（`C:\ffmpeg\bin`・PATH 済み）
- Ollama 稼働・**`gemma4:e2b-it-qat`**（導入済み: `llama3.2:3b` / `qwen2.5:7b` / `qwen2.5:14b` / `llama3.1:8b` / `nomic-embed-text`）
- VOICEVOX ENGINE 0.26.1・`speaker_id = 2`（四国めたん）
- whisper.cpp は CUDA 版（`whisper.cpp/`、CPU 版は `whisper.cpp/_cpu-backup/`）。既定 STT は sherpa-onnx（CPU）
- **GPU は RTX 3060 12GB**（CPU は i7-6700 / RAM 40GB）。`Win32_VideoController.AdapterRAM` は 32bit 丸めで 4GB と出るが誤り
- OBS 30 系（`C:\Program Files\obs-studio\bin\64bit\obs64.exe`）/ Edge 157
- マイク: `マイク配列 (Realtek(R) Audio)`

## 6. コーディング規約

- TypeScript `strict`。新規依存は最小限（現状 esbuild のみ追加）。
- レイヤを跨ぐ依存を作らない（services → server を import しない）。
- コメント・UI 文言・ログは日本語。エラーは `scope` 付きイベントで UI に出す。
- 純粋ロジックは `src/shared` に置き、`node:test` でテストする（I/O と分離）。
- 挙動を変えたら `docs/REDESIGN.md` と README を更新し、テストを追加する。
- 一時スクリプトは `logs/` に置かず、検証後は削除する（`git status` を確認）。

## 7. 現在の状態 / TODO

- 動作確認済み: ブラウザ録音 → STT → LLM → TTS → 再生、連続会話、バージイン（既定 OFF）、履歴、設定 API、診断
- **Live2D アバター（P4）**: `Live2DModels/hiyori_vts/hiyori.model3.json` を表示。Cubism Core は
  `scripts\setup-live2d.ps1` で `vendor/live2d/` へ取得（gitignore）。モデル/Core が無ければ sprite へ落ちる
- バージョン表記は `0.3.0`（`package.json`）。リファクタリング（P0〜P6）完了に伴い 0.2.0 から更新。
- 未実装（設定のみ）: `[rag]` / `[recipe_db]` / `[music]` / `[apps.proactive_speech]` / `[apps.home_assistant]` / ウェイクワード
  （真実源は `ConfigManager.UNSUPPORTED_SECTIONS`）
- STT は `stt.engine` で whisper.cpp / sherpa-onnx を切り替え可能（sherpa は CPU 0.2〜0.4 秒/発話・幻聴なし。既定は whisper）
- **画面の「⚙️ 設定」から LLM モデルと STT のエンジン／モデルを切り替えられる**（`GET /api/models`・
  `PUT /api/models/llm`・`PUT /api/models/stt`。設定は即保存、次の発話から有効）
- **残作業のバックログは `docs/TODO.md` に集約**（優先度・受け入れ条件・見積つき）。作業を終えたら同ファイルから削除し、
  この節と README を更新する。

## 8. ブランチ運用

- `main`: 動作確認済みの状態 / `develop`: 作業用（現在ここ）
- 作業後: `npm run build && npm test` → `git add -A` → コミット → `git push`（`develop`）
