@echo off
rem RVC の常駐ワーカーを起動する（RVCMultilingual の venv を使う）。
rem モデルのパスは settings.toml の [tts.voice_conversion] と同じ値にすること
rem （違っても動くが、初回の変換でモデルを読み直すため 20 秒以上かかる）。
rem 環境変数で上書きできる: RVC_WARMUP_MODEL / RVC_WARMUP_INDEX / RVC_PORT
setlocal

set "RVC_ROOT=%RVC_WARMUP_ROOT%"
if "%RVC_ROOT%"=="" set "RVC_ROOT=D:\LLMProjects\RVCMultilingual"

set "PY=%RVC_ROOT%\venv\Scripts\python.exe"
if not exist "%PY%" (
  echo [RVC] python が見つかりません: %PY%
  echo [RVC] RVCMultilingual の venv を作成するか RVC_WARMUP_ROOT を設定してください
  exit /b 1
)

if "%RVC_WARMUP_MODEL%"=="" set "RVC_WARMUP_MODEL=%RVC_ROOT%\models\imadaMio.pth"
if "%RVC_WARMUP_INDEX%"=="" if exist "%RVC_ROOT%\models\imadaMio_v2.index" set "RVC_WARMUP_INDEX=%RVC_ROOT%\models\imadaMio_v2.index"
if "%RVC_PORT%"=="" set "RVC_PORT=9890"
set "TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1"

echo [RVC] worker: %RVC_WARMUP_MODEL%
echo [RVC] index : %RVC_WARMUP_INDEX%
echo [RVC] port  : %RVC_PORT%

"%PY%" "%~dp0rvc_worker.py"
