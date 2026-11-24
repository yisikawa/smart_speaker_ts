# 後処理込みの終了スクリプト（quit.bat から呼ばれる）。
#
# ASCII のみで書くこと（Windows PowerShell 5.1 は BOM なし UTF-8 を誤読することがある。
# 日本語のメッセージは quit.bat 側で出す）。
param(
    [int]$Port = 3000,
    [int]$RvcPort = 9890,
    [switch]$All,
    [switch]$Yes
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$script:failures = 0

function Stop-Tree {
    param([int]$ProcessId, [string]$Label)
    & taskkill /PID $ProcessId /T /F 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [stop] $Label (pid=$ProcessId)"
    } else {
        # 既に終了していた場合はタスクとしては成功（失敗にしない）
        Write-Host "  [skip] $Label (pid=$ProcessId) was already gone"
    }
}

function Stop-ByCommandLine {
    param([string]$Label, [string]$Name, [string[]]$Patterns)
    $targets = @(Get-CimInstance Win32_Process -Filter "Name='$Name'" -ErrorAction SilentlyContinue |
        Where-Object {
            $cmd = $_.CommandLine
            $null -ne $cmd -and ($Patterns | Where-Object { $cmd -like $_ })
        })
    if ($targets.Count -eq 0) {
        Write-Host "  [none] $Label"
        return
    }
    foreach ($t in $targets) {
        Stop-Tree -ProcessId $t.ProcessId -Label $Label
    }
}

Write-Host ""
Write-Host "--- processes ---"

# アプリ本体（start.bat が起動する node）
Stop-ByCommandLine -Label "app (node)" -Name "node.exe" -Patterns @("*dist\backend\index.js*", "*dist/backend/index.js*")
# RVC ワーカー（scripts\start-rvc-worker.bat が起動する python）
Stop-ByCommandLine -Label "rvc worker" -Name "python.exe" -Patterns @("*rvc_worker.py*")
# 再生（ffplay）の孤児。録音用 ffmpeg は -t で自然終了するので触らない
Stop-ByCommandLine -Label "ffplay (leftover)" -Name "ffplay.exe" -Patterns @("*")

if ($All) {
    Stop-ByCommandLine -Label "gpt-sovits api" -Name "python.exe" -Patterns @("*api_v2.py*")
    Stop-ByCommandLine -Label "voicevox" -Name "VOICEVOX.exe" -Patterns @("*")
}

# ポートが解放されるまで少し待つ（time_wait ではなく LISTEN の消滅を待つ）
Start-Sleep -Milliseconds 800

Write-Host ""
Write-Host "--- ports ---"
$ports = @($Port, $RvcPort)
if ($All) {
    $ports += 9880
    $ports += 50021
}
foreach ($p in $ports) {
    $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        Write-Host "  [busy] port $p still listening (pid=$($conn.OwningProcess))"
        $script:failures += 1
    } else {
        Write-Host "  [ok]   port $p released"
    }
}

Write-Host ""
Write-Host "--- cleanup ---"
$targets = @(
    (Join-Path $root "logs\tts-spike"),
    (Join-Path $root "dist-test"),
    (Join-Path $root "scripts\__pycache__")
)
foreach ($path in $targets) {
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "  [none] $path"
        continue
    }
    try {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
        Write-Host "  [rm]   $path"
    } catch {
        Write-Host "  [warn] $path : $($_.Exception.Message)"
        $script:failures += 1
    }
}

Write-Host ""
if ($script:failures -eq 0) {
    Write-Host "RESULT: OK"
    exit 0
}
Write-Host "RESULT: $($script:failures) warning(s)"
exit 1
