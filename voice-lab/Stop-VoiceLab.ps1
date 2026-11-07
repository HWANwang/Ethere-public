$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'runtime/server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Output '没有本实验室记录的后台进程。'
    exit 0
}

$labPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$process = Get-Process -Id $labPid -ErrorAction SilentlyContinue
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $labPid" -ErrorAction SilentlyContinue
$owner = Get-NetTCPConnection -LocalPort 4189 -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $labPid }
$serverPath = Join-Path $PSScriptRoot 'server.mjs'
if (-not $process -or $process.ProcessName -ne 'node' -or -not $owner -or -not $processInfo.CommandLine.Contains($serverPath)) {
    throw '记录的进程不再是占用 4189 的 Node 服务；为安全起见不会停止它。'
}

Stop-Process -Id $labPid -ErrorAction Stop
Remove-Item -LiteralPath $pidFile -Force
Write-Output 'Voice Lab 已停止；Ethere 未受影响。'
