# Sumika TypeScript

ローカル完結型 AI 音声アシスタント（バックエンド・フロントエンドともに TypeScript）。

- 音声認識: whisper.cpp
- 応答生成: Ollama
- 音声合成: VOICEVOX
- 音声・テキストは**外部クラウドへ送信しません**（すべて localhost で完結）

設計書:

- [docs/DESIGN.md](docs/DESIGN.md) — 再設計前の現状設計書（As-Is）
- [docs/REDESIGN.md](docs/REDESIGN.md) — 再設計書（To-Be / アーキテクチャ・プロトコル・VAD・移行手順）
- [docs/REFACTORING_PLAN.md](docs/REFACTORING_PLAN.md) — リファクタリング計画（フェーズ・優先度・完了条件）
- [docs/TODO.md](docs/TODO.md) — 残作業（優先度つきバックログ・既知の制約・実装状況）
- [AGENTS.md](AGENTS.md) — 作業メモリー（コマンド・規約・ハマりどころ・現状の TODO）

## 必要なもの

| 項目 | 説明 |
|------|------|
| Node.js | v18 以上（開発は v22 で確認） |
| Ollama | LLM 推論サーバー（既定 `http://127.0.0.1:11434`） |
| VOICEVOX ENGINE | 音声合成サーバー（既定 `http://127.0.0.1:50021`） |
| whisper.cpp + ggml モデル | `whisper.cpp/main.exe`（CUDA 版推奨）と `models/ggml-large-v3-turbo*.bin` |
| ffmpeg / ffplay | `audio.input_mode = "server"` のときの録音・再生（既定はブラウザ入力なので ffmpeg 不要） |
| マイク | ブラウザから利用（`getUserMedia`。localhost または https で開くこと） |
| NVIDIA GPU（任意） | CUDA 版 whisper.cpp を使う場合のみ（VRAM 4GB 以上推奨） |

## セットアップ

```powershell
npm install
npm run build          # clean → tsc → フロントエンド静的ファイルのコピー
```

Windows では `scripts\setup.bat` でも可。

Ollama のモデルを取得しておきます（設定の `llm.model` と一致させる）:

```powershell
ollama pull <model-name>
```

### whisper.cpp を CUDA 版にする（NVIDIA GPU がある場合・推奨）

```powershell
# CUDA 版（cuBLAS 同梱ビルド）を取得して差し替え。既存の CPU 版は whisper.cpp\_cpu-backup に退避されます
powershell -ExecutionPolicy Bypass -File scripts\setup-whisper-cuda.ps1

# 元の CPU 版へ戻す
powershell -ExecutionPolicy Bypass -File scripts\setup-whisper-cuda.ps1 -Restore
```

- 取得元: `whisper.cpp` の GitHub Releases（b5130 / `whisper-cublas-12.4.0-bin-x64.zip`）。CUDA ランタイム DLL も同梱されるため、CUDA Toolkit は不要（NVIDIA ドライバのみ必要）。
- 1.9 系では `main.exe` が廃止され `whisper-cli.exe` に統合されています。スクリプトは既存の設定（`stt.binary_path = whisper.cpp/main.exe`）を壊さないよう、`whisper-cli.exe` を `main.exe` としても配置します。
- 動作確認:

  ```powershell
  .\whisper.cpp\main.exe --version        # ggml_cuda_init: found 1 CUDA devices ... と表示されれば OK
  # 認識の動作確認（任意の WAV を 16kHz 相当で渡す）
  .\whisper.cpp\main.exe -m models\ggml-large-v3-turbo-q5_0.bin -f <WAVファイル> -l ja -otxt -of logs\gpu-test -fa
  ```

#### 速度の実測値（GTX 1650 Max-Q 4GB / large-v3-turbo / 3 秒の音声）

| 構成 | 1 発話あたり | 備考 |
|------|--------------|------|
| CPU 版 + f16 | 約 25 秒 | 差し替え前 |
| CUDA 版 + f16 | 約 8.4 秒 | VRAM 約 1.6GB |
| CUDA 版 + q5_0 | **約 3.5 秒** | VRAM 約 0.55GB・認識結果は f16 と同一 |

