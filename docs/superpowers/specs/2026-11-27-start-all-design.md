# 起動フロー簡略化設計（`start.bat /all` + `quit.bat` 連動）（2026-11-27）

対象: `smart_speaker_ts`（TypeScript / Node.js + ブラウザ GUI / ローカル完結）
基準コミット: `7709a43`
作業ブランチ: `develop`
方式: 既存の `start.bat` に `/all` を追加し、サービスの起動・準備完了待ち・PID 記録を
`scripts/start-services.ps1` に集約する。`quit.bat` は記録済みのサービスだけを通常実行で停止する。

---

## 1. 背景と目的

現状は次の 3 つを手動で順に起動し、それぞれの完了を人が待っている。

1. `scripts\start-gpt-sovits.bat`（モデルロードに数十秒）
2. `scripts\start-rvc-worker.bat`（モデルのロード + ウォームアップに約 25 秒）
3. `start.bat`（アプリ本体）

`start.bat` は TTS の**応答確認のみ**を行い、起動・待機はしない。そのため待ち時間を見誤ると、
TTS が準備できていない状態でアプリが起動し、最初の発話が失敗する。

本設計の目的は、**起動を 1 操作**にし、**終了も `quit.bat` 1 回**で後片付けできるようにすること。

- 起動: `start.bat /all` で「未起動サービスの起動 → 準備完了待ち → アプリ起動」を自動化する
- 終了: `quit.bat`（通常実行）で、`/all` が起動したサービスも停止する
- `start.bat`（`/all` なし）と `quit.bat` の既存の使い方は変えない

---

## 2. 現状（実コードで確認した事実）

| 対象 | 現状 |
|---|---|
| `scripts/start-gpt-sovits.bat` | `GPT_SOVITS_HOME`（既定 `D:\LLMProjects\GPT-SoVITS`）の `.venv-gsv` で `api_v2.py` を `127.0.0.1:9880` で起動 |
| GPT-SoVITS の準備完了 | `api_v2.py` はモジュール読み込み時に `TTS(tts_config)` でモデルをロードし、その後 `uvicorn.run` する。**HTTP が応答した時点 = 準備完了** |
| `scripts/start-rvc-worker.bat` | `RVC_WARMUP_ROOT`（既定 `D:\LLMProjects\RVCMultilingual`）の venv で `scripts/rvc_worker.py` を `127.0.0.1:9890` で起動 |
| RVC の準備完了 | `_warmup_from_env()` が `uvicorn.run` の**前**に走る。`/health` が 200 を返した時点で起動完了。`warm` フィールドでウォームアップ成功を判定できる |
| RVC のモデル解決 | 環境変数 `RVC_WARMUP_MODEL` / `RVC_WARMUP_INDEX` が無ければ `config/settings.toml` の `[tts.voice_conversion]` を使う |
| `start.bat` | Node / 依存 / ビルド / Ollama / TTS / モデル / ポートを確認してアプリを起動。TTS は応答確認のみ |
| `quit.bat` | 既定でアプリ・RVC・ffplay を停止。GPT-SoVITS と VOICEVOX は `/all` 指定時のみ停止 |
| 現在の設定 | `[tts.ja]` / `[tts.en]` は `gpt_sovits`、`[tts.voice_conversion].enabled = true` |

---

## 3. 目標と非目標

### 目標

1. `start.bat /all` の 1 操作で、未起動の GPT-SoVITS と RVC を起動し、準備完了を待ってからアプリを起動する
2. 既に起動中のサービスは二重起動せず、準備完了だけを待つ
3. `/all` が起動したサービスを `quit.bat` の通常実行で停止できる（手動起動分は残す）
4. サービスが準備できなくてもアプリの起動は妨げない（既存の警告ベースの姿勢を維持）
5. `start.bat`（`/all` なし）と `quit.bat`（状態ファイルなし）の既存挙動を変えない

### 非目標

- VOICEVOX の自動起動（現状どおり `start.bat` は応答確認のみ）
- 設定ファイルの内容による起動要否の判定（`/all` は明示的に両サービスを起動する）
- GPT-SoVITS と RVC の同時（並列）起動
- サービスの自動再起動・監視（`ServiceMonitor` の責務はアプリ側の疎通確認のみ）
- アプリ本体や WebSocket / 音声パイプラインの変更
- `quit.bat /all` の意味の変更

