# 每日本机选品（方案 B：只走搜索结果，不碰 1688 详情页，无验证码）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\run-daily.ps1
# 手动试跑：powershell -ExecutionPolicy Bypass -File scripts\run-daily.ps1 -Limit 3

param(
  [int]$Limit = 5,
  [string]$Keywords = ""
)

$ErrorActionPreference = 'Continue'

# ===== 这两个值必须与线上一致 =====
$env:SITE_URL   = 'https://asi-workbench.onrender.com'
$env:SYNC_TOKEN = '9a525e5fc728652fb27f517c47ea8312c9eec436291ef3c1'
# =================================

$env:LIMIT    = "$Limit"
$env:KEYWORDS = $Keywords
$env:NO_DETAIL = '1'

$repo   = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("run-" + (Get-Date -Format 'yyyyMMdd') + ".log")

Push-Location $repo
try {
  "===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 开始（limit=$Limit）=====" | Tee-Object -FilePath $logFile -Append
  node scripts\daily-sourcing.mjs 2>&1 | Tee-Object -FilePath $logFile -Append
  "===== $(Get-Date -Format 'HH:mm:ss') 结束（退出码 $LASTEXITCODE）=====" | Tee-Object -FilePath $logFile -Append
} finally {
  Pop-Location
}
