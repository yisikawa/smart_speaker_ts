# リファクタリング計画（2026-11）

対象: `smart_speaker_ts`（TypeScript / Node.js + ブラウザ GUI / ローカル完結）
基準コミット: `2218cd1`（main = develop）
作業ブランチ: **`develop`**（`main` は動作確認済みの状態を保つ）

## 進捗

| フェーズ | 状態 | 備考 |
|---|---|---|
| **P0 足場固め** | ✅ 完了 | `pretest` で `dist-test` を掃除 / `npm run verify` 追加 / `tests/helpers/project.ts` に共通化（6 ファイルの重複を解消） |
| P1 重複排除 | ✅ 完了 | `core/errors.ts`（中断/通信エラー）・`services/wav.ts` を Buffer 境界アダプタへ縮小（実装は `shared/audio/pcm.ts` に一本化）・`BaseSttService`（幻聴フィルタ/中断/ログ）・ログ scope の二重表示を解消 |
| P2 パイプライン分割 | ✅ 完了 | `SpeechGate`（破棄判定）/ `TurnRunner`（LLM→TTS）/ `TranscriptionRunner`（STT＋採否）/ `ListeningLoop`（録音）/ `PlaybackLoop`（再生・バージイン）に分割。Pipeline 604 → 395 行。破棄→`turn_skipped` は `TranscriptionRunner` の戻り値 1 経路。ブラウザモードでテキスト送信後にサーバー録音を開く不具合も修正 |
| P3 フロントエンド分割 | ✅ 完了 | `app.ts` 684 → 207 行。`WsClient`（接続・再接続・hello 待ち）/ `ChatView`（描画）/ `MicLoop`（録音ループ・マイク確認・バージイン）/ `dom`（ヘルパ）に分割。esbuild の IIFE バンドルは維持（`tests/frontend-script.test.ts` は無変更で通過） |
| P4 設定整理 | ✅ 完了 | `sanitize` を宣言的テーブル（`CLAMP_RULES`）へ / `npm run config:default` で `settings.default.toml` を schema から同期（コメント保持）/ ドリフト検出テスト / 未実装セクションを `UNSUPPORTED_SECTIONS` と `getUnsupportedSections()` で明示 / 保存前に `settings.toml.bak` を退避 |
| P5 サーバ層整理 | ✅ 完了 | `ServiceMonitor`（疎通の定期確認を 1 箇所へ。`/api/health` と hello が同じ判定を共有）/ `WsHub` のコマンド振り分けを判別共用体の完全マップへ（`CLIENT_COMMANDS` の二重管理を廃止・追加漏れはコンパイルエラー）/ `/api/config` 応答に `warnings` を追加 / `npm run smoke` に config の往復テストを追加 |
| P6 診断・運用 | ⬜ 未着手 | |


---

## 1. 現状の実測

### 1.1 規模

| ファイル | 行数 | 役割 |
|---|---|---|
| `src/frontend/app.ts` | 628 | UI・WS クライアント・マイクループ・録音制御（**責務过多**） |
| `src/backend/conversation/ConversationPipeline.ts` | 604 | 状態機械・STT/LLM/TTS 呼び出し・破棄判定・エコー判定（**責務过多**） |
| `src/backend/services/AudioService.ts` | 397 | ffmpeg 録音・再生・デバイス解決・排他制御 |
| `src/frontend/mic.ts` | 361 | getUserMedia / AudioWorklet / VAD 駆動 |
| `src/backend/config/schema.ts` | 358 | 型 + 既定値（真実源） |
| `src/shared/audio/pcm.ts` | 266 | PCM/WAV/Base64（共有） |
| `src/backend/services/SherpaSttService.ts` | 252 | sherpa-onnx STT |
| `src/backend/services/OllamaLlmService.ts` | 248 | Ollama クライアント |
| `tests/pipeline.test.ts` | 583 | パイプライン回帰テスト |

テスト: **95 件**（`node:test`）/ typecheck・build は CI なし（手元実行のみ）

### 1.2 確認できた問題（今回の障害と直結）