---

## 4. 設計

### 4.1 起動フロー

```
start.bat /all
  ├─ [1/6] Node.js 確認                         （既存）
  ├─ [2/6] 依存パッケージ確認                    （既存）
  ├─ [3/6] ビルド成果物確認                      （既存）
  ├─ [4/6] Ollama 確認・未起動なら起動            （既存）
  ├─ [all] scripts\start-services.ps1           （新規）
  │    ├─ GPT-SoVITS (:9880)
  │    │    ├─ /docs が応答済み → スキップ
  │    │    ├─ プロセスだけ存在 → 二重起動せず待機
  │    │    ├─ どちらも無い → start-gpt-sovits.bat を別ウィンドウで起動
  │    │    └─ /docs を 2 秒間隔でポーリング（既定 180 秒）
  │    ├─ RVC (:9890)
  │    │    ├─ /health が応答済み → スキップ（warm を表示）
  │    │    ├─ プロセスだけ存在 → 二重起動せず待機
  │    │    ├─ どちらも無い → start-rvc-worker.bat を別ウィンドウで起動
  │    │    └─ /health を 2 秒間隔でポーリング（既定 180 秒）
  │    └─ 起動した PID を logs\start-all.state.json に都度記録
  ├─ [5/6] TTS 応答確認                          （既存。ここでは準備完了済み）
  ├─ [6/6] モデル / ポート確認                    （既存）
  └─ アプリ起動・ブラウザ表示                     （既存）
```

- サービスは **GPT-SoVITS → RVC の順次起動**とする。VRAM 4GB 環境で 2 つのモデルを同時にロードすると
  競合するため、現状の手動フローと同じ順序を守る。
- `/all` は `/nobrowser`・`/chat`・`/stage`・`/split` と併用できる。
- `start.bat` の `[1/6]`〜`[6/6]` の番号は変えない。`[all]` は番号外の追加ブロックとして表示する。

### 4.2 準備完了の判定

| サービス | エンドポイント | 判定 |
|---|---|---|
| GPT-SoVITS | `http://127.0.0.1:9880/docs` | HTTP 200 |
| RVC | `http://127.0.0.1:9890/health` | HTTP 200。JSON の `warm` を表示に使う |

- ポーリング間隔は 2 秒、進捗は 10 秒ごとに表示する。
- タイムアウトの既定は **各サービス 180 秒**。環境変数 `START_ALL_TIMEOUT`（秒）で変更できる。
  10 未満や不正値は既定に戻す。
- RVC が 200 かつ `warm=false` の場合は「初回変換が遅くなる」旨を警告して続行する
  （`model_path` が空、またはウォームアップ失敗の可能性）。

### 4.3 二重起動の防止

GPT-SoVITS と RVC は、モデルのロード／ウォームアップが終わるまでポートを listen しない。
そのため「HTTP が応答しない = 未起動」と判断すると、起動中のプロセスを二重に起動してしまう。
次の順序で判定する。

1. HTTP が応答 → 起動済み。スキップする
2. HTTP は応答しないが、コマンドラインに該当パターンを含むプロセスが存在
   → **起動中の可能性が高いので、新規起動せず待機する**
   - GPT-SoVITS: `*start-gpt-sovits.bat*` または `*api_v2.py*`
   - RVC: `*start-rvc-worker.bat*` または `*rvc_worker.py*`
3. どちらも無い → パスを事前確認してから起動する

事前確認（失敗しても 180 秒待たずに即警告する）:

| サービス | 確認するパス |
|---|---|
| GPT-SoVITS | `%GPT_SOVITS_HOME%\api_v2.py`、`%GPT_SOVITS_HOME%\.venv-gsv\Scripts\python.exe`（`GPT_SOVITS_HOME` の既定は `D:\LLMProjects\GPT-SoVITS`） |
| RVC | `%RVC_WARMUP_ROOT%\venv\Scripts\python.exe`（既定 `D:\LLMProjects\RVCMultilingual`）、`scripts\rvc_worker.py` |

### 4.4 失敗時の扱い

方針: **警告して続行する**。アプリは VOICEVOX でも動作し、RVC は失敗時に元の WAV を返すため、
サービスの準備失敗でアプリの起動を止める必要はない。

