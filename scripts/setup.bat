@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

echo.
echo ========================================
echo   Sumika TypeScript Setup
echo ========================================
echo.

:: App root directory
set "APP_DIR=%~dp0.."
cd /d "%APP_DIR%"

echo [1/4] Node.js の確認...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo エラー: Node.js がインストールされていません。
    echo https://nodejs.org/ からインストールしてください。
    pause
    exit /b 1
)
echo       Node.js: OK

echo [2/4] 依存パッケージのインストール...
npm install
if %errorlevel% neq 0 (
    echo.
    echo エラー: npm install に失敗しました。
    pause
    exit /b 1
)
echo       依存パッケージ: インストール完了

echo [3/4] TypeScript のビルド...
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo エラー: ビルドに失敗しました。
    pause
    exit /b 1
)
echo       ビルド: 完了

echo [4/4] Ollama / VOICEVOX の確認...
echo       Ollama: http://localhost:11434 (必要に応じてインストール・起動してください)
echo       VOICEVOX: http://localhost:50021 (必要に応じてインストール・起動してください)
echo.

echo ========================================
echo   セットアップ完了
echo ========================================
echo.
echo 次の手順で起動してください:
echo   1. Ollama と VOICEVOX を起動
echo   2. start.bat を実行（ルート直下。scripts\run.bat も同じ動作です）
echo.
pause