| # | 問題 | 影響 | 実例 |
|---|---|---|---|
| 1 | `services/wav.ts`（Buffer）と `shared/audio/pcm.ts`（Uint8Array）で **`isWav` / `encodeWav` / `rmsLevel` / `applyGain` / `wavDurationMs` が二重実装** | 変換経路の取り違え・仕様ずれ | WAV 判定や長さ計算が 2 箇所に存在 |
| 2 | 中断判定が各所に散在（`controller.signal.aborted` を 3 箇所で個別実装、以前は `/abort/i` 判定） | **無言の失敗（回答なし）** | `Error: aborted` を中断と誤判定して握りつぶす不具合が発生 |
| 3 | パイプラインが「破棄（幻聴・エコー・短断片）」の**クライアント通知**まで持つ | **フロントが待機して固まる** | `turn_skipped` 未通知で `waitForTurn()` が解けない不具合が発生 |
| 4 | `pretest` が `dist-test` を掃除しない | **古いテスト成果物が実行される**（偽の失敗） | main で 82 件中 3 件失敗（実体は develop の残骸） |
| 5 | テスト用の一時プロジェクト生成が **6 ファイルに重複** | テストの一貫性低下・修正コスト | `pipeline/ollama/sherpa/voicevox/config/character` |
| 6 | `ConfigManager` の getter 6 個が**未使用**（`getWakeword`/`getRAG`/`getRecipeDB`/`getMusic`/`getProactiveSpeech`/`getHomeAssistant`） | 「実装済み」に見える誤解 | docs/DESIGN の未実装一覧と乖離 |
| 7 | `settings.default.toml` を **schema.ts と手で同期** | 既定値のずれ（実際に陳腐化した） | `silence_threshold_max` 追加時 |
| 8 | `app.ts` / `ConversationPipeline.ts` が 600 行超で UI とドメインが混在 | 変更時の影響範囲が読めない | 言語ガード・エコー判定の追加で毎回両方に手が入る |

---

## 2. 目標と非目標

### 目標
1. **同じ不具合を二度起こさない構造**にする（中断・破棄・エコー・幻聴の判定を 1 箇所に集約）
2. 変更時に「どこを直せばよいか」が自明な層構成にする（UI / ドメイン / インフラ）
3. テストとビルドを**1 コマンドで再現可能**にする（古い成果物で誤判定しない）
4. 設定の真実源を 1 つに保つ（型・既定値・既定 TOML の自動生成）
5. 振る舞いは**変えない**（純粋なリファクタリング。挙動変更は別コミットで明示）

### 非目標（今回はやらない）
- フレームワーク導入（React/Vue など）、状態管理ライブラリの導入
- パッケージマネージャ・ビルドツールの刷新（esbuild のまま）
- 未実装機能（RAG / レシピDB / 音楽 / プロアクティブ発話 / Home Assistant）の実装
- sherpa-onnx のストリーミング対応、GPU 推論対応
- 多言語対応（UI 文言の i18n 化）

---

## 3. 進め方（ルール）

- 1 フェーズ = `develop` 上のまとまったコミット（必要なら `feature/refactor-*` を切って `--no-ff` で取り込む）
- **テスト先行**: 振る舞いを固定する回帰テストを追加/移動してから構造を変える
- 各フェーズの完了条件（すべて満たす）
  1. `npm run typecheck` エラーなし
  2. `npm test` 全件パス（件数は増減してよいが、**既存テストの削除は理由を明記**）
  3. `npm run build` 成功
  4. 手動スモーク: 起動 → テキスト送信 → 応答 → 音声入力（マイク）→ 停止
  5. `README` / `docs/DESIGN.md` / `AGENTS.md` の更新（挙動・構造・ハマりどころ）
- コミットメッセージは `refactor(<scope>): 何を・なぜ`（日本語）

---

## 4. フェーズ計画

### P0. 足場固め（0.5 日・リスク小）

| 作業 | 対象 | 受け入れ条件 |
|---|---|---|
| `dist-test` のクリーン化 | `package.json`（`pretest` で `dist-test` を削除） | 削除済みテストが実行されない。`npm test` が単独で再現可能 |
| `npm run verify` 追加（typecheck → test → build） | `package.json` / `scripts/` | 1 コマンドで全チェック |
| テスト共通ヘルパ | `tests/helpers/project.ts`（一時プロジェクト・ConfigManager・WAV 生成） | 6 ファイルの重複を解消し、既存テストがそのまま通る |
| テスト件数の自動化（任意） | `scripts/` | AGENTS.md の「95 件」を手で直さなくてよい |

