@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title Sumika TypeScript

set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

if not defined PORT set "PORT=3000"
set "OPEN_BROWSER=1"
if /i "%~1"=="/nobrowser" set "OPEN_BROWSER=0"
if /i "%~1"=="--no-browser" set "OPEN_BROWSER=0"

echo.
echo ========================================
echo   Sumika TypeScript  Launcher
echo ========================================
echo.

:: ---------------------------------------------------------------
:: 1. Node.js の確認
:: ---------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo [エラー] Node.js が見つかりません。
    echo          https://nodejs.org/ からインストールしてください。
    goto :fail
)
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VERSION=%%v"
echo [1/6] Node.js: !NODE_VERSION!

:: ---------------------------------------------------------------
:: 2. 依存パッケージ
:: ---------------------------------------------------------------
if not exist "node_modules" (
    echo [2/6] 依存パッケージをインストールしています（初回のみ）...
    call npm install
    if errorlevel 1 (
        echo [エラー] npm install に失敗しました。
        goto :fail
    )
) else (
    echo [2/6] 依存パッケージ: OK
)

:: ---------------------------------------------------------------
:: 3. ビルド成果物
:: ---------------------------------------------------------------
if not exist "dist\backend\index.js" (
    echo [3/6] ビルドしています...
    call npm run build
    if errorlevel 1 (
        echo [エラー] ビルドに失敗しました。
        goto :fail
    )
) else (
    echo [3/6] ビルド成果物: OK
)

:: ---------------------------------------------------------------
:: 4. Ollama（未起動なら起動を試みる）
:: ---------------------------------------------------------------
curl -s -f --max-time 3 http://127.0.0.1:11434/api/tags >nul 2>&1
if errorlevel 1 (
    echo [4/6] Ollama が起動していません。起動を試みます...
    start "" /b ollama serve >nul 2>&1
    timeout /t 5 /nobreak >nul
    curl -s -f --max-time 3 http://127.0.0.1:11434/api/tags >nul 2>&1
    if errorlevel 1 (
        echo       警告: Ollama に接続できません。手動で起動してください（ollama serve）。
    ) else (
        echo       Ollama: OK
    )
) else (
    echo [4/6] Ollama: OK
)

:: ---------------------------------------------------------------
:: 5. VOICEVOX ENGINE
:: ---------------------------------------------------------------
curl -s -f --max-time 3 http://127.0.0.1:50021/version >nul 2>&1
if errorlevel 1 (
    echo [5/6] 警告: VOICEVOX に接続できません。VOICEVOX を起動してください。
) else (
    echo [5/6] VOICEVOX: OK
)

:: ---------------------------------------------------------------
:: 6. モデル / ポートの確認
:: ---------------------------------------------------------------
set "HAS_MODEL=0"
if exist "models\ggml-large-v3-turbo-q5_0.bin" set "HAS_MODEL=1"
if exist "models\ggml-large-v3-turbo.bin" set "HAS_MODEL=1"
if "!HAS_MODEL!"=="0" (
    echo [6/6] 警告: Whisper モデルが見つかりません。models\ に ggml モデルを配置してください。
) else (
    echo [6/6] Whisper モデル: OK
)

netstat -ano | findstr /C:":%PORT% " | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo.
    echo [警告] ポート %PORT% は既に使用中です。
    echo        既存のプロセスを終了するか、環境変数 PORT を変更してください。
    echo.
)

:: ---------------------------------------------------------------
:: 起動
:: ---------------------------------------------------------------
echo.
echo アプリを起動します: http://localhost:%PORT%
if "%OPEN_BROWSER%"=="1" (
    echo 3 秒後にブラウザを開きます（ブラウザを開かない場合は start.bat /nobrowser）
    start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:%PORT%'" >nul 2>&1
)
echo 終了するには Ctrl+C を押してください。
echo.

node dist\backend\index.js
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
    echo アプリは終了コード %EXIT_CODE% で終了しました。logs\app.log を確認してください。
) else (
    echo アプリを終了しました。
)
echo.
pause
exit /b %EXIT_CODE%

:fail
echo.
pause
exit /b 1