| 状況 | 動作 |
|---|---|
| パス・venv が見つからない | 即警告してそのサービスをスキップ。アプリ起動は続行 |
| タイムアウト | 警告して続行。サービスウィンドウのログを確認するよう案内 |
| RVC が `warm=false` で応答 | 警告して続行 |
| 想定外の PowerShell 例外 | エラー内容を表示し、アプリ起動は続行 |
| 状態ファイルの書き込みに失敗 | 警告し、起動したサービスは自動停止の対象外になる旨を表示。アプリ起動は続行 |

`start.bat` は `start-services.ps1` の終了コードで `goto :fail` しない。既存の TTS 警告と同様、
警告を出したうえで `[5/6]` 以降へ進む。

### 4.5 状態ファイル

`/all` が起動したサービスだけを記録する。手動起動したサービスは記録しない。

パス: `logs\start-all.state.json`（`logs` は既存。`.gitignore` に追加する）

```json
{
  "version": 1,
  "updatedAt": "2026-11-27T12:34:56+09:00",
  "services": {
    "gpt-sovits": { "pid": 12345, "port": 9880, "startedAt": "2026-11-27T12:33:10+09:00" },
    "rvc-worker": { "pid": 12346, "port": 9890, "startedAt": "2026-11-27T12:34:02+09:00" }
  }
}
```

- `Start-Process -PassThru` の直後に **1 サービスずつ**書き込む。待機中に Ctrl+C されても追跡できる。
- 一時ファイルへ書いてから `Move-Item -Force` で置き換え、途中書き込みを避ける。
- 実行時に既存の状態を読み、PID が存在しない、またはコマンドラインが一致しないエントリは削除する
  （プロセスの終了・手動クローズ・PID 再利用対策）。
- 記録済みサービスが HTTP 応答済みの場合は、そのエントリを維持したままスキップする。

### 4.6 `quit.bat` との連動

`scripts/quit.ps1` に状態ファイルの処理を追加する。

1. 状態ファイルを読む（無ければ従来どおり）
2. 各エントリについて PID の存在とコマンドラインを検証する
   - GPT-SoVITS: `*start-gpt-sovits.bat*` または `*api_v2.py*`
   - RVC: `*start-rvc-worker.bat*` または `*rvc_worker.py*`
   - PID が再利用されていても、無関係なプロセスを停止しない
3. 一致したら `taskkill /PID <pid> /T /F` でプロセスツリーごと停止する
4. 既に終了している場合は `[skip]` を表示する
5. 全エントリが停止または既に終了していれば状態ファイルを削除する
   - 停止に失敗したエントリは残し、再実行できるようにする
6. ポート確認に 9880 を追加する（状態ファイルに GPT-SoVITS のエントリがあった場合）
   - 9890 は既存の `-RvcPort` で確認済み

`quit.bat` の既定の停止対象は「アプリ・RVC・ffplay・`/all` が起動した GPT-SoVITS」となる。
`quit.bat /all` は従来どおり、コマンドラインパターンで**手動起動分も含めて** GPT-SoVITS と
VOICEVOX を停止する。

### 4.7 PowerShell の実装制約

- Windows PowerShell 5.1 で動作させる（PowerShell 7 専用構文を使わない）
- `scripts/start-services.ps1` は **ASCII のみ**で書く（BOM なし UTF-8 の誤読を避ける。`quit.ps1` と同じ方針）
- HTTP は `Invoke-WebRequest -UseBasicParsing` または `curl.exe` を使い、2 秒でタイムアウトする
- サービスは `Start-Process -PassThru` で別ウィンドウに起動する（既存 bat のログを目視できる）
- リポジトリルートは `$PSScriptRoot` の親から求める（`start.bat` から末尾バックスラッシュ付きのパスを
  引数で渡さない）

---

## 5. 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `start.bat` | `/all` の解析、`start-services.ps1` の呼び出し、使い方表示の更新 |
| `scripts/start-services.ps1` | **新規**。起動判定・準備完了待ち・PID 記録 |
| `scripts/quit.ps1` | 状態ファイルの読み込み、記録 PID の停止、9880 のポート確認 |
| `quit.bat` | 既定の停止対象の表示、`/all` の説明更新 |
| `.gitignore` | `logs/start-all.state.json` を追加 |
| `README.md` | 起動セクションに `start.bat /all` を追記 |
| `AGENTS.md` | コマンド表とハマりどころに `/all` と状態ファイルを追記 |

