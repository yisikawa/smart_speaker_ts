@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

echo.
echo ========================================
echo   Sumika TypeScript Launcher
echo ========================================
echo.

:: App root directory
set "APP_DIR=%~dp0.."
cd /d "%APP_DIR%"

:: ビルド成果物の確認（無ければビルドする）
if not exist "dist\backend\index.js" (
    echo       ビルド成果物がありません。ビルドを実行します...
    call npm run build
    if errorlevel 1 (
        echo       エラー: ビルドに失敗しました。scripts\setup.bat を実行してください。
        pause
        exit /b 1
    )
)

:: Ollama の起動確認
echo [1/2] Ollama の確認...
curl -s http://localhost:11434/api/tags >nul 2>&1
if %errorlevel% neq 0 (
    echo       Ollama が起動していません。起動を試みます...
    start /b "" ollama serve >nul 2>&1
    timeout /t 5 /nobreak >nul
    curl -s http://localhost:11434/api/tags >nul 2>&1
    if %errorlevel% neq 0 (
        echo       警告: Ollama に接続できません。手動で起動してください。
    ) else (
        echo       Ollama: OK
    )
) else (
    echo       Ollama: OK
)

:: VOICEVOX の起動確認
echo [2/2] VOICEVOX の確認...
curl -s http://localhost:50021/version >nul 2>&1
if %errorlevel% neq 0 (
    echo       警告: VOICEVOX に接続できません。手動で起動してください。
) else (
    echo       VOICEVOX: OK
)

echo.
echo アプリを起動しています...
echo ブラウザで http://localhost:3000 を開いてください。
echo.

node dist/backend/index.js

pause