- 初回の 1 回だけ CUDA カーネルの JIT で 10〜20 秒余分にかかります（2 回目以降はキャッシュされ高速になります）。
- VRAM が 4GB クラスの場合、f16（1.6GB）は他のアプリと競合しやすいため **q5_0 を推奨**します。

  ```powershell
  .\whisper.cpp\whisper-quantize.exe models\ggml-large-v3-turbo.bin models\ggml-large-v3-turbo-q5_0.bin q5_0
  ```

  生成後、`config/settings.toml` の `stt.model_path` を `models/ggml-large-v3-turbo-q5_0.bin` に変更します（本リポジトリの設定は q5_0 を指しています）。
- GPU を使わない場合は `stt.use_gpu = false`（アプリが `-ng` を付与）にすると CPU 版 DLL で動作します。

## 起動

Windows では `start.bat` をダブルクリックするのが簡単です（依存パッケージ・ビルド・Ollama/VOICEVOX・モデルの有無を確認してから起動し、ブラウザを開きます）。

> ブラウザのマイクは **`http://localhost:3000`（または `http://127.0.0.1:3000`）** で開けば使えます（localhost は「安全なコンテキスト」扱いのため **https は不要**）。
> LAN の IP・PC 名（例 `http://192.168.0.5:3000`）で開いた場合のみ、ブラウザがマイクを許可しません。

```powershell
.\start.bat              # 起動（3 秒後にブラウザを開く）
.\start.bat /nobrowser   # ブラウザを自動で開かない
```

コマンドラインから直接起動する場合:

```powershell
npm start              # node dist/backend/index.js
# または scripts\run.bat（start.bat へ委譲）
```

ブラウザで <http://localhost:3000> を開きます。

- 「聞き取り開始」で発話待ちに入ります（`conversation.auto_start = true` なら起動直後から待機）
- テキスト欄からも会話できます（STT をスキップ）
- 発話が終わると自動で区切られ、認識 → 応答生成 → 読み上げまで進みます
- 応答中に話しかけると再生を止めて割り込みます（バージイン）
- 応答後しばらくは連続会話（フォローアップ）の待機に入ります

## 主な機能

- VAD（無音検出）による発話区間の自動切り出し（`execSync` を使わないストリーム録音）
- **ブラウザのマイク入力**（既定）: `getUserMedia` で録音し、発話単位の WAV を WebSocket で送信。
  VAD はサーバーと同一実装を共有。ffmpeg は `input_mode = "server"` のフォールバックとして残置
- マイク選択（ブラウザのデバイス一覧）とレベルメーター表示
- **「マイク確認」ボタン**: 5 秒間だけ録音して入力レベル（peak / dBFS / フレーム数）を表示（送信はしない）
- **聞き取りを継続**（`conversation.keep_listening = true`）: フォローアップ回数の上限後も「停止」を押すまで待機を続ける
- ストリーミング応答（差分を逐次表示）と `AbortController` による中断
- **応答言語ガード**: ハングル（韓国語）が混入した応答は 1 回だけ日本語で再生成（小規模モデルの言語混入対策）
- **幻聴（hallucination）対策**: whisper.cpp の非音声トークン抑制・文脈抑制・信頼度フィルタで、
  無音や雑音に対する「ご視聴ありがとうございました。」等の誤認識を破棄（[docs/ASR_OPTIONS.md](docs/ASR_OPTIONS.md)）
- **自分の声のエコー対策**: 直前の読み上げ内容と一致する認識結果・意味のない短い断片は会話に載せない（1 人で会話し続けるループ防止）。
  バージインは既定で無効（ブラウザのエコーキャンセルは ffplay の再生音には効かないため。有効化はヘッドホン推奨）
