<#
.SYNOPSIS
  sherpa-onnx 用の日本語音声認識モデルを取得して models/ へ展開する。

.DESCRIPTION
  既定では GitHub Releases (asr-models) の
  sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8.tar.bz2（約 467MB）を取得し、
  models/ 配下へ展開する。NVIDIA Parakeet 0.6B（日本語 35,000 時間で学習）の int8 版で、
  CPU のみで動作し（CUDA 不要）、CTC/TDT 系のため無音に対する幻聴が起きない。

  展開後、config/settings.toml の [stt] を次のように変更すると sherpa エンジンに切り替わる。

    engine = "sherpa"
    sherpa_model_dir = "models/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8"
    sherpa_model_type = "nemo_ctc"

  事前に `npm install sherpa-onnx-node` が必要（Windows x64 は DLL 同梱・追加設定不要）。

.PARAMETER ArchivePath
  既にダウンロード済みの .tar.bz2 を使う場合に指定する（省略時はダウンロードする）。

.PARAMETER ModelName
  取得するモデル名（既定は日本語 Parakeet 0.6B int8）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-sherpa.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-sherpa.ps1 -ArchivePath C:\downloads\model.tar.bz2
#>
param(
    [string]$ArchivePath = "",
    [string]$ModelName = "sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8",
    [string]$ReleaseTag = "asr-models",
    [string]$Repository = "k2-fsa/sherpa-onnx"
)

$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$modelsDir = Join-Path $rootDir "models"
$targetDir = Join-Path $modelsDir $ModelName
$archiveName = "$ModelName.tar.bz2"

if (-not (Test-Path $modelsDir)) {
    New-Item -ItemType Directory -Path $modelsDir | Out-Null
}

# 1. アーカイブの取得
if (-not $ArchivePath) {
    $ArchivePath = Join-Path $modelsDir $archiveName
    if (Test-Path $ArchivePath) {
        Write-Host "[1/3] 既存のアーカイブを使用します: $archiveName"
    } else {
        $url = "https://github.com/$Repository/releases/download/$ReleaseTag/$archiveName"
        Write-Host "[1/3] ダウンロードしています（約 467MB）: $url"
        curl.exe -L --retry 2 --retry-delay 3 -o $ArchivePath $url
        if ($LASTEXITCODE -ne 0) {
            throw "ダウンロードに失敗しました（curl exit=$LASTEXITCODE）"
        }
    }
} else {
    Write-Host "[1/3] 指定されたアーカイブを使用します: $ArchivePath"
}

# 2. 展開
if (Test-Path $targetDir) {
    Write-Host "[2/3] 展開先が既に存在します（スキップ）: $ModelName"
} else {
    Write-Host "[2/3] 展開しています: $ModelName"
    # Windows 同梱の tar は bzip2 展開が極端に遅いことがあるため、7-Zip があれば優先する
    $sevenZip = Join-Path $env:ProgramFiles "7-Zip\7z.exe"
    if (Test-Path $sevenZip) {
        & $sevenZip x $ArchivePath "-o$modelsDir" -y | Out-Null
        $tarPath = [System.IO.Path]::ChangeExtension($ArchivePath, ".tar")
        if (Test-Path $tarPath) {
            & $sevenZip x $tarPath "-o$modelsDir" -y | Out-Null
            Remove-Item $tarPath -Force
        }
    } else {
        tar -xjf $ArchivePath -C $modelsDir
    }
    if ($LASTEXITCODE -ne 0) {
        throw "展開に失敗しました（exit=$LASTEXITCODE）"
    }
}

# 3. 検証（tokens.txt と ONNX が 1 つ以上あれば OK。transducer は 3 つ揃う）
Write-Host "[3/3] 内容を確認しています..."
if (-not (Test-Path (Join-Path $targetDir "tokens.txt"))) {
    throw "tokens.txt が見つかりません: $targetDir"
}
$onnx = Get-ChildItem $targetDir -Filter *.onnx -ErrorAction SilentlyContinue
if (-not $onnx) {
    throw "ONNX モデルが見つかりません: $targetDir"
}

Write-Host ""
Write-Host "モデルの準備ができました: models/$ModelName"
Write-Host "config/settings.toml の [stt] を次のように変更してください:"
Write-Host ""
Write-Host "  engine = `"sherpa`""
Write-Host "  sherpa_model_dir = `"models/$ModelName`""
Write-Host "  sherpa_model_type = `"nemo_ctc`""
Write-Host ""
Write-Host "（sherpa-onnx-node が未導入なら: npm install sherpa-onnx-node）"
