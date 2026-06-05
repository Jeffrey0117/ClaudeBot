# 產生 ClaudeBot 自簽 code-signing 憑證,並在「本機(build 機)」信任它。
# 用法(系統管理員 PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\setup-codesign.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dir  = Join-Path $root '.codesign'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$pfx  = Join-Path $dir 'codesign.pfx'
$cer  = Join-Path $dir 'codesign.cer'
$pass = ConvertTo-SecureString 'claudebot' -AsPlainText -Force

Write-Host '==> 產生自簽 code-signing 憑證 (10 年)'
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject 'CN=ClaudeBot Self-Signed' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyUsage DigitalSignature `
  -KeyExportPolicy Exportable `
  -KeyAlgorithm RSA -KeyLength 2048 `
  -NotAfter (Get-Date).AddYears(10)

Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pass | Out-Null
Export-Certificate    -Cert $cert -FilePath $cer | Out-Null
Write-Host "  pfx (簽章用,勿外流): $pfx"
Write-Host "  cer (公開,拿去遠端信任): $cer"

Write-Host '==> 在本機信任(Root + TrustedPublisher)'
Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\LocalMachine\TrustedPublisher' | Out-Null

Write-Host ''
Write-Host '完成 ✅'
Write-Host '  打包簽章:  npm run pack:signed'
Write-Host '  遠端機器:  複製 .codesign\codesign.cer 過去 → 跑 scripts\trust-cert.ps1(系統管理員)'