- バージイン（発話で再生を停止し、その発話を次のターンとして処理）
- フォローアップ（連続会話）
- キャラクター定義（`config/characters/*.toml`）の人格・応答ルール・口癖をプロンプトへ反映
- Web GUI（レベルメーター、履歴同期、自動再接続）
- REST API（設定の参照・部分更新・保存、履歴、ヘルスチェック、デバイス一覧、診断）
- **設定メニュー（⚙️ 設定）**: 画面から **LLM モデル**（Ollama の導入済み一覧）と **STT のエンジン／モデル**
  （whisper の `*.bin` / sherpa のモデル一式）を切り替えられる。再起動不要（次の発話から有効）
- **診断パネル（「診断」ボタン / `GET /api/diagnostics`）**: 状態・サービス疎通・破棄の内訳（幻聴/短断片/エコー/繰り返し）・
  直近の破棄理由・録音結果・VAD しきい値を 1 箇所で確認できる
- レベル付きロガー（コンソール + `logs/app.log`）

## VTuber モード（準備中: P0/P1 実装済み）

- 設定: `config/profiles/vtuber-rtx3060.toml` の内容を `config/settings.toml` へコピーする
- アバター: `live2d-models/<name>/<name>.model3.json` を置くと `GET /api/avatar/models` に現れ、
  `hello.avatar` で画面へ配られる（描画は P3 で実装）
- 音声: `audio.playback_target = "browser"` でブラウザ再生（WebAudio）。表示担当タブは
  `http://localhost:3000/?role=display`。未接続なら自動で ffplay に戻る
- 読み上げは**文単位**（`tts.split_sentences = true`）。1 文目が確定した時点で話し始める。
  文の区切りは `min_sentence_chars` / `max_sentence_chars` で調整できる（`false` で従来動作）
- 画面: `http://localhost:3000/?mode=stage&transparent=1` で「アバター + 字幕」だけの配信画面。
  OBS のブラウザソース（1920×1080 / 30fps）にそのまま入れられる
- アバター: モデルが無いときは CSS 立ち絵（`renderer: "sprite"`）で表示し、`volumes` に合わせて口が動く
- ライセンス: Live2D の Cubism Core とモデルは**各自取得**（`vendor/` と `live2d-models/` は gitignore）

## 設定

`config/settings.toml` に**変更したい項目だけ**を書きます。未指定は `config/settings.default.toml`
（および `src/backend/config/schema.ts` の `DEFAULT_CONFIG`）で補完されます。

> `config/settings.toml` は **`.gitignore` 対象（各自のローカル設定）** です。
> ファイルが無い場合は `config/settings.default.toml` の値だけで起動するため、変更したい項目があるときだけ作成してください
> （`config/settings.default.toml` をコピーして必要な行だけ残すのが簡単です）。

### 認識エンジンの切り替え（whisper / sherpa-onnx）

既定は whisper.cpp です。**幻聴が構造的に起きない CTC 系モデル**を使いたい場合は sherpa-onnx に切り替えられます
（CPU のみで動作し、GPU を LLM に空けられます）。

```powershell
npm install sherpa-onnx-node                              # Windows x64 は DLL 同梱（追加設定不要）
powershell -ExecutionPolicy Bypass -File scripts\setup-sherpa.ps1   # 日本語 Parakeet 0.6B int8（約 467MB）
```

`config/settings.toml`:

```toml
[stt]
engine = "sherpa"
sherpa_model_dir = "models/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8"
sherpa_model_type = "nemo_ctc"      # 単一 model.onnx 構成
sherpa_provider = "cpu"
```

実測（この PC / VOICEVOX の日本語音声）: sherpa-onnx は **222〜420ms / 発話**（whisper.cpp + CUDA q5_0 は約 1.5〜3.5 秒）。
詳細と他エンジンの比較は [docs/ASR_OPTIONS.md](docs/ASR_OPTIONS.md) を参照してください。

### 画面から切り替える（⚙️ 設定）

画面右上の **⚙️ 設定** を開くと、次の 2 つを切り替えられます（変更は即保存され `config/settings.toml` に書き込まれます）。

