<#
.SYNOPSIS
  whisper.cpp を CPU 版から CUDA 版（cuBLAS 同梱ビルド）へ差し替える。

.DESCRIPTION
  既定では GitHub Releases (b5130) の whisper-cublas-12.4.0-bin-x64.zip を取得し、
  whisper.cpp/ 配下の実行ファイルと DLL を置き換える。
  既存ファイルは whisper.cpp/_cpu-backup/ へ退避するため、-Restore で元に戻せる。

  同梱の CUDA ランタイム DLL（cublas / cudart / nvrtc）もコピーするので、
  CUDA Toolkit をインストールしていなくても動作する（NVIDIA ドライバは必要）。

.PARAMETER ZipPath
  既にダウンロード済みの zip を使う場合に指定する（省略時はダウンロードする）。

.PARAMETER Restore
  _cpu-backup から CPU 版へ戻す。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-whisper-cuda.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-whisper-cuda.ps1 -ZipPath C:\downloads\whisper-cublas-12.4.0-bin-x64.zip

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-whisper-cuda.ps1 -Restore
#>
param(
    [string]$ZipPath = "",
    [string]$ReleaseTag = "b5130",
    [string]$AssetName = "whisper-cublas-12.4.0-bin-x64.zip",
    [switch]$Restore
)

$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$targetDir = Join-Path $rootDir "whisper.cpp"
$backupDir = Join-Path $targetDir "_cpu-backup"

# CUDA ビルドで必要になるファイル（Release フォルダ内の相対名）
$filesToCopy = @(
    "main.exe",
    "whisper-cli.exe",
    "whisper.dll",
    "ggml.dll",
    "ggml-base.dll",
    "ggml-cuda.dll",
    "cublas64_12.dll",
    "cublasLt64_12.dll",
    "cudart64_12.dll",
    "nvrtc64_120_0.dll",
    "nvrtc-builtins64_124.dll",
    "nvblas64_12.dll"
)

function Write-Step([string]$message) {
    Write-Host "==> $message"
}

if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir | Out-Null
    Write-Step "whisper.cpp ディレクトリを作成しました"
}

# --- CPU 版へ戻す ---
if ($Restore) {
    if (-not (Test-Path $backupDir)) {
        throw "バックアップがありません: $backupDir"
    }
    Write-Step "CPU 版へ復元しています"
    Get-ChildItem $backupDir -File | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $targetDir $_.Name) -Force
    }
    Write-Step "復元しました。確認: .\whisper.cpp\main.exe --version"
    exit 0
}

# --- 既存ファイルの退避 ---
if (-not (Test-Path $backupDir)) {
    New-Item -ItemType Directory -Path $backupDir | Out-Null
    Write-Step "既存ファイルを $backupDir へ退避します"
    Get-ChildItem $targetDir -File | Where-Object { $_.Extension -in ".exe", ".dll" } | ForEach-Object {
        Move-Item $_.FullName (Join-Path $backupDir $_.Name) -Force
    }
} else {
    Write-Step "バックアップは既に存在します（$backupDir）。上書きします"
}

# --- zip の取得 ---
if ([string]::IsNullOrWhiteSpace($ZipPath)) {
    $downloadDir = Join-Path $env:TEMP "sumika-whisper-cuda"
    New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
    $ZipPath = Join-Path $downloadDir $AssetName

    if (Test-Path $ZipPath) {
        Write-Step "ダウンロード済みの zip を使用します: $ZipPath"
    } else {
        $url = "https://github.com/ggml-org/whisper.cpp/releases/download/$ReleaseTag/$AssetName"
        Write-Step "ダウンロード: $url"
        & curl.exe -L --retry 3 --retry-delay 2 -o $ZipPath $url
        if ($LASTEXITCODE -ne 0) {
            throw "ダウンロードに失敗しました (exit=$LASTEXITCODE)"
        }
    }
}

if (-not (Test-Path $ZipPath)) {
    throw "zip が見つかりません: $ZipPath"
}

# --- 展開 ---
$extractDir = Join-Path ([System.IO.Path]::GetTempPath()) ("sumika-whisper-cuda-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $extractDir | Out-Null
Write-Step "展開中: $ZipPath"
& tar.exe -xf $ZipPath -C $extractDir
if ($LASTEXITCODE -ne 0) {
    Expand-Archive -Path $ZipPath -DestinationPath $extractDir -Force
}

$releaseDir = Get-ChildItem $extractDir -Recurse -Directory | Where-Object { $_.Name -eq "Release" } | Select-Object -First 1
if (-not $releaseDir) {
    $releaseDir = Get-ChildItem $extractDir -Directory | Select-Object -First 1
}
if (-not $releaseDir) {
    throw "展開先に Release ディレクトリが見つかりません: $extractDir"
}
Write-Step "配布物: $($releaseDir.FullName)"

# --- コピー ---
$copied = @()
foreach ($name in $filesToCopy) {
    $source = Join-Path $releaseDir.FullName $name
    if (Test-Path $source) {
        Copy-Item $source (Join-Path $targetDir $name) -Force
        $copied += $name
    } else {
        Write-Warning "見つかりません（スキップ）: $name"
    }
}

# CPU フォールバック用のバックエンド DLL（ggml-cpu-*.dll）もコピーしておく
Get-ChildItem $releaseDir.FullName -Filter "ggml-cpu-*.dll" -File | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $targetDir $_.Name) -Force
    $copied += $_.Name
}

# 上流では main.exe が廃止され whisper-cli.exe に統合された（main.exe は警告を出すだけのスタブ）。
# 既存の設定（stt.binary_path = "whisper.cpp/main.exe"）を壊さないよう、CLI を main.exe としても配置する。
$cliPath = Join-Path $targetDir "whisper-cli.exe"
if (Test-Path $cliPath) {
    Copy-Item $cliPath (Join-Path $targetDir "main.exe") -Force
    Write-Step "互換用に whisper-cli.exe を main.exe としても配置しました"
}

Write-Step ("コピー完了: " + ($copied -join ", "))
Write-Host ""
Write-Host "確認方法:"
Write-Host "  .\whisper.cpp\main.exe --version"
Write-Host "  .\whisper.cpp\main.exe -m models\ggml-large-v3-turbo.bin -f <WAVファイル> -l ja -otxt -of logs\gpu-test -fa"
Write-Host ""
Write-Host "元の CPU 版へ戻す場合:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\setup-whisper-cuda.ps1 -Restore"
