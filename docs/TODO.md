# 残作業（TODO / バックログ）

最終更新: 2026-11-06（v0.3.0 / リファクタリング P0〜P6 完了時点）

このファイルは「**まだ終わっていない作業**」の一覧です。完了した項目は削除し、
`AGENTS.md` の「現在の状態」と README を更新してください（履歴は Git のコミットに残します）。

- 仕様: `docs/DESIGN.md`（As-Is）/ `docs/REDESIGN.md`（To-Be）
- 完了したリファクタリング: `docs/REFACTORING_PLAN.md`
- 進め方のルール: `AGENTS.md`（作業は `develop`、完了条件は `npm run verify` ほか）

---

## 1. 優先度つきバックログ

優先度は **P1（次にやる）/ P2（余裕があれば）/ P3（将来）**。
「受け入れ条件」を満たしたら完了とし、テストを追加して本ファイルから削除する。

### P1: 次にやる

| # | 項目 | 現状 / 理由 | 受け入れ条件 | 見積 |
|---|---|---|---|---|
| 1-1 | **設定 UI（音声まわり）** | しきい値・ゲイン・無音時間・話者などは `config/settings.toml` を直接編集するしかない。`PATCH /api/config` はあるが画面から触れない | 画面から `audio.silence_threshold` / `silence_threshold_max` / `input_gain` / `output_volume` / `tts.speaker_id` / `llm.temperature` を変更でき、`warnings` を表示する。保存後に `POST /api/config/reload` を呼び、応答が壊れないこと | 1.5 日 |
| 1-2 | **VAD 設定の二重管理の解消** | ブラウザ VAD は hello で受け取った値、サーバー VAD は `AudioService` が設定を直接読む。同じ計算式が 2 経路 | ブラウザ・サーバー双方が同じ `VadSettings` 生成関数（`shared`）を使う。テストで一致を担保 | 0.5 日 |
| 1-3 | **エコー対策の本命（WebAudio 再生）** | TTS は ffplay（ブラウザ外）で再生するため `echoCancellation` が効かない。現状は「エコー/短断片を破棄」「バージイン既定 OFF」で回避 | (a) ブラウザで音声を再生して AEC を効かせるモードを追加、または (b) 再生音を参照信号にした簡易エコー除去。**バージインを既定 ON に戻せる**ことが目標 | 2〜3 日 |
| 1-4 | **CI（`npm run verify` の自動実行）** | 手元実行のみ。壊れた状態が main に入り得る | GitHub Actions で push/PR 時に `npm ci && npm run verify` が走る。Windows ランナーか ubuntu（ネイティブ依存なしで通ること）を確認 | 0.5 日 |
| 1-5 | **リリース手順の自動化** | バージョン更新は `package.json` / `package-lock.json` / ドキュメントを手で直している | `npm version` 相当のスクリプト（または手順書）で 4 箇所が一括更新される。`tests` でバージョン整合を検証 | 0.5 日 |

### P2: 余裕があれば

| # | 項目 | 現状 / 理由 | 受け入れ条件 | 見積 |
|---|---|---|---|---|
| 2-1 | **sherpa-onnx の追加検証** | `nemo_ctc`（Parakeet 0.6B JA）のみ実機確認済み。`sense_voice` / `nemo_transducer` / `zipformer_transducer` は未検証 | 各モデルでの手順と実測（速度・幻聴・精度）を `docs/ASR_OPTIONS.md` に追記。可能なら `npm run check-stt`（新設）で 1 発話を流して比較できる | 1 日 |
| 2-2 | **既定 STT エンジンの決定** | 既定は `whisper`（互換性重視）。実測では sherpa が速く幻聴も無い | 既定をどちらにするか決め、README / `settings.default.toml` / `AGENTS.md` を更新（移行手順も記載） | 0.5 日 |
| 2-3 | **sherpa の中断対応** | `decode()` は同期で 200〜400ms ブロックし、`stop()` が効かない | `decodeAsync` かワーカースレッドで中断可能にする（または「中断不可」を明記して UI で許容） | 1 日 |
| 2-4 | **会話履歴の永続化** | プロセス再起動で履歴が消える（`data/` は未使用） | `data/history.json` へ保存し、起動時に復元。`/api/history` の挙動は不変 | 0.5 日 |
| 2-5 | **ログのローテーション** | `logs/app.log` は追記のみで肥大化する | 起動時または日次でローテーション（`logs/app-YYYYMMDD.log` など）。サイズ上限を設定可能に | 0.5 日 |
| 2-6 | **whisper-server 常駐化** | whisper.cpp を毎回起動するためモデルロードが発生（初回 3〜7 秒） | `whisper-server` を常駐させ、`WhisperSttService` から HTTP で叩くモードを追加（`stt.engine = "whisper-server"`） | 1.5 日 |
| 2-7 | **`mic.ts`（398 行）の分割** | P3 でフロントを分割したが `BrowserMic` は未分割（デバイス管理・AudioWorklet・VAD 駆動・診断が同居） | 取得（`MicSource`）と VAD 駆動（`listen` / `stop`）に分割。`listen` の戻り値（`ListenResult`）は不変に保つ | 1 日 |
| 2-8 | **バージイン監視の見直し** | クライアントが再生中にもう 1 本 `mic.listen` を開く（`bargeMonitorActive` で排他）。エコー環境では誤検知しやすい | バージイン判定に「直前の応答との類似」「最小継続時間」を入れ、誤検知を回帰テストで固定 | 1 日 |

