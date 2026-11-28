# サーバー待受ポートの設定化（`[server] port`）

日付: 2026-11-28
状態: 設計レビュー待ち

## 背景

- 待受ポート `3000` が `start.bat` / `quit.bat` / `scripts/quit.ps1` / `scripts/smoke.js` /
  `scripts/start-stage.bat` / `scripts/setup-https.ps1` / `src/backend/index.ts` に
  既定値として散在している。
- 環境によっては 3000 番が別のアプリと競合する。
- 既定値を別の値に一括置換するのは、環境固有の事情を既定値へ押し付ける応急処置であり、
  次にポートを変えるときも同じ複数ファイルの変更が必要になる。

## 目的

- 待受ポートを設定ファイルの一級項目 `[server] port` にする。
- 既定値は 3000 のまま。
- `PORT` 環境変数（`start.bat` の `set`）を最優先の上書きとして残す。
- 起動・終了・疎通確認・stage 起動・HTTPS 案内が同じポート値を見る。

## 非目標

- 認証・リバースプロキシなど公開設定の追加。
- 空きポートの自動探索。
- 設定 API の仕様変更（`server.port` は通常の設定項目として扱う）。

## 記述範囲

- 設計書には外部から見える契約を書く: 設定キー（`[server] port`）、環境変数（`PORT` / `SMOKE_BASE`）、
  型フィールド（`ServerConfig.port`）、スクリプト名（`scripts/resolve-port.js`）。
- 内部の定数・関数名・ローカル変数は書かない（実装計画またはコードに任せる）。
- 特定の PC・ユーザー・他プロジェクト名など、環境固有の情報は書かない
  （ローカル設定や環境メモに分離する）。

## 決定事項

1. `ServerConfig.port: number` を追加し、既定値を 3000 にする。
2. 優先順位は **`PORT` 環境変数（有効な整数） > `[server] port` > 3000**。
3. ポートは **1..65535 の整数**。範囲外・非整数は 3000 に補正し、警告を返す。
4. `config/settings.default.toml` と `config/settings.toml` の既存 `[server]` セクションに、
   新規キー `port`（整数）を追加する。他のキー・セクションは変更しない。
   既定値は `config/settings.default.toml` の `port = 3000`。
   環境ごとの値はローカル設定 `config/settings.toml`（gitignore 対象）で上書きする
   （例: `port = 8080`）。
5. `scripts/resolve-port.js` が設定ファイルと環境変数を解決し、標準出力へポート番号だけを出す。
   `start.bat` / `quit.bat` / `scripts/start-stage.bat` / `scripts/setup-https.ps1` /
   `scripts/smoke.js` はこれを使う。
6. `start.bat` の先頭に `set "PORT=<ポート番号>"` を書けば、その起動だけの一時上書きになる
   （`resolve-port.js` が `PORT` を最初に読むため）。**永続的な変更は `[server] port` に置く**。
   `quit.bat` / `npm run smoke` は別プロセスなので、同じ `PORT` を渡さない限り設定値を見る。
7. `start.bat` は `npm install` / `npm run build` の後にポートを解決する
   （初回起動でも依存パッケージとビルド成果物が揃っているようにするため）。
8. サーバーは `PORT` 環境変数と設定値から待受ポートを決定する。
9. `scripts/smoke.js` の既定接続先は `SMOKE_BASE` > 解決値の順。
10. 既定値の一括変更は行わず、本設計の実装で置き換える。

## コンポーネント

| ファイル | 役割 |
|---|---|
| `src/shared/port.ts` | ポートの検証・解決の純粋関数 |
| `scripts/resolve-port.js` | TOML 読み取り + CLI。`dist` に依存せず単体で動く |
| `src/backend/config/schema.ts` | `ServerConfig.port` と既定値 |
| `src/backend/config/sanitize.ts` | ポートの範囲検証と補正 |
| `config/settings.default.toml` | `[server] port = 3000` |
| `config/settings.toml`（ローカルのみ） | ローカル上書き（例: `[server] port = 8080`） |
| `src/backend/index.ts` | `PORT` > 設定値で待受ポートを決定 |
| `start.bat` | ビルド後に `resolve-port.js` で `PORT` を設定し、URL とポート確認に使う |
| `quit.bat` / `scripts/quit.ps1` | 同じ解決値をポート解放確認に使う |
| `scripts/start-stage.bat` | 同じ解決値を `npm start` と Edge の URL に使う |
| `scripts/setup-https.ps1` | 案内文のポートを解決値に使う |
| `scripts/smoke.js` | `SMOKE_BASE` が無ければ解決値を使う |
| `README.md` / `AGENTS.md` | `[server] port` と優先順位を記載 |

## データフロー

1. **起動**: `start.bat` → `node scripts\resolve-port.js` → `PORT` を設定 →
   起動 URL を組み立て → `node dist\backend\index.js`。
   サーバー側は `PORT` 環境変数と設定値から最終決定する。
2. **終了**: `quit.bat` → `resolve-port.js` → `quit.ps1` にポートを渡す。
3. **疎通確認**: `SMOKE_BASE` があればそれを使い、無ければ `resolve-port.js` の値。
4. **stage**: `start-stage.bat` → `resolve-port.js` → `npm start` に `PORT` を継承し、
   Edge の URL も同じ値。
5. **HTTPS 案内**: `setup-https.ps1` → `resolve-port.js` → 表示する URL。

## エラー処理

- 設定ファイルが無い・解析できない・`port` が無い → 次の優先順位へフォールバック。
- 環境変数 `PORT` が不正 → 無視して設定値へ。
- 設定値が不正 → 3000 に補正し警告。
- `resolve-port.js` 自体が動かない（Node / 依存パッケージ不足など）→ 呼び出し側で 3000 にフォールバック。

## テスト

- `tests/port.test.ts`
  - ポート検証の境界（1 / 65535 / 0 / 65536 / 小数 / 文字列）
  - 優先順位（環境変数 > 設定 > 既定）と不正値の扱い
  - `resolve-port.js` の TOML 解決（settings.toml > settings.default.toml > 3000）
  - `resolve-port.js` の CLI がポートだけを出力すること
- `tests/config.test.ts`
  - 設定検証が `server.port` を 1..65535 に補正し警告を返すこと
- `tests/config-defaults.test.ts`
  - `settings.default.toml` と `schema.ts` の既定値が同期していること
- `npm run verify`（typecheck → test → build）

## ドキュメント

- `README.md`: `[server]` の表に `port` を追加し、変更方法
  （`config/settings.toml` か `PORT` 環境変数）を記載する。
- `AGENTS.md`: ポートの単一源と `scripts/resolve-port.js` の利用箇所を追記する。
- 既存の URL 例は既定値の 3000 のまま。環境ごとの値はローカル設定で表現する。

## 影響

- 既定値は 3000 のままなので、既存環境の挙動は変わらない。
- `PORT` 環境変数の上書きは維持される（不正値の扱いだけ明確化）。
- ローカル設定で `port` を指定した環境では、そのポートで起動する。

## 未決事項

なし。