| 項目 | 切り替え内容 | 反映タイミング |
|---|---|---|
| LLM | Ollama に導入済みのモデル（`GET /api/models` が `ollama list` 相当を返す） | 次の発話から（再起動不要） |
| 音声認識 | エンジン（whisper.cpp / sherpa-onnx）とモデル（`models/*.bin` / sherpa のモデル一式） | 次の発話から（STT 実装を差し替え） |

- 一覧は `GET /api/models`、切替は `PUT /api/models/llm` / `PUT /api/models/stt`
- **LLM の切り替えは 20〜60 秒かかることがあります**（Ollama がモデルを VRAM に読み込むため）。
  切り替え時に事前読み込みを行い、完了後に「読み込み◯秒」と表示します（`llm.model_load_timeout_seconds` 既定 180 秒）
- 存在しないモデルは **400 で拒否**されます（`ollama pull <model>` / `scripts\setup-sherpa.ps1` の案内が画面に出ます）
- 切替後に STT が 🔴 のままなら、`models/` のパスか `sherpa-onnx-node` の導入（`npm install sherpa-onnx-node`）を確認してください
- 進行中の発話は切り替え前の設定で処理され、完了後に新しい設定が使われます

主な項目:

| テーブル | 主なキー |
|----------|----------|
| `[audio]` | `sample_rate`, `frame_ms`, `silence_threshold`, `silence_threshold_max`, `silence_duration`, `no_speech_timeout`, `max_record_seconds`, `relative_threshold_multiplier`, `calibration_duration`, `debounce_frames`, `input_device`, `output_volume`, `player`, `input_mode`, `device_settle_ms` |
| `[conversation]` | `auto_start`, `followup_enabled`, `max_followup_turns`, `followup_timeout_seconds`, `followup_guard_ms`, `keep_listening`, `barge_in_enabled`, `barge_in_min_score` |
| `[stt]` | `model_path`, `binary_path`, `language`, `use_gpu`, `flash_attn`, `beam_size`, `threads`, `suppress_non_speech`, `max_context`, `no_speech_thold`, `drop_no_speech_prob`, `drop_avg_logprob`, `filter_hallucinations`, `min_input_rms`, `engine`, `sherpa_model_dir`, `sherpa_model_type`, `sherpa_provider`, `sherpa_language` |
| `[llm]` | `endpoint`, `model`, `character_file`, `temperature`, `max_tokens`, `history_turns`, `response_timeout_seconds`, `model_load_timeout_seconds` |
| `[tts]` | `endpoint`, `speaker_id`, `speed`, `pitch`, `volume` |

設定の反映:

```powershell
# 再読み込み（キャラクター定義も再読込）
curl -X POST http://localhost:3000/api/config/reload

# 部分更新（settings.toml へ保存される）
curl -X PATCH http://localhost:3000/api/config -H "Content-Type: application/json" -d "{\"tts\":{\"speaker_id\":8}}"
```

> `PATCH /api/config` は `settings.toml` を正規化して書き出すため、手書きコメントは失われます。
> 上書き前の内容は `config/settings.toml.bak` に退避されます。
> `GET/PATCH /api/config` の応答には、検証で補正された内容が `warnings` として含まれます（`/api/health` と同じ内容）。

## 開発

```powershell
npm run verify         # typecheck → test → build をまとめて実行（作業後はこれ 1 本）
npm run typecheck      # 型チェック（backend）
npm test               # ユニット/結合テスト（node:test, 119 ケース）
npm run clean:tests    # dist-test の削除（pretest から自動実行）
npm run config:default # schema.ts の既定値を settings.default.toml へ同期（コメントは保持）
npm run smoke          # 起動中サーバーの疎通確認
npm run check-audio    # マイク入力の診断（3 秒録音してピーク/dBFS を表示）
npm run dev            # ts-node で直接起動
npm run clean          # dist / dist-test の削除
```

テスト構成（`tests/`）:

