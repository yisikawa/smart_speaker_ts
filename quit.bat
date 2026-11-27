@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title Sumika TypeScript - Quit

set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

if not defined PORT set "PORT=3000"
set "RVC_PORT=9890"
set "STOP_ALL=0"
set "ASSUME_YES=0"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="/all" set "STOP_ALL=1"
if /i "%~1"=="/y" set "ASSUME_YES=1"
if /i "%~1"=="/yes" set "ASSUME_YES=1"
if /i "%~1"=="/h" goto :usage
if /i "%~1"=="/help" goto :usage
shift
goto :parse_args
:args_done

echo.
echo ========================================
echo   Sumika TypeScript  Quit
echo ========================================
echo.
echo 停止するもの:
echo   - アプリ本体        (node dist\backend\index.js / :%PORT%)
echo   - RVC ワーカー      (scripts\rvc_worker.py / :%RVC_PORT%)
if "%STOP_ALL%"=="1" (
    echo   - GPT-SoVITS API    (api_v2.py / :9880。手動起動分も含む)
    echo   - VOICEVOX ENGINE   (:50021)
) else (
    echo   - GPT-SoVITS        (start.bat /all が起動した場合のみ / :9880)
    echo   - VOICEVOX は止めません（止めるには quit.bat /all）
)
echo   - ffplay の孤児プロセス（再生の残り）
echo.
echo 後処理（削除）:
echo   - logs\tts-spike の生成物 / dist-test / scripts\__pycache__
echo   - ログ（app.log など）は残します
echo.

if "%ASSUME_YES%"=="0" (
    set /p "ANSWER=実行しますか？ [y/N]: "
    if /i not "!ANSWER!"=="y" (
        echo.
        echo 中止しました。
        pause
        exit /b 0
    )
)

set "PS_ARGS=-Port %PORT% -RvcPort %RVC_PORT%"
if "%STOP_ALL%"=="1" set "PS_ARGS=%PS_ARGS% -All"
if "%ASSUME_YES%"=="1" set "PS_ARGS=%PS_ARGS% -Yes"

powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%scripts\quit.ps1" %PS_ARGS%
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
    echo 終了しました。次回は start.bat で起動してください（まとめて起動するなら start.bat /all）。
) else (
    echo 一部の後処理に失敗しました（code=%EXIT_CODE%）。上のメッセージを確認してください。
)
echo.
if "%ASSUME_YES%"=="0" pause
exit /b %EXIT_CODE%

:usage
echo 使い方: quit.bat [/all] [/yes]
echo   /all   GPT-SoVITS（:9880）と VOICEVOX（:50021）も停止する（手動起動分を含む）
echo   /yes   確認なしで実行する（自動化向け）
echo   終了コード: 0=成功 / 1=一部失敗
exit /b 0
