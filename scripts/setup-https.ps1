# HTTPS 用の証明書を mkcert で生成する（`certs/server.crt` / `certs/server.key`）。
#
# ブラウザのマイク（getUserMedia）は secure context（https か localhost）でのみ動くため、
# LAN の IP でこのアプリを開くには HTTPS が必要。
#
# 使い方:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-https.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\setup-https.ps1 -Force       # 作り直す
#   powershell -ExecutionPolicy Bypass -File scripts\setup-https.ps1 -Ip 192.168.1.50
param(
    [switch]$Force,
    [string[]]$Ip
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 案内文で使う実効ポートを解決する（PORT > [server] port > 3000）。失敗時は 3000。
$appPort = 3000
try {
    $portText = (& node (Join-Path $PSScriptRoot "resolve-port.js") 2>$null | Out-String).Trim()
    if ($portText -match '^\d+$') { $appPort = [int]$portText }
} catch {
}

function Resolve-Mkcert {
    $cmd = Get-Command mkcert -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $links = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\mkcert.exe"
    if (Test-Path $links) { return $links }
    $packages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    if (Test-Path $packages) {
        $found = Get-ChildItem $packages -Filter "mkcert*.exe" -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    return $null
}

$mkcert = Resolve-Mkcert
if (-not $mkcert) {
    Write-Host "[https] mkcert が見つかりません。次のどちらかで入れてください:" -ForegroundColor Yellow
    Write-Host "         winget install FiloSottile.mkcert"
    Write-Host "         https://github.com/FiloSottile/mkcert/releases"
    exit 1
}
Write-Host "[https] mkcert: $mkcert"

$certs = Join-Path $root "certs"
$certFile = Join-Path $certs "server.crt"
$keyFile = Join-Path $certs "server.key"

if ((Test-Path $certFile) -and (Test-Path $keyFile) -and -not $Force) {
    Write-Host "[https] 既に証明書があります（作り直すには -Force）: $certFile"
} else {
    New-Item -ItemType Directory -Force -Path $certs | Out-Null

    $caFile = Join-Path $env:LOCALAPPDATA "mkcert\rootCA.pem"
    if (-not (Test-Path $caFile)) {
        Write-Host "[https] ローカル CA を作成します（mkcert -install）"
        & $mkcert -install
    }

    $hosts = @("localhost", "127.0.0.1", "::1")
    if ($env:COMPUTERNAME) { $hosts += $env:COMPUTERNAME }
    if ($Ip) {
        $hosts += $Ip
    } else {
        $hosts += Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object {
                $_.IPAddress -notlike "127.*" -and
                $_.IPAddress -notlike "169.254.*" -and
                $_.InterfaceAlias -notlike "*WSL*" -and
                $_.InterfaceAlias -notlike "*Loopback*"
            } |
            Select-Object -ExpandProperty IPAddress
    }
    $hosts = @($hosts | Where-Object { $_ } | Select-Object -Unique)

    Write-Host "[https] 証明書を作成します: $($hosts -join ', ')"
    & $mkcert -cert-file $certFile -key-file $keyFile @hosts
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[https] 証明書の作成に失敗しました" -ForegroundColor Red
        exit 1
    }
}

$caRoot = & $mkcert -CAROOT

Write-Host ""
Write-Host "[https] 完了: $certFile" -ForegroundColor Green
Write-Host ""
Write-Host "次の手順:" -ForegroundColor Cyan
Write-Host "  1. .\start.bat で起動（https://localhost:$appPort が開きます）"
Write-Host "  2. 他の PC / スマホからは https://<このPCのIP>:$appPort で開く"
Write-Host "  3. 他の端末で証明書の警告が出る場合は、次の CA を配布して信頼してください:"
Write-Host "       $caRoot\rootCA.pem"
Write-Host "     - Windows: rootCA.pem を開く → 証明書のインストール → 「信頼されたルート証明機関」"
Write-Host "     - iPhone/iPad: rootCA.pem を転送 → 設定 > 一般 > VPN とデバイス管理 でインストール"
Write-Host "       → 設定 > 一般 > 情報 > 証明書信頼設定 で有効化"