| ファイル | 内容 |
|----------|------|
| `wav.test.ts` | WAV ヘッダ・二重ヘッダ防止・RMS・長さ |
| `vad.test.ts` | 発話検出・無音終了・タイムアウト・キャリブレーション・中断 |
| `config.test.ts` | 深いマージ・検証（範囲補正）・TOML 往復・保存と再読込・マスク |
| `history.test.ts` | ターン上限・プロンプト用メッセージ整形 |
| `character-prompt.test.ts` | キャラクター TOML の読み込み・システムプロンプト生成 |
| `ollama-stream.test.ts` | NDJSON のチャンク境界処理・モデル一覧 |
| `voicevox-binary.test.ts` | 音声バイナリの非破損・パラメータ反映 |
| `pipeline.test.ts` | 無音 / 1 ターン / テキスト入力 / フォローアップ / バージイン / 中断 / ブラウザ音声 1 ターン |
| `shared-pcm.test.ts` | WAV 生成・Base64・リサンプル・ゲイン（ブラウザと共通） |
| `audio-payload.test.ts` | `submit_audio` の検証（Base64/WAV/サイズ/形式） |
| `frontend-script.test.ts` | ビルド済み `app.js` を擬似 DOM で実行（WS 接続・hello 描画・ボタン送信） |

## 構成

```text
src/
├── shared/protocol.ts          # フロント・バックエンド共有の型（イベント/コマンド）
├── shared/audio/               # PCM/WAV/Base64/VAD（ブラウザとサーバーで共有）
├── backend/
│   ├── index.ts               # コンポジションルート（DI 配線・起動・終了処理）
│   ├── config/                # 設定スキーマ・読込・検証・保存
│   ├── core/                  # ポート定義・ロガー・パス・子プロセス実行
│   ├── services/              # Audio / VAD / STT / LLM / TTS / Character
│   ├── conversation/          # パイプライン・履歴・プロンプト生成
│   └── server/                # Express + WebSocket
└── frontend/                  # index.html / style.css / app.ts（組立）・WsClient・ChatView・MicLoop・mic
config/                        # settings.toml, settings.default.toml, characters/
scripts/                       # setup.bat, run.bat, build.js, clean.js, smoke.js, setup-whisper-cuda.ps1
start.bat                      # Windows 用ランチャー（依存/ビルド/外部サービス確認 → 起動）
docs/                          # DESIGN.md（As-Is）, REDESIGN.md（To-Be）
models/, whisper.cpp/          # Whisper 本体とモデル
logs/                          # app.log（実行ログ）
```

## トラブルシュート

