param([switch]$Force)

# Cubism Core（Live2D 公式 CDN）を vendor/live2d へ取得する。
# - ライセンスのため vendor/ は gitignore（再配布しない）
# - 既にある場合は -Force を付けたときだけ上書きする
$ErrorActionPreference = "Stop"

# PowerShell 5.1 では TLS 1.2 を明示する
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  # 既に有効な場合は無視する
}

$root = Split-Path -Parent $PSScriptRoot
$destDir = Join-Path $root "vendor\live2d"
$dest = Join-Path $destDir "live2dcubismcore.min.js"
$url = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"

if ((Test-Path -LiteralPath $dest) -and -not $Force) {
  Write-Host "Cubism Core は既にあります: $dest（更新するには -Force）"
  exit 0
}

New-Item -ItemType Directory -Force -Path $destDir | Out-Null
Write-Host "Cubism Core をダウンロードしています: $url"
Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing

$size = (Get-Item -LiteralPath $dest).Length
if ($size -lt 100000) {
  Remove-Item -LiteralPath $dest -Force
  throw "ダウンロードした Cubism Core が小さすぎます（$size bytes）。手動で配置してください: $dest"
}

Write-Host "配置しました: vendor\live2d\live2dcubismcore.min.js ($size bytes)"
Write-Host "Live2D を使うには config\settings.toml の [avatar] model_path を Live2DModels/hiyori_vts/hiyori.model3.json にしてください。"

