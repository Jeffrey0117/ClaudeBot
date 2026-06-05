# 建立 Cloudflare named tunnel,讓 relay 有固定網址(你自己的子網域)。
# 系統管理員 PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-named-tunnel.ps1 -HostFqdn relay.你的網域
param([Parameter(Mandatory = $true)][string]$HostFqdn)
$ErrorActionPreference = 'Stop'

$NAME      = 'claudebot-relay'
$HOST_FQDN = $HostFqdn
$PORT      = 9877

# --- locate cloudflared ---
$cf = $null
$gc = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($gc) { $cf = $gc.Source }
if (-not $cf) {
  $local = Join-Path (Split-Path -Parent $PSScriptRoot) 'cloudflared.exe'
  if (Test-Path $local) { $cf = $local }
}
if (-not $cf) {
  Write-Host '找不到 cloudflared。先裝: winget install --id Cloudflare.cloudflared' -ForegroundColor Red
  exit 1
}
Write-Host "cloudflared: $cf"

# --- 1. login (opens browser; pick the isnowfriend.com zone) ---
Write-Host "`n==> 1/5 登入 Cloudflare(瀏覽器會開,選你的網域 zone 授權)"
& $cf tunnel login

# --- 2. create tunnel (skip if exists) ---
Write-Host "`n==> 2/5 建立 tunnel: $NAME"
$list = (& $cf tunnel list) 2>$null
if ($list -match $NAME) { Write-Host "  已存在,沿用" } else { & $cf tunnel create $NAME }

# --- 3. resolve UUID + creds file ---
$row = (& $cf tunnel list | Select-String $NAME | Select-Object -First 1).ToString().Trim()
$uuid = ($row -split '\s+')[0]
$creds = Join-Path $env:USERPROFILE ".cloudflared\$uuid.json"
Write-Host "  UUID: $uuid"
Write-Host "  creds: $creds"

# --- 4. route DNS ---
Write-Host "`n==> 3/5 綁定 DNS: $HOST_FQDN"
& $cf tunnel route dns $NAME $HOST_FQDN

# --- 5. write config.yml ---
$cfgDir = Join-Path $env:USERPROFILE '.cloudflared'
$cfg = Join-Path $cfgDir 'config.yml'
@"
tunnel: $uuid
credentials-file: $creds
ingress:
  - hostname: $HOST_FQDN
    service: http://localhost:$PORT
  - service: http_status:404
"@ | Set-Content -Path $cfg -Encoding utf8
Write-Host "`n==> 4/5 寫好 config: $cfg"

Write-Host "`n==> 5/5 啟動 tunnel(二選一):" -ForegroundColor Cyan
Write-Host "   前景測試:  cloudflared tunnel run $NAME"
Write-Host "   常駐服務:  cloudflared service install ; Start-Service cloudflared"
Write-Host ""
Write-Host "tunnel 跑起來後,跟 Claude 說一聲 — 我會把 .env 改成固定網址 + 重啟。" -ForegroundColor Green
Write-Host "(RELAY_TUNNEL=false ; RELAY_PUBLIC_URL=wss://$HOST_FQDN)"
