$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $projectRoot 'local-data'
$profileRoot = Join-Path $dataRoot 'integrations\boss-cli\browser-profile'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path -LiteralPath $edge)) { throw '没有找到 Microsoft Edge，无法打开 BOSS 专用登录窗口。' }
try {
  $existing = Invoke-RestMethod 'http://127.0.0.1:9229/json/version' -TimeoutSec 2
  if ($existing) { throw '9229 端口已有浏览器占用；为避免读取别的浏览器，不会继续。' }
} catch {
  if ($_.Exception.Message -like '*已有浏览器占用*') { throw }
}
New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null
Start-Process -FilePath $edge -ArgumentList @('--user-data-dir=' + '"' + $profileRoot + '"', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9229', '--new-window', 'https://www.zhipin.com/web/geek/jobs') -WindowStyle Normal
Write-Host '请只在新打开的 BOSS 专用浏览器窗口中登录。完成后运行 scripts\finish-boss-login.ps1；无需发送密码或 Cookie。'
