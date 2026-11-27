# Start GPT-SoVITS and RVC worker for `start.bat /all`.
# ASCII only: Windows PowerShell 5.1 may misread BOM-less UTF-8.
param([switch]$FunctionsOnly)

$ErrorActionPreference = "Continue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$statePath = Join-Path $repoRoot "logs\start-all.state.json"

$timeoutSeconds = 180
if ($env:START_ALL_TIMEOUT) {
    $parsed = 0
    if ([int]::TryParse($env:START_ALL_TIMEOUT, [ref]$parsed) -and $parsed -ge 10) {
        $timeoutSeconds = $parsed
    }
}

$patternsByService = @{
    "gpt-sovits" = @("*start-gpt-sovits.bat*", "*api_v2.py*")
    "rvc-worker" = @("*start-rvc-worker.bat*", "*rvc_worker.py*")
}

function Test-HttpReady {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return ($response.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Get-ServiceProcess {
    param([string[]]$Patterns)
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $cmd = $_.CommandLine
        $null -ne $cmd -and ($Patterns | Where-Object { $cmd -like $_ })
    })
}

function Test-ProcessAlive {
    param([int]$ProcessId)
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    return ($null -ne $proc)
}

function Test-ProcessMatches {
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

function Read-State {
    param([string]$Path)
    $state = @{ version = 1; services = @{} }
    if (-not (Test-Path -LiteralPath $Path)) {
        return $state
    }
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        $obj = $raw | ConvertFrom-Json
        if ($null -ne $obj.services) {
            foreach ($prop in $obj.services.PSObject.Properties) {
                $state.services[$prop.Name] = @{
                    pid = [int]$prop.Value.pid
                    port = [int]$prop.Value.port
                    startedAt = [string]$prop.Value.startedAt
                }
            }
        }
    } catch {
        Write-Host "[all] warning: state file is unreadable; recreating it"
    }
    return $state
}

function Write-State {
    param([string]$Path, [hashtable]$State)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $payload = @{
        version = 1
        updatedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
        services = $State.services
    }
    $json = $payload | ConvertTo-Json -Depth 5
    $temp = "$Path.tmp"
    Set-Content -LiteralPath $temp -Value $json -Encoding UTF8 -ErrorAction Stop
    Move-Item -LiteralPath $temp -Destination $Path -Force -ErrorAction Stop
}

function Remove-StaleEntries {
    param([hashtable]$State, [hashtable]$PatternsByService)
    foreach ($name in @($State.services.Keys)) {
        $entry = $State.services[$name]
        $patterns = $PatternsByService[$name]
        if ($null -eq $patterns) {
            Write-Host "[all] removing unknown state entry: $name"
            $State.services.Remove($name)
            continue
        }
        if (-not (Test-ProcessMatches -ProcessId ([int]$entry.pid) -Patterns $patterns)) {
            Write-Host "[all] removing stale state entry: $name (pid=$($entry.pid))"
            $State.services.Remove($name)
        }
    }
}

function Test-Preflight {
    param([string]$Name, [string[]]$Paths)
    foreach ($path in $Paths) {
        if (-not (Test-Path -LiteralPath $path)) {
            Write-Host "[all] ${Name}: preflight failed (missing: $path)"
            return $false
        }
    }
    return $true
}

