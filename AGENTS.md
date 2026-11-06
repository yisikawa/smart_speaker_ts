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
| テスト | `npm test`（`node:test` / 91 件 / `--test-timeout=30000`） |
| 型のみ | `npm run typecheck` |
| 起動 | `.\start.bat`（または `npm start` / `scripts\run.bat`） |
| 疎通確認 | 起動中に `npm run smoke`（`SMOKE_BASE` で URL 変更可） |
| マイク診断（サーバー録音） | `npm run check-audio` |
| CUDA 版 whisper.cpp | `powershell -ExecutionPolicy Bypass -File scripts\setup-whisper-cuda.ps1`（`-Restore` で CPU 版へ） |
| sherpa-onnx の日本語モデル | `powershell -ExecutionPolicy Bypass -File scripts\setup-sherpa.ps1`（要 `npm install sherpa-onnx-node`） |

## 3. アーキテクチャ（依存方向は内向き）

```
src/shared/protocol.ts, shared/audio/{pcm,vad}.ts   ← 型と純粋ロジック（ブラウザ・Node 共通）
src/backend/core/ports.ts                           ← AudioIO / STT / LLM / TTS のインターフェース
src/backend/services/*                              ← 具体実装（ffmpeg / whisper.cpp / Ollama / VOICEVOX）
src/backend/conversation/*                          ← 状態機械・履歴・プロンプト
src/backend/server/*                                ← Express + WebSocket
src/frontend/{app,mic}.ts                           ← UI・ブラウザ録音（esbuild でバンドル）
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
12. 設定の既定値は `src/backend/config/schema.ts` が単一の真実源。`settings.default.toml` と同期させる。
13. **VAD のしきい値は「較正」で決まる**
    - 較正（既定 0.5 秒）は**中央値**を使い、`silence_threshold × 1.5` を超える音は「発話・物音」として学習しない
    - 相対しきい値は `silence_threshold_max`（既定 0.06）でクランプする
    - 以前は最大値×3 だったため、話し始めてからマイクが開くとしきい値が 0.14 まで跳ね上がり
      「検出しない／途中で切れる」を起こしていた（回帰テストあり）
14. **`max_record_seconds`（既定 30 秒）を超えると必ず `max_duration` で切れる**。長文の語尾切れはまずここを疑う。
15. **中断判定は「自分の AbortController が aborted か」で行う**
    Node は接続断で `Error: aborted` を投げるため、`/abort/i.test(message)` で判定すると
    Ollama 側の切断まで黙って握りつぶし「回答が返らない（ログも出ない）」になる（回帰テストあり）。

## 5. 環境前提（この PC）

- Windows / Node.js v22 / ffmpeg・ffplay あり（`C:\ffmpeg-8.0.1\bin`）
- Ollama 稼働・**`llama3.2:1b`**（小さいため日本語が崩れることがある。品質重視なら gemma3:4b 等へ）
- VOICEVOX ENGINE 0.26.1・`speaker_id = 2`（四国めたん）
- whisper.cpp は CUDA 版（`whisper.cpp/`、CPU 版は `whisper.cpp/_cpu-backup/`）
- マイク: `マイク配列 (Realtek(R) Audio)`（GTX 1650 Max-Q 4GB）

## 6. コーディング規約

- TypeScript `strict`。新規依存は最小限（現状 esbuild のみ追加）。
- レイヤを跨ぐ依存を作らない（services → server を import しない）。
- コメント・UI 文言・ログは日本語。エラーは `scope` 付きイベントで UI に出す。
- 純粋ロジックは `src/shared` に置き、`node:test` でテストする（I/O と分離）。
- 挙動を変えたら `docs/REDESIGN.md` と README を更新し、テストを追加する。
- 一時スクリプトは `logs/` に置かず、検証後は削除する（`git status` を確認）。

## 7. 現在の状態 / TODO

- 動作確認済み: ブラウザ録音 → STT → LLM → TTS → 再生、連続会話、バージイン、履歴、設定 API
- バージョン表記は `0.2.0`（`package.json`）。次回 0.3.0 へ更新予定。
- 未実装（設定のみ）: `[rag]` / `[recipe_db]` / `[music]` / `[apps.proactive_speech]` / `[apps.home_assistant]` / ウェイクワード
- 改善候補: `whisper-server` 常駐化（毎回のモデルロード削減）、LLM モデルの品質向上、話者/音量の設定 UI
- STT は `stt.engine` で whisper.cpp / sherpa-onnx を切り替え可能（sherpa は CPU 0.2〜0.4 秒/発話・幻聴なし。既定は whisper）

## 8. ブランチ運用

- `main`: 動作確認済みの状態 / `develop`: 作業用（現在ここ）
- 作業後: `npm run build && npm test` → `git add -A` → コミット → `git push`（`develop`）
