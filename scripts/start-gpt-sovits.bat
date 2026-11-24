@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
title GPT-SoVITS API (B 案: 日英で同じ声)

rem ---------------------------------------------------------------
rem B 案（日英で同じ声）用の TTS サーバーを起動する。
rem 参照: docs\TTS_MULTILINGUAL.md の §2-B（セットアップ手順）
rem パスは環境変数 GPT_SOVITS_HOME で変更できる。
rem ---------------------------------------------------------------
if not defined GPT_SOVITS_HOME set "GPT_SOVITS_HOME=D:\LLMProjects\GPT-SoVITS"

if not exist "%GPT_SOVITS_HOME%\api_v2.py" (
    echo [エラー] GPT-SoVITS が見つかりません: %GPT_SOVITS_HOME%
    echo         環境変数 GPT_SOVITS_HOME にリポジトリのパスを設定してください。
    goto :fail
)

set "PYTHON=%GPT_SOVITS_HOME%\.venv-gsv\Scripts\python.exe"
if not exist "%PYTHON%" (
    echo [エラー] venv が見つかりません: %PYTHON%
    echo         docs\TTS_MULTILINGUAL.md の §2-B セットアップを実行してください。
    goto :fail
)

cd /d "%GPT_SOVITS_HOME%"
echo GPT-SoVITS API を起動します: http://127.0.0.1:9880
echo   モデルのロードに数十秒かかります。起動後にこのウィンドウは開いたままにしてください。
echo   停止するには Ctrl+C を押してください。
echo.

"%PYTHON%" api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo GPT-SoVITS を終了しました（code=%EXIT_CODE%）。
pause
exit /b %EXIT_CODE%

:fail
pause
exit /b 1
