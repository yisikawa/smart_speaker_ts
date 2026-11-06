# CLAUDE.md

このリポジトリの作業メモリー（規約・コマンド・ハマりどころ・現状）は **`AGENTS.md`** に集約しています。
作業前に必ず読んでください。

- 仕様書: `docs/DESIGN.md`（As-Is） / `docs/REDESIGN.md`（To-Be）
- ビルド: `npm run build`（フロントは **esbuild バンドル**。`tsc` 出力はブラウザで動きません）
- 検証: `npm run verify`（typecheck → test → build を一括。作業後はこれ 1 本）
- テスト: `npm test`（`node:test`, 119 件, `--test-timeout=30000`）
- 起動: `.\start.bat`
- ブランチ: 作業は `develop`（`main` は動作確認済みの状態）