`start-gpt-sovits.bat` / `start-rvc-worker.bat` / `rvc_worker.py` / アプリ本体は変更しない。

---

## 6. 実装詳細

### 6.1 `start.bat`

- 引数解析に `/all` を追加する（既存の `/nobrowser`・`/chat`・`/stage`・`/split` と同じ `:parse_args` 内）。
- `[4/6]` Ollama の後、`[5/6]` TTS の前に呼ぶ。

```bat
if "%START_ALL%"=="1" (
    echo [all] GPT-SoVITS / RVC を確認・起動します...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%scripts\start-services.ps1"
    if errorlevel 1 echo [all] 警告: サービスの起動確認で問題が発生しました。続行します。
)
```

- 終了コードが 0 以外でも `goto :fail` しない。
- 画面下部のヒントに `/all` を追加する:
  `start.bat /all` で GPT-SoVITS と RVC も起動・待機する。

### 6.2 `scripts/start-services.ps1`

構成（純粋な関数 + メイン処理）:

| 関数 | 役割 |
|---|---|
| `Test-HttpReady` | URL に 2 秒タイムアウトでアクセスし、200 かどうかを返す |
| `Test-ServiceProcess` | コマンドラインパターンに一致するプロセスを返す |
| `Wait-ServiceReady` | 既存プロセスの待機または新規起動を行い、HTTP 応答までポーリングする |
| `Read-State` / `Write-State` | 状態 JSON の読み書き（PID の生存確認を含む） |

メイン処理の流れ:

1. リポジトリルートと状態ファイルパスを決定する
2. 既存の状態を読み、死んでいる PID またはコマンドラインが一致しないエントリを削除する
3. GPT-SoVITS を処理する
   - HTTP 応答あり → `already ready` を表示
   - プロセスあり → `waiting (already starting)` を表示して待機
   - どちらも無し → 事前確認 → `start-gpt-sovits.bat` を別ウィンドウで起動 → PID を記録 → 待機
4. RVC を同様に処理する（`/health` の `warm` を表示）
5. 結果を 1 行ずつ表示する

表示例（ASCII）:

```
[all] GPT-SoVITS (9880): already ready
[all] GPT-SoVITS (9880): starting...
[all] GPT-SoVITS (9880): ready in 42s (pid=12345)
[all] RVC (9890): waiting (already starting)... 20s/180s
[all] RVC (9890): ready in 31s (warm=true, pid=12346)
[all] RVC (9890): ready but warm=false (first conversion may be slow)
[all] RVC (9890): not ready after 180s
[all] continuing; check the service window for details
```

- タイムアウトは `START_ALL_TIMEOUT` を読み、既定 180 秒。
- タイムアウトしても終了コードは 0（アプリ起動を妨げない）。スクリプト自体の例外時のみ 1。

### 6.3 `scripts/quit.ps1` / `quit.bat`

- `quit.ps1` の `Stop-Tree` / `Stop-ByCommandLine` を再利用する。
- 状態ファイル処理は既存の停止処理の後、ポート確認の前に置く。
- 停止に失敗したサービスがある場合、状態ファイルを残して `RESULT` に警告として数える。
- `quit.bat` の表示を更新する:
  - 既定: `- GPT-SoVITS（start.bat /all が起動した場合）`
  - `/all`: `- GPT-SoVITS / VOICEVOX（手動起動分も含む）`

### 6.4 `.gitignore` / ドキュメント

- `.gitignore` に `logs/start-all.state.json` を追加する。
- `README.md` の起動セクションに、従来の手動 3 ステップと `start.bat /all` の両方を記載する。
- `AGENTS.md` のコマンド表に `start.bat /all` を追加し、ハマりどころに
  「状態ファイルは `/all` が起動したサービスだけを記録する」ことを追記する。

---

## 7. エッジケース

