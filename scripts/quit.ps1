# Cleanup-capable quit script (called from quit.bat).
#
# ASCII only: Windows PowerShell 5.1 may misread BOM-less UTF-8.
# Japanese messages are printed by quit.bat.
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
$statePath = Join-Path $root "logs\start-all.state.json"
$launcherPatterns = @{
    "gpt-sovits" = @("*start-gpt-sovits.bat*", "*api_v2.py*")
    "rvc-worker" = @("*start-rvc-worker.bat*", "*rvc_worker.py*")
}

function Stop-Tree {
    param([int]$ProcessId, [string]$Label)
    & taskkill /PID $ProcessId /T /F 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [stop] $Label (pid=$ProcessId)"
    } else {
        # Already gone counts as success (not a failure).
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

function Get-LauncherState {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        return ($raw | ConvertFrom-Json)
    } catch {
        Write-Host "  [warn] state file is unreadable: $Path"
        return $null
    }
}

function Test-StateProcess {
    param([int]$ProcessId, [string[]]$Patterns)
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $proc -or $null -eq $proc.CommandLine) {
        return $false
    }
    foreach ($pattern in $Patterns) {
        if ($proc.CommandLine -like $pattern) {
            return $true
        }
    }
    return $false
}

function Stop-LauncherServices {
    param([object]$State, [string]$Path, [hashtable]$PatternsByService)
    if ($null -eq $State -or $null -eq $State.services) {
        return
    }
    $remaining = @{}
    foreach ($prop in $State.services.PSObject.Properties) {
        $name = $prop.Name
        $entry = $prop.Value
        $pidValue = [int]$entry.pid
        $patterns = $PatternsByService[$name]
        if ($null -eq $patterns) {
            Write-Host "  [warn] unknown launcher service: $name (pid=$pidValue)"
            continue
        }
        if (-not (Test-StateProcess -ProcessId $pidValue -Patterns $patterns)) {
            Write-Host "  [skip] $name (launcher, pid=$pidValue) is not running or no longer matches"
            continue
        }
        Stop-Tree -ProcessId $pidValue -Label "$name (launcher)"
        Start-Sleep -Milliseconds 500
        if (Test-StateProcess -ProcessId $pidValue -Patterns $patterns) {
            Write-Host "  [warn] $name (launcher, pid=$pidValue) is still running"
            $remaining[$name] = @{
                pid = $pidValue
                port = [int]$entry.port
                startedAt = [string]$entry.startedAt
            }
            $script:failures += 1
        }
    }
    if ($remaining.Count -eq 0) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    } else {
        $payload = @{
            version = 1
            updatedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
            services = $remaining
        }
        $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Path -Encoding UTF8
    }
}

Write-Host ""
Write-Host "--- processes ---"

$launcherState = Get-LauncherState -Path $statePath
$launcherPorts = @()
if ($null -ne $launcherState -and $null -ne $launcherState.services) {
    foreach ($prop in $launcherState.services.PSObject.Properties) {
        if ($null -ne $prop.Value.port) {
            $launcherPorts += [int]$prop.Value.port
        }
    }
}

# App (node started by start.bat)
Stop-ByCommandLine -Label "app (node)" -Name "node.exe" -Patterns @("*dist\backend\index.js*", "*dist/backend/index.js*")
# Orphaned ffplay (playback leftovers). Recording ffmpeg is left alone: it ends by itself with -t.
Stop-ByCommandLine -Label "ffplay (leftover)" -Name "ffplay.exe" -Patterns @("*")

if ($All) {
    # Manual RVC workers too. Recorded RVC entries are stopped by Stop-LauncherServices.
    Stop-ByCommandLine -Label "rvc worker (manual)" -Name "python.exe" -Patterns @("*rvc_worker.py*")
    Stop-ByCommandLine -Label "gpt-sovits api" -Name "python.exe" -Patterns @("*api_v2.py*")
    Stop-ByCommandLine -Label "voicevox" -Name "VOICEVOX.exe" -Patterns @("*")
}

Stop-LauncherServices -State $launcherState -Path $statePath -PatternsByService $launcherPatterns

# Wait briefly for ports to be released (LISTEN gone, not TIME_WAIT).
Start-Sleep -Milliseconds 800

Write-Host ""
Write-Host "--- ports ---"
$ports = @($Port) + $launcherPorts
if ($All) {
    $ports += $RvcPort
    $ports += 9880
    $ports += 50021
}
$ports = $ports | Select-Object -Unique
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