function Ensure-ServiceReady {
    param(
        [string]$Name,
        [string]$Url,
        [string[]]$Patterns,
        [string]$BatPath,
        [string]$WorkingDirectory,
        [string[]]$PreflightPaths,
        [int]$TimeoutSeconds,
        [hashtable]$State,
        [string]$StatePath,
        [string]$ServiceKey,
        [int]$Port
    )

    if (Test-HttpReady -Url $Url) {
        Write-Host "[all] ${Name}: already ready"
        return @{ Status = "ready"; Started = $false; Pid = $null; Warm = $null }
    }

    $existing = @(Get-ServiceProcess -Patterns $Patterns)
    $started = $false
    $servicePid = $null

    if ($existing.Count -gt 0) {
        $servicePid = [int]$existing[0].ProcessId
        Write-Host "[all] ${Name}: waiting (already starting, pid=$servicePid)"
    } else {
        if (-not (Test-Preflight -Name $Name -Paths $PreflightPaths)) {
            return @{ Status = "missing"; Started = $false; Pid = $null; Warm = $null }
        }
        Write-Host "[all] ${Name}: starting..."
        try {
            $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$BatPath`"" -WorkingDirectory $WorkingDirectory -PassThru -ErrorAction Stop
        } catch {
            Write-Host "[all] ${Name}: failed to start: $($_.Exception.Message)"
            return @{ Status = "error"; Started = $false; Pid = $null; Warm = $null }
        }
        $servicePid = [int]$proc.Id
        $started = $true
        $State.services[$ServiceKey] = @{
            pid = $servicePid
            port = $Port
            startedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
        }
        try {
            Write-State -Path $StatePath -State $State
        } catch {
            Write-Host "[all] ${Name}: failed to record state; this service will not be auto-stopped: $($_.Exception.Message)"
        }
    }

    $startTime = Get-Date
    $deadline = $startTime.AddSeconds($TimeoutSeconds)
    $lastProgress = $startTime

    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (Test-HttpReady -Url $Url) {
            $elapsed = [int]((Get-Date) - $startTime).TotalSeconds
            $warm = $null
            if ($Url -like "*/health") {
                try {
                    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
                    $health = $response.Content | ConvertFrom-Json
                    if ($null -ne $health.warm) {
                        $warm = [bool]$health.warm
                    }
                } catch {
                    $warm = $null
                }
            }
            Write-Host "[all] ${Name}: ready in ${elapsed}s (pid=$servicePid)"
            if ($Url -like "*/health" -and $warm -eq $false) {
                Write-Host "[all] ${Name}: ready but warm=false (first conversion may be slow)"
            }
            return @{ Status = "ready"; Started = $started; Pid = $servicePid; Warm = $warm }
        }
        if (-not (Test-ProcessAlive -ProcessId $servicePid)) {
            Write-Host "[all] ${Name}: process exited before becoming ready"
            if ($State.services.ContainsKey($ServiceKey)) {
                $State.services.Remove($ServiceKey)
                try { Write-State -Path $StatePath -State $State } catch { }
            }
            return @{ Status = "exited"; Started = $started; Pid = $servicePid; Warm = $null }
        }
        $now = Get-Date
        if (($now - $lastProgress).TotalSeconds -ge 10) {
            $elapsed = [int]($now - $startTime).TotalSeconds
            Write-Host "[all] ${Name}: waiting... ${elapsed}s/${TimeoutSeconds}s"
            $lastProgress = $now
        }
    }

    Write-Host "[all] ${Name}: not ready after ${TimeoutSeconds}s"
    return @{ Status = "timeout"; Started = $started; Pid = $servicePid; Warm = $null }
}

if (-not $FunctionsOnly) {
    try {
        $state = Read-State -Path $statePath
        $beforeCount = $state.services.Count
        Remove-StaleEntries -State $state -PatternsByService $patternsByService
        if ($state.services.Count -ne $beforeCount) {
            Write-State -Path $statePath -State $state
        }

        $gsvHome = $env:GPT_SOVITS_HOME
        if (-not $gsvHome) {
            $gsvHome = "D:\LLMProjects\GPT-SoVITS"
        }
        $gsvPaths = @(
            (Join-Path $gsvHome "api_v2.py"),
            (Join-Path $gsvHome ".venv-gsv\Scripts\python.exe")
        )
        Ensure-ServiceReady `
            -Name "GPT-SoVITS (9880)" `
            -Url "http://127.0.0.1:9880/docs" `
            -Patterns $patternsByService["gpt-sovits"] `
            -BatPath (Join-Path $repoRoot "scripts\start-gpt-sovits.bat") `
            -WorkingDirectory $repoRoot `
            -PreflightPaths $gsvPaths `
            -TimeoutSeconds $timeoutSeconds `
            -State $state `
            -StatePath $statePath `
            -ServiceKey "gpt-sovits" `
            -Port 9880 | Out-Null

        $rvcRoot = $env:RVC_WARMUP_ROOT
        if (-not $rvcRoot) {
            $rvcRoot = "D:\LLMProjects\RVCMultilingual"
        }
        $rvcPaths = @(
            (Join-Path $rvcRoot "venv\Scripts\python.exe"),
            (Join-Path $repoRoot "scripts\rvc_worker.py")
        )
        Ensure-ServiceReady `
            -Name "RVC (9890)" `
            -Url "http://127.0.0.1:9890/health" `
            -Patterns $patternsByService["rvc-worker"] `
            -BatPath (Join-Path $repoRoot "scripts\start-rvc-worker.bat") `
            -WorkingDirectory $repoRoot `
            -PreflightPaths $rvcPaths `
            -TimeoutSeconds $timeoutSeconds `
            -State $state `
            -StatePath $statePath `
            -ServiceKey "rvc-worker" `
            -Port 9890 | Out-Null

        Write-Host "[all] continuing; check the service window for details"
        exit 0
    } catch {
        Write-Host "[all] error: $($_.Exception.Message)"
        exit 1
    }
}