| 症状 | 確認ポイント |
|------|--------------|
| 何が起きているか分からない | 「診断」ボタン（または `GET /api/diagnostics`）で、状態・サービス疎通・破棄の内訳・直近の破棄理由・VAD しきい値をまとめて確認できます |
| マイクが使えない／許可が出ない | `http://localhost` か `http://127.0.0.1`（または https）で開く。LAN の IP では使えません |
| 「マイクの使用が許可されていません」 | ブラウザのアドレスバー横のマイク許可。`http://localhost`（または https）で開く |
| 「音声データが届きません（ctx=suspended …）」 | 自動再生ポリシーで音声処理が停止しています。**画面をもう一度クリック**して再試行（「マイク確認」は自動で再初期化も試します） |
| マイクが一覧に出ない | 画面の「マイク」で「既定のマイク」以外を選択。Windows のサウンド設定も確認 |
| マイクが開かない（ffmpeg モード） | `audio.input_mode = "server"` の場合。`ffmpeg` の PATH、`audio.input_device`、`GET /api/audio-devices` |
| 入力レベルが動かない（マイクが拾っていない） | 「マイク確認」を押して 5 秒話す。peak が 0.02 未満なら「マイク」セレクトで別デバイスを選択 |
| 発話を検出しない | `audio.silence_threshold`（RMS 0..1）を上げる、`audio.input_gain` を上げる。UI のレベルメーターを確認 |
| 話している途中で切れる | ① `audio.max_record_seconds`（既定 30 秒）に達していないか ② `audio.silence_duration`（既定 1.5 秒）より長く黙っていないか ③ `audio.silence_threshold_max`（既定 0.06）でしきい値が上がりすぎていないか。`logs/app.log` の「ブラウザから音声を受信: 1234ms」で実際に送られた長さを確認できる |
| タイピング音や物音で聞き取りが始まる | `audio.debounce_frames`（既定 3 = 60ms 連続）を増やす、`audio.silence_threshold` を上げる、`audio.silence_threshold_max` を下げる |
| 言っていない発話が勝手に入力される（「ご視聴ありがとうございました。」等） | Whisper の幻聴。`stt.suppress_non_speech` / `stt.drop_no_speech_prob` / `stt.filter_hallucinations`（既定で有効）と `audio.silence_threshold`（0.03〜0.05 に上げる）を確認。詳細は [docs/ASR_OPTIONS.md](docs/ASR_OPTIONS.md) |
| 自分で会話が続いてしまう（エコー） | スピーカーの音をマイクが拾っています。ヘッドホンを使う、`conversation.barge_in_enabled = false`（既定）、`audio.output_volume` を下げる。直近の応答と一致する断片・2 文字以下の断片は自動で破棄されます（`logs/app.log` に「エコーと判定」「短すぎる認識結果」） |
| LLM が 404（`model 'xxx' not found`） | `llm.model` が Ollama に無い。`ollama list` で確認し `ollama pull <model>` を実行。**`settings.toml` を書き換えただけでは反映されない**ので `POST /api/config/reload` か再起動も行う（起動時にも警告が出ます） |
| 反応しない／固まったように見える | 「聞き取り開始」を押し直すか、ページを再読み込み。サーバーが幻聴・エコーを破棄した場合は `turn_skipped` を通知して聞き取りを続けます（従来は待機したまま固まる不具合がありました）。`logs/app.log` に「破棄します」が出ていないか確認 |
| 返答が返ってこない | `logs/app.log` に `ERROR [LLM]` が出ていないか確認。接続断は「Ollama との接続が中断されました（モデルの読み込み失敗・VRAM 不足など）」として通知されます。タイムアウトは `llm.response_timeout_seconds` |
| 音が出ない | VOICEVOX の起動、`audio.output_volume`、`audio.player` |
| バージインしない | `conversation.barge_in_enabled`, `barge_in_min_score`（既定 0.08） |
| 設定が効かない | 画面の「⚙️ 設定」で切り替えたモデルは即時反映（次の発話から）。手で `settings.toml` を編集した場合は `POST /api/config/reload` または再起動 |
| モデルを切り替えたら STT が 🔴 のまま | `models/` のパス、`whisper.cpp/main.exe` の有無、`npm install sherpa-onnx-node` を確認。`logs/app.log` に「STT を再構成しました」が出ているか確認 |
| LLM のモデルを切り替えられない | Ollama に未導入のモデルは 400 で拒否されます。`ollama pull <model>` を実行してから選び直してください |
| LLM を切り替えるとタイムアウトする／切り替えが終わらない | モデルの読み込みが遅い環境です。`llm.model_load_timeout_seconds`（既定 180 秒）を増やすか、より小さいモデルを選んでください。`ollama ps` で `size_vram`（VRAM に載っているか）を確認 |
| 「LLM がタイムアウトしました」で応答が止まる | 読み込み中なら上記。生成中なら `llm.response_timeout_seconds`（既定 60 秒）。`logs/app.log` の「最初のチャンクを受信しました」で読み込みと生成を切り分けられる |
| 「⚙️ 設定」で「/api/models が見つかりません」 | 画面（静的ファイル）だけ新しく、起動中のサーバーが古いままです。**アプリを再起動**してください（`start.bat`。コード更新後は必須） |

## 未実装（設定のみ）

`[rag]` `[recipe_db]` `[music]` `[apps.proactive_speech]` `[apps.home_assistant]` は
設定スキーマと既定値のみ定義しています（拡張ポイント）。詳細は
[docs/REDESIGN.md](docs/REDESIGN.md) のロードマップを参照してください。

## ライセンス

MIT License
