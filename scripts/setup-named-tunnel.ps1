# Create a Cloudflare named tunnel so the relay has a FIXED URL.
# Run (Admin PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\setup-named-tunnel.ps1 -HostFqdn relay.yourdomain.com
# ASCII-only on purpose: Windows PowerShell 5.1 mis-decodes non-BOM UTF-8 .ps1.
param([Parameter(Mandatory = $true)][string]$HostFqdn)
$ErrorActionPreference = 'Stop'

$NAME = 'claudebot-relay'
$PORT = 9877

# --- locate cloudflared ---
$cf = $null
$gc = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($gc) { $cf = $gc.Source }
if (-not $cf) {
  $local = Join-Path (Split-Path -Parent $PSScriptRoot) 'cloudflared.exe'
  if (Test-Path $local) { $cf = $local }
}
if (-not $cf) {
  Write-Host 'cloudflared not found. Install: winget install --id Cloudflare.cloudflared' -ForegroundColor Red
  exit 1
}
Write-Host "cloudflared: $cf"

Write-Host ''
Write-Host '==> 1/5 Cloudflare login (browser opens; authorize your domain zone)'
& $cf tunnel login

Write-Host ''
Write-Host "==> 2/5 create tunnel: $NAME"
$list = (& $cf tunnel list) 2>$null
if ($list -match $NAME) { Write-Host '  exists, reuse' } else { & $cf tunnel create $NAME }

$row = (& $cf tunnel list | Select-String $NAME | Select-Object -First 1).ToString().Trim()
$uuid = ($row -split '\s+')[0]
$creds = Join-Path $env:USERPROFILE ".cloudflared\$uuid.json"
Write-Host "  UUID:  $uuid"
Write-Host "  creds: $creds"

Write-Host ''
Write-Host "==> 3/5 route DNS: $HostFqdn"
& $cf tunnel route dns $NAME $HostFqdn

$cfgDir = Join-Path $env:USERPROFILE '.cloudflared'
$cfg = Join-Path $cfgDir 'config.yml'
$yml = "tunnel: $uuid`ncredentials-file: $creds`ningress:`n  - hostname: $HostFqdn`n    service: http://localhost:$PORT`n  - service: http_status:404`n"
Set-Content -Path $cfg -Value $yml -Encoding ascii
Write-Host ''
Write-Host "==> 4/5 wrote config: $cfg"

Write-Host ''
Write-Host '==> 5/5 start the tunnel (pick one):' -ForegroundColor Cyan
Write-Host "   foreground test:  cloudflared tunnel run $NAME"
Write-Host '   install service:  cloudflared service install ; Start-Service cloudflared'
Write-Host ''
Write-Host 'When the tunnel is up, tell Claude "done" -- it will set .env + restart.' -ForegroundColor Green
Write-Host "   (RELAY_TUNNEL=false ; RELAY_PUBLIC_URL=wss://$HostFqdn)"