| ケース | 期待動作 |
|---|---|
| サービスが手動起動済み | スキップ。状態ファイルに記録しない。`quit.bat` 通常実行では停止しない |
| 前回の `/all` で起動したサービスが稼働中 | 状態エントリを維持してスキップ。`quit.bat` で停止できる |
| `/all` 実行中に Ctrl+C | 起動済みサービスの PID は記録済み。`quit.bat` で停止できる |
| サービスウィンドウを手動で閉じた | 次回の `/all` または `quit.bat` で死んだ PID を検出してエントリを削除 |
| PID が別プロセスに再利用された | コマンドライン検証で不一致なら停止せず、エントリも削除する |
| 状態ファイルの書き込みに失敗 | サービスは起動するが自動停止の対象外。警告を表示し、手動停止を案内する |
| GPT_SOVITS_HOME が不正 | 起動前に検出して即警告。180 秒待たない |
| RVC の `model_path` が空 | ワーカーは起動するが `warm=false`。警告して続行 |
| 両サービスがタイムアウト | アプリは起動する。TTS は VOICEVOX で動作、RVC は素通し |
| `start.bat`（`/all` なし） | 従来どおり。状態ファイルにも触れない |
| `quit.bat`（状態ファイルなし） | 従来どおり |
| `quit.bat /all` | 従来どおり。手動起動分も停止 |

---

## 8. テストと確認

### 手動確認

1. 全サービス停止状態で `start.bat /all /nobrowser`
   → GPT-SoVITS → RVC の順に起動し、準備完了後にアプリが起動する
2. `quit.bat /yes`
   → アプリ・RVC・GPT-SoVITS が停止し、ポート 3000 / 9880 / 9890 が解放され、状態ファイルが消える
3. GPT-SoVITS を手動起動してから `start.bat /all /nobrowser`
   → GPT-SoVITS はスキップされ、`quit.bat /yes` 後も 9880 は稼働を続ける
4. `GPT_SOVITS_HOME` を不正な値にして `start.bat /all /nobrowser`
   → 即警告し、アプリは起動する
5. `START_ALL_TIMEOUT=5` にして `start.bat /all /nobrowser`
   → タイムアウト警告が出てもアプリは起動し、`quit.bat /yes` で起動済みサービスを停止できる
6. `start.bat`（`/all` なし）と `quit.bat`（状態ファイルなし）が従来どおり動く
7. 状態ファイルの JSON が有効で、PID が実際のプロセスと一致する

### 自動確認

- `npm run verify`（typecheck → test → build）が通ること。
  スクリプトのみの変更だが、既存機能への影響がないことを確認する。
- PowerShell スクリプト用の自動テストは追加しない（リポジトリのテスト基盤は `node:test` のみ）。
  上記の手動確認を完了条件とする。

---

## 9. 代替案と不採用理由

| 代替案 | 不採用理由 |
|---|---|
| 新規 `start-all.bat` を作る | 入口が 2 つになる。ユーザーは `start.bat /all` への統合を選択した |
| `quit.bat /all` の案内だけにする | 終了時に `/all` を覚える必要があり、「1 操作で終了」にならない |
| `start.bat` を常に全部起動にする | サービスを個別に使いたい既存の使い方を壊す |
| GPT-SoVITS と RVC を並列起動する | VRAM 4GB 環境でモデルの同時ロードが競合するおそれがある |
| 状態ファイルを使わず `quit.bat` の既定で全部停止する | 手動起動した GPT-SoVITS まで停止してしまう |
| Node.js でオーケストレーターを書く | Windows のプロセス・ウィンドウ管理は PowerShell が自然で、`quit.ps1` と同じ言語に揃えられる |

---

## 10. 受け入れ条件

- [ ] `start.bat /all` が、未起動の GPT-SoVITS と RVC を順に起動し、準備完了を待ってからアプリを起動する
- [ ] 既に起動中のサービスを二重起動しない
- [ ] `start.bat`（`/all` なし）の挙動が変わらない
- [ ] `quit.bat`（通常実行）が `/all` 起動分を停止し、手動起動分は停止しない
- [ ] `quit.bat /all` の挙動が変わらない
- [ ] タイムアウト・パス不備でもアプリの起動が妨げられない
- [ ] 状態ファイルの PID 検証により、無関係なプロセスを停止しない
- [ ] README / AGENTS.md が更新されている
- [ ] `npm run verify` が通る
