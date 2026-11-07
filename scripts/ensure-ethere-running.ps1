param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$dataRoot = Join-Path $projectRoot 'local-data'
$lockFile = Join-Path $dataRoot 'runtime\watchdog.pid'
$watchdogPath = Join-Path $PSScriptRoot 'watchdog.mjs'
$serverPath = Join-Path $PSScriptRoot 'serve.mjs'

function Get-ListenerPid([int]$port) {
  $listenerLines = @(netstat -ano -p tcp | Select-String "^\s*TCP\s+127\.0\.0\.1:$port\s+\S+\s+LISTENING\s+(\d+)")
  $ids = @($listenerLines | ForEach-Object { [int]$_.Matches[0].Groups[1].Value } | Sort-Object -Unique)
  if ($ids.Count -gt 1) { throw "端口 $port 有多个监听进程；拒绝判断实例身份。" }
  if ($ids.Count) { return $ids[0] }
  return 0
}

function Get-VerifiedProcess([int]$id, [string]$script) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction Stop
  if (-not $process -or -not $process.CommandLine -or
      $process.CommandLine.IndexOf($script, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "PID $id 不是预期脚本 $script；拒绝启动第二实例。"
  }
  return $process
}

$watchdogId = 0
if (Test-Path -LiteralPath $lockFile) {
  $rawId = (Get-Content -LiteralPath $lockFile -Raw).Trim()
  if ($rawId -notmatch '^\d+$') { throw '看门狗锁文件内容无效；拒绝自动覆盖。' }
  $watchdogId = [int]$rawId
  if (Get-Process -Id $watchdogId -ErrorAction SilentlyContinue) {
    $null = Get-VerifiedProcess $watchdogId $watchdogPath
  } else { $watchdogId = 0 }
}

$listenerId = Get-ListenerPid 4173
if ($listenerId) {
  if (-not $watchdogId) { throw "4173 已由 PID $listenerId 监听，但当前项目没有活看门狗；拒绝启动。" }
  $server = Get-VerifiedProcess $listenerId $serverPath
  if ($server.ParentProcessId -ne $watchdogId) {
    throw "4173 的服务 PID $listenerId 不是当前看门狗 PID $watchdogId 的子进程；拒绝启动。"
  }
  $health = Invoke-RestMethod 'http://127.0.0.1:4173/api/ethere/v1/health' -TimeoutSec 3
  if ($health.instance -and ($health.instance.pid -ne $listenerId -or
      -not [string]::Equals([IO.Path]::GetFullPath($health.instance.dataRoot), $dataRoot, [StringComparison]::OrdinalIgnoreCase))) {
    throw '4173 健康响应的 PID 或数据目录与监听进程不符。'
  }
  if (-not $health.instance) {
    throw '4173 未提供实例身份；拒绝把旧健康响应视为已验证的新服务。'
  }
  if ($CheckOnly) { [pscustomobject]@{ state = 'running'; watchdogPid = $watchdogId; listenerPid = $listenerId; dataRoot = $dataRoot } }
  return
}

if ($watchdogId) {
  if ($CheckOnly) { [pscustomobject]@{ state = 'starting'; watchdogPid = $watchdogId; listenerPid = 0; dataRoot = $dataRoot } }
  return
}

$legacyLock = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'Ethere\data\runtime\watchdog.pid'
if (Test-Path -LiteralPath $legacyLock) {
  $legacyId = (Get-Content -LiteralPath $legacyLock -Raw).Trim()
  if ($legacyId -match '^\d+$' -and (Get-Process -Id ([int]$legacyId) -ErrorAction SilentlyContinue)) {
    throw "发现旧数据目录的活动看门狗 PID $legacyId；拒绝启动并串库。"
  }
}

if ($CheckOnly) { [pscustomobject]@{ state = 'stopped'; watchdogPid = 0; listenerPid = 0; dataRoot = $dataRoot }; return }

$nodePath = (Get-Command node -ErrorAction Stop).Source
$env:ETHERE_DATA_DIR = $dataRoot
$userProfilePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if (-not $userProfilePath -or -not (Test-Path -LiteralPath $userProfilePath -PathType Container)) {
  throw '无法确认当前用户的主目录；拒绝启动无法连接 Codex 的实例。'
}
$env:USERPROFILE = $userProfilePath
$env:HOME = $userProfilePath
$codexRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'OpenAI\Codex\bin'
$codexCommand = Get-ChildItem -LiteralPath $codexRoot -Filter 'codex.exe' -File -Recurse -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($codexCommand) { $env:ETHERE_CODEX_COMMAND = $codexCommand.FullName }
Start-Process -FilePath $nodePath -ArgumentList @($watchdogPath) -WorkingDirectory $projectRoot -WindowStyle Hidden
