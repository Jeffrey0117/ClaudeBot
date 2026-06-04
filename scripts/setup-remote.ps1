# ============================================================
# ClaudeBot 遠端機器一鍵設定
#   在「被操控的那台電腦」上跑一次,讓它具備瀏覽器操作能力
#   (agent-browser / bv 遠端操作需要的 CLI)。
#
# 用法(在遠端那台 PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\setup-remote.ps1
# 或直接右鍵「以 PowerShell 執行」。
# ============================================================

$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }

Step "1/3 檢查 Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Warn "沒有 Node.js — 嘗試用 winget 安裝 (OpenJS.NodeJS.LTS)..."
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Warn "Node 裝好後,請『關掉這個視窗、重開 PowerShell』再跑一次本腳本(讓 PATH 生效)。"
    exit 0
  } else {
    Warn "這台沒有 winget。請手動安裝 Node.js LTS: https://nodejs.org/ 然後重跑本腳本。"
    exit 1
  }
} else {
  Ok "Node $(node --version)"
}

Step "2/3 安裝 agent-browser (全域)"
$ab = Get-Command agent-browser -ErrorAction SilentlyContinue
if ($ab) {
  Ok "agent-browser 已安裝 ($($ab.Source))"
} else {
  npm install -g agent-browser
  $ab = Get-Command agent-browser -ErrorAction SilentlyContinue
  if ($ab) { Ok "agent-browser 安裝完成" } else { Warn "安裝後仍找不到 agent-browser — 確認 npm 全域 bin 在 PATH 上"; exit 1 }
}

Step "3/3 驗證"
try {
  $v = & agent-browser --version 2>$null
  Ok "agent-browser 可執行: $v"
} catch {
  Warn "agent-browser 無法執行: $_"
  exit 1
}

Write-Host "`n完成!這台已具備瀏覽器操作能力。回主機重新配對(或重連)即可從遠端用 bv / ab_ 工具操作。" -ForegroundColor Green
Write-Host "提示:agent-browser 會連你已開的 Chrome(CDP);若要無頭模式,讓它自己開瀏覽器即可。" -ForegroundColor DarkGray
