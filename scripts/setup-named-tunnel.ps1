# Create a Cloudflare named tunnel so the relay has a FIXED URL.
# Run (Admin PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\setup-named-tunnel.ps1 -HostFqdn relay.yourdomain.com
# ASCII-only + ErrorActionPreference=Continue: Windows PowerShell 5.1 mis-decodes
# non-BOM UTF-8, and treats native-exe stderr (cloudflared warnings) as errors.
param([Parameter(Mandatory = $true)][string]$HostFqdn)
$ErrorActionPreference = 'Continue'

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
if (-not $cf) { Write-Host 'cloudflared not found. winget install --id Cloudflare.cloudflared' -ForegroundColor Red; exit 1 }
Write-Host "cloudflared: $cf"

# --- 1. login (skip if already authed) ---
$cert = Join-Path $env:USERPROFILE '.cloudflared\cert.pem'
if (Test-Path $cert) {
  Write-Host "==> 1/5 already logged in (cert.pem exists), skip"
} else {
  Write-Host "==> 1/5 Cloudflare login (browser opens; authorize your domain zone)"
  & $cf tunnel login 2>&1 | Out-String | Write-Host
}

# --- 2. create tunnel (skip if exists) ---
Write-Host "==> 2/5 create tunnel: $NAME"
$listOut = (& $cf tunnel list 2>&1 | Out-String)
if ($listOut -notmatch [regex]::Escape($NAME)) {
  (& $cf tunnel create $NAME 2>&1 | Out-String) | Write-Host
  $listOut = (& $cf tunnel list 2>&1 | Out-String)
} else {
  Write-Host "  exists, reuse"
}

# --- 3. resolve UUID from the row that contains the tunnel name ---
$uuid = $null
foreach ($line in ($listOut -split "`r?`n")) {
  if ($line -match [regex]::Escape($NAME)) {
    $m = [regex]::Match($line, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
    if ($m.Success) { $uuid = $m.Value; break }
  }
}
if (-not $uuid) { Write-Host "  could not find tunnel UUID. `n$listOut" -ForegroundColor Red; exit 1 }
$creds = Join-Path $env:USERPROFILE ".cloudflared\$uuid.json"
Write-Host "  UUID:  $uuid"
Write-Host "  creds: $creds"

# --- 4. route DNS ---
Write-Host "==> 3/5 route DNS: $HostFqdn"
(& $cf tunnel route dns $NAME $HostFqdn 2>&1 | Out-String) | Write-Host

# --- 5. write config.yml ---
$cfg = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
$yml = "tunnel: $uuid`ncredentials-file: $creds`ningress:`n  - hostname: $HostFqdn`n    service: http://localhost:$PORT`n  - service: http_status:404`n"
Set-Content -Path $cfg -Value $yml -Encoding ascii
Write-Host "==> 4/5 wrote config: $cfg"

Write-Host ""
Write-Host "==> 5/5 start the tunnel (pick one):" -ForegroundColor Cyan
Write-Host "   foreground:  cloudflared tunnel run $NAME"
Write-Host "   as service:  cloudflared service install ; Start-Service cloudflared"
Write-Host ""
Write-Host "When the tunnel is up, tell Claude 'done' -- it sets .env + restarts." -ForegroundColor Green
Write-Host "   (RELAY_TUNNEL=false ; RELAY_PUBLIC_URL=wss://$HostFqdn)"
