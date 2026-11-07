$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$env:ETHERE_DATA_DIR = Join-Path $projectRoot 'local-data'
& node (Join-Path $PSScriptRoot 'boss-browser-session.mjs')
if ($LASTEXITCODE -ne 0) { throw 'BOSS 专用登录尚未完成。请返回专用浏览器窗口继续验证。' }