### P1. 重複排除（1〜1.5 日・リスク中）

| 作業 | 内容 | 受け入れ条件 |
|---|---|---|
| WAV/PCM の一本化 | `shared/audio/pcm.ts` を唯一の実装にし、`services/wav.ts` は「Buffer ⇔ Uint8Array の境界変換のみ」に縮小（または削除） | 二重実装が消える。`tests/wav.test.ts` / `shared-pcm.test.ts` を統合しても全件パス |
| エラー分類の集約 | `core/errors.ts` に `isAbortError(signal)` / `describeTransportError()` / `toUserMessage()` を集約 | LLM/STT/TTS/HTTP で個別実装しない |
| STT 実装の共通化 | `BaseSttService`（前処理: 無音スキップ、後処理: 幻聴/短断片フィルタ、ログ、中断）を導入し `Whisper` / `Sherpa` は差分のみ | 行数が減り、フィルタの適用漏れが構造的に起きない |
| ログの統一 | scope 命名統一（`[STT]`/`[LLM]`/`[Pipeline]`）、重要イベントに `reason` を付与 | `logs/app.log` だけで障害を追える |

### P2. パイプラインの分割（1.5〜2 日・リスク中）

```
conversation/ConversationPipeline.ts  … 状態機械と調停（目標 250 行以下）
conversation/TurnRunner.ts            … 1 ターン実行（STT→LLM→TTS→再生）と中断管理
conversation/SpeechGate.ts            … 破棄判定の集約（幻聴/エコー/短断片/重複）
conversation/ConversationHistory.ts   … 既存（履歴）
```

- `SpeechGate` が `ignored` を返したら **必ず `TurnRunner` が `turn_skipped` を emit** する 1 経路にする
- 中断は `AbortScope`（現 `newAbort`）に集約し、`stop()` はその 1 個だけを abort
- 受け入れ条件: `pipeline.test.ts` の全ケース（幻聴・エコー・短断片・重複・停止・バージイン・フォローアップ・失敗通知）が**アサーション変更なし**で通る

### P3. フロントエンドの分割（1.5 日・リスク中）

```
frontend/main.ts      … 起動・DI
frontend/WsClient.ts  … 接続/再接続/hello/コマンド送信
frontend/ChatView.ts  … 描画（履歴・吹き出し・ノート・トースト）
frontend/MicLoop.ts   … 録音ループ（VAD・送信・ターン待ち・バージイン監視）
frontend/app.ts       … 組み立て（目標 150 行以下）
```

- esbuild の IIFE バンドル（`dist/frontend/app.js` 1 ファイル）は維持
- 受け入れ条件: `tests/frontend-script.test.ts`（classic script 構文・ボタン動作・`turn_skipped` での待機解除）が通る＋手動でマイク→応答を確認

### P4. 設定まわりの整理（1 日・リスク低〜中）

| 作業 | 内容 |
|---|---|
| 既定値の単一化 | `schema.ts` から `settings.default.toml` を**生成**するスクリプト（`scripts/gen-default-config.ts`）。手書きコメントは雛形側に保持 |
| 未使用セクションの明示 | 未使用 getter を削除、または `/** 未実装（設定のみ） */` を付け `getUnusedSections()` に集約し README / DESIGN と一致させる |
| sanitize の宣言化 | `clampField(...)` の羅列を `{ key, min, max }[]` のテーブルへ（schema と並べて差分が読める） |
| PATCH の保護 | 既知挙動（コメント喪失）は維持しつつ、`PATCH` 前に `settings.toml.bak` を残す |

### P5. サーバ層の整理（1 日・リスク低）

- `AppServer` から「静的配信の解決」「サービス状態ポーリング」を分離（`ServiceMonitor`）
- `WsHub` のコマンド検証を `ClientCommand` の判別共用体から型駆動にし、`CLIENT_COMMANDS` の二重管理を廃止
- `ApiRouter` の `/api/config`（GET/PATCH）で `sanitize` を共通利用
- 受け入れ条件: `scripts/smoke.js` を拡張（`/api/state`, `/api/config` 往復）して通す

