# 在「被控制/遠端機器」上信任 ClaudeBot 自簽憑證,簽過的 exe 就不再被擋。
# 把 codesign.cer 跟這個腳本放一起(或放專案 .codesign\),然後系統管理員執行:
#   powershell -ExecutionPolicy Bypass -File trust-cert.ps1
$ErrorActionPreference = 'Stop'

$cer = Join-Path $PSScriptRoot 'codesign.cer'
if (-not (Test-Path $cer)) { $cer = Join-Path $PSScriptRoot '..\.codesign\codesign.cer' }
if (-not (Test-Path $cer)) {
  Write-Host "找不到 codesign.cer — 請把它複製到這個腳本旁邊。" -ForegroundColor Red
  exit 1
}

Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\LocalMachine\TrustedPublisher' | Out-Null
Write-Host '已信任 ClaudeBot 自簽憑證 ✅ — 簽過的 exe 現在被視為信任發行者。' -ForegroundColor Green