### P3: 将来（未実装セクションの実装）

設定だけがあり実装が無いセクション（`ConfigManager.UNSUPPORTED_SECTIONS` が真実源）。

| # | 項目 | 内容 | 見積 |
|---|---|---|---|
| 3-1 | `[wakeword]` | ウェイクワード検出（`openWakeWord` / `sherpa-onnx KWS` など）。現状は `simulate_wakeword` コマンドで UI から手動起動できるだけ | 2〜3 日 |
| 3-2 | `[rag]` | ローカル文書の検索拡張（`nomic-embed-text` + ベクトル検索。Ollama に導入済み） | 2 日 |
| 3-3 | `[recipe_db]` | レシピDB（SQLite + マスタ） | 2 日 |
| 3-4 | `[music]` | 音楽再生（Spotify / ローカル。`duck_on_wakeword` 等の設定あり） | 2 日 |
| 3-5 | `[apps.proactive_speech]` | 定時・イベントでの自発発話（`triggers` の設定あり） | 1.5 日 |
| 3-6 | `[apps.home_assistant]` | Home Assistant 連携（`base_url` / `token`） | 1 日 |

---

## 2. 小粒だけど効く改善（まとめてやりやすい）

| # | 内容 | メモ |
|---|---|---|
| S-1 | whisper.cpp の追加フラグ検討 | `-et`（entropy）/ `-lpt`（logprob）/ `--suppress-regex` / `-nf` は未使用。`stt.*` に追加すると幻聴対策が厚くなる |
| S-2 | `stt.min_input_rms`（既定 0.002）の再調整 | 環境（マイク・AGC）依存。診断パネルで `capture.peak` を見ながら調整する手順を README に追記 |
| S-3 | 較正時間の見直し | `audio.calibration_duration` は 0.5 秒固定。無音時に暗騒音を更新し続ける（min-statistics）案は未実装 |
| S-4 | トーストの重複抑制 | エラーが連続すると同じ文言が上書きされるだけ。直近 N 秒の同一メッセージは抑制する |
| S-5 | `/api/diagnostics` の履歴化 | 現在は直近値のみ。直近 10 件の破棄理由をリングバッファで保持すると切り分けが速い |
| S-6 | README のトラブルシュート拡充 | 「診断パネルの読み方」を 1 節追加（破棄の内訳ごとの対処） |
| S-7 | アクセシビリティ | 主要ボタンへの `aria-label`、フォーカスリング、キーボードのみでの操作確認 |

---

## 3. 既知の制約（設計上の割り切り・環境依存）

| 制約 | 理由 / 対処 |
|---|---|
| ブラウザのマイクは `localhost` / `127.0.0.1` のみ | secure context の仕様。LAN の IP で開くと `getUserMedia` が拒否される（https が必要） |
| TTS の再生は ffplay / SoundPlayer（ブラウザ外） | ブラウザの AEC が効かない → エコーは必ず起きる前提。バージインは既定 OFF、断片は破棄で対処（1-3 で本質対応） |
| `PATCH /api/config` はコメントを失う | `stringifyToml` で正規化するため。上書き前に `settings.toml.bak` を退避。コメント維持が必要なら `npm run config:default` の方式を拡張する |
| `stt.engine` の変更は実行中に反映されない | `createSttService()` は起動時に 1 回だけ生成。切替は再起動が必要（README に明記） |
| sherpa-onnx の `decode()` は中断できない | 同期処理（200〜400ms）。`stop()` は「完了後に破棄」で対応（2-3 で改善予定） |
| VOICEVOX / Ollama / モデルの有無は環境依存 | `npm run smoke` と `/api/health` の `services` / `warnings` で確認する |
| 認証なし | localhost 前提。外部公開する場合はリバースプロキシ等で保護すること |

---

## 4. 参考: 現在の実装状況（2026-11-06 時点）

| 機能 | 状態 |
|---|---|
| ブラウザ録音 → VAD → STT → LLM → TTS → 再生 | ✅ 動作確認済み |
| テキスト入力 / 連続会話（フォローアップ）/ 停止 | ✅ |
| 幻聴・エコー・短断片・繰り返しの破棄（＋`turn_skipped` 通知） | ✅ |
| 応答言語ガード（ハングル混入時に 1 回だけ再生成） | ✅ |
| STT エンジン切替（whisper.cpp / sherpa-onnx） | ✅（既定は whisper） |
| 診断（`/api/diagnostics`・画面の「診断」パネル） | ✅ |
| 設定 API（GET/PATCH/reload・`warnings`） | ✅（UI は無し: 1-1） |
| バージイン | ⚠️ 既定 OFF（エコー対策待ち: 1-3） |
| 未実装セクション（wakeword / rag / recipe_db / music / apps.*） | ❌ 設定のみ（P3） |