### P6. 診断・運用の強化（0.5〜1 日・リスク低）

- `GET /api/diagnostics`: マスク済み設定＋直近 Capture 統計（frames/peak/reason）＋破棄統計（幻聴/エコー/短断片/重複の回数）
- フロントに「診断」パネル（レベル・しきい値・最後の破棄理由）
- 統計は `SpeechGate` のカウンタを単一の真実源にし、ログと API で同じ数字を出す

---

## 5. 優先順位と根拠

| 優先 | フェーズ | 理由 |
|---|---|---|
| 1 | **P0** | 古い成果物による偽の失敗は**すでに発生済み**（main で 3 件誤検知）。今後も誤診の原因になる |
| 2 | **P1** | 無言失敗（中断誤判定）・WAV 二重実装は**実障害の直接原因**。ここを直さないと再発する |
| 3 | **P2** | 破棄通知漏れ（フリーズ）の再発防止。600 行の混在は今後の変更コストが高い |
| 4 | **P4** | 既定値の手同期は既に破綻している（`settings.default.toml` の陳腐化） |
| 5 | **P3** | 影響は大きいがテストで守れている部分が多いため後回し可 |
| 6 | **P5 / P6** | 品質・運用の底上げ。機能追加の直前に行うと効果が高い |

---

## 6. 工数・リスクの見積り

| フェーズ | 想定 | 主なリスク | 低減策 |
|---|---|---|---|
| P0 | 0.5 日 | テスト実行環境の差異 | 変更は `package.json` / `scripts` に限定 |
| P1 | 1〜1.5 日 | WAV 変換の回帰（マイク入力・TTS 出力） | PCM の単体テスト＋実音声スモーク（VOICEVOX → STT） |
| P2 | 1.5〜2 日 | 状態機械の挙動変化 | `pipeline.test.ts` を仕様書として維持（アサーション変更禁止） |
| P3 | 1.5 日 | ブラウザ実行時エラー | `frontend-script.test.ts` ＋手動マイク確認 |
| P4 | 1 日 | 生成物と手書きコメントの衝突 | 生成はコメント雛形とマージする方式 |
| P5 | 1 日 | API 挙動の微差 | `scripts/smoke.js` を先に拡張 |
| P6 | 0.5〜1 日 | 追加 I/O による負荷 | 統計はメモリ内カウンタのみ（永続化しない） |

合計: **7.5〜9 人日**。P0 → P1 → P2 を先行し、以降は機能開発と並行。

---

## 7. 完了の定義（全体）

- `src/` の最大ファイルが **400 行以下**（`app.ts` / `ConversationPipeline.ts` が対象）
- WAV/PCM の実装が **1 箇所**、中断判定が **1 箇所**、破棄判定が **1 箇所**、破棄通知が **1 経路**
- `settings.default.toml` が **schema.ts から生成**されている（手同期の差分が出ない）
- 未使用の設定 getter / セクションが「未実装」と明示されている
- `npm run verify` が 1 コマンドで typecheck / test / build を実行
- README / `docs/DESIGN.md` / `AGENTS.md` / 本書が現状と一致

---

## 8. 付録: 変更対象ファイル（初期スナップショット）

```
src/frontend/app.ts                              628
src/backend/conversation/ConversationPipeline.ts  604
src/backend/services/AudioService.ts              397
src/frontend/mic.ts                               361
src/backend/config/schema.ts                      358
src/shared/audio/pcm.ts                           266
src/backend/services/SherpaSttService.ts          252
src/backend/services/OllamaLlmService.ts          248
src/backend/server/WsHub.ts                       230
src/shared/audio/vad.ts                           204
src/backend/config/ConfigManager.ts               165
src/backend/services/transcriptFilter.ts          165
src/backend/server/AppServer.ts                   161
src/backend/services/WhisperSttService.ts         145
src/backend/services/wav.ts                        87   ← P1 で統合対象
src/shared/protocol.ts                            129
```


