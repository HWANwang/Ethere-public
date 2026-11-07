$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$dataRoot = Join-Path $projectRoot 'local-data'
$watchdogPath = Join-Path $PSScriptRoot 'watchdog.mjs'
$servePath = Join-Path $PSScriptRoot 'serve.mjs'
$memorySupervisorPath = Join-Path $PSScriptRoot 'memory-v2-supervisor.mjs'
$memoryServerPath = Join-Path $projectRoot 'memory-lab\src\server.mjs'
$embeddingPath = Join-Path $projectRoot 'memory-lab\vendor\llama.cpp\b12128\llama-server.exe'
$lockFile = Join-Path $dataRoot 'runtime\watchdog.pid'
$sessionFile = Join-Path $dataRoot 'state\chat-session.json'
$settingsFile = Join-Path $dataRoot 'config\settings.json'
$expectBridge = Test-Path -LiteralPath (Join-Path $PSScriptRoot 'developer-bridge.mjs')

function Get-ListenerPid([int]$port) {
  $lines = @(netstat -ano -p tcp | Select-String "^\s*TCP\s+127\.0\.0\.1:$port\s+\S+\s+LISTENING\s+(\d+)")
  $ids = @($lines | ForEach-Object { [int]$_.Matches[0].Groups[1].Value } | Sort-Object -Unique)
  if ($ids.Count -gt 1) { throw "端口 $port 有多个监听进程。" }
  if ($ids.Count) { return $ids[0] }
  return 0
}

function Get-VerifiedProcess([int]$id, [string]$script) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction Stop
  if (-not $process -or -not $process.CommandLine -or
      $process.CommandLine.IndexOf($script, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "PID $id 不是当前项目的 $script；没有停止任何进程。"
  }
  return $process
}

function Same-Path([string]$left, [string]$right) {
  if (-not $left -or -not $right) { return $false }
  return [string]::Equals([IO.Path]::GetFullPath($left), [IO.Path]::GetFullPath($right), [StringComparison]::OrdinalIgnoreCase)
}

$expectedSession = if (Test-Path -LiteralPath $sessionFile) { Get-Content -LiteralPath $sessionFile -Raw | ConvertFrom-Json } else { $null }
$expectedSettings = if (Test-Path -LiteralPath $settingsFile) { Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json } else { $null }
$legacyLock = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'Ethere\data\runtime\watchdog.pid'
if (Test-Path -LiteralPath $legacyLock) {
  $legacyId = (Get-Content -LiteralPath $legacyLock -Raw).Trim()
  if ($legacyId -match '^\d+$' -and (Get-Process -Id ([int]$legacyId) -ErrorAction SilentlyContinue)) {
    throw "发现旧数据目录的活动看门狗 PID $legacyId；没有停止任何进程。"
  }
}
$watchdogId = 0
if (Test-Path -LiteralPath $lockFile) {
  $rawId = (Get-Content -LiteralPath $lockFile -Raw).Trim()
  if ($rawId -notmatch '^\d+$') { throw '看门狗锁文件无效；没有停止任何进程。' }
  $watchdogId = [int]$rawId
  if (Get-Process -Id $watchdogId -ErrorAction SilentlyContinue) {
    $null = Get-VerifiedProcess $watchdogId $watchdogPath
  } else { $watchdogId = 0 }
}

$listenerId = Get-ListenerPid 4173
if ($listenerId) {
  if (-not $watchdogId) { throw "4173 正被 PID $listenerId 占用，但没有可验证的当前项目看门狗。" }
  $serve = Get-VerifiedProcess $listenerId $servePath
  if ($serve.ParentProcessId -ne $watchdogId) { throw '4173 监听者不是当前项目看门狗的子进程。' }
  $oldHealth = Invoke-RestMethod 'http://127.0.0.1:4173/api/ethere/v1/health' -TimeoutSec 3
  if ($oldHealth.instance -and ($oldHealth.instance.pid -ne $listenerId -or -not (Same-Path $oldHealth.instance.dataRoot $dataRoot))) {
    throw '4173 旧健康响应与监听进程或数据目录不符。'
  }
  $status = $null
  try { $status = Invoke-RestMethod 'http://127.0.0.1:4173/api/ethere/v1/runtime/status' -TimeoutSec 5 }
  catch {
    if ($oldHealth.runtimeConnected) { throw }
    Write-Warning '运行时未连接；仅凭已验证的进程、数据目录和本地会话继续恢复。'
  }
  if ($status) {
    if ($status.busy) { throw '当前 Ethere 正在处理消息；拒绝中断用户回合。' }
    if ($expectedSession.threadId -and $status.threadId -ne $expectedSession.threadId) {
      throw '4173 当前线程与 local-data 中的线程不符；拒绝重启。'
    }
    if ($expectedSettings.model -and $status.model -ne $expectedSettings.model) {
      throw '4173 当前模型与 local-data 中的模型不符；拒绝重启。'
    }
  }
} elseif ($watchdogId) {
  Write-Warning '当前项目看门狗仍在运行，但 4173 未监听；验证完整子进程树后恢复。'
}

if ($watchdogId) {
  # 必须先取得完整子进程快照，避免只杀看门狗后留下 Codex app-server。
  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $descendantIds = [Collections.Generic.HashSet[int]]::new()
  $queue = [Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($watchdogId)
  while ($queue.Count) {
    $parentId = $queue.Dequeue()
    foreach ($child in @($allProcesses | Where-Object { $_.ParentProcessId -eq $parentId })) {
      if ($descendantIds.Add([int]$child.ProcessId)) { $queue.Enqueue([int]$child.ProcessId) }
    }
  }
  foreach ($port in @(4174, 4189, 4191, 8180)) {
    $serviceId = Get-ListenerPid $port
    if ($serviceId -and -not $descendantIds.Contains($serviceId)) {
      throw "端口 $port 的 PID $serviceId 不属于已验证的看门狗进程树；拒绝重启，不能把孤儿服务误认作新服务。"
    }
  }
  & taskkill.exe /PID $watchdogId /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '进程树停止失败；没有启动新实例。' }
  $trackedIds = @($watchdogId) + @($descendantIds | ForEach-Object { $_ })
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $remaining = @($trackedIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    $occupied = @(@(4173, 4174, 4189, 4191, 8180) | Where-Object { Get-ListenerPid $_ })
    if (-not $remaining.Count -and -not $occupied.Count) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($remaining.Count -or $occupied.Count) {
    throw '旧实例、其子进程或相关端口未全部退出；拒绝启动，避免孤儿 app-server 或双实例。'
  }
}

& (Join-Path $PSScriptRoot 'ensure-ethere-running.ps1')
$healthy = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  Start-Sleep -Seconds 1
  try {
    $newWatchdogId = [int](Get-Content -LiteralPath $lockFile -Raw).Trim()
    $null = Get-VerifiedProcess $newWatchdogId $watchdogPath
    $newListenerId = Get-ListenerPid 4173
    if (-not $newListenerId) { continue }
    $newServe = Get-VerifiedProcess $newListenerId $servePath
    if ($newServe.ParentProcessId -ne $newWatchdogId) { throw '新监听者不属于新看门狗。' }
    $health = Invoke-RestMethod 'http://127.0.0.1:4173/api/ethere/v1/health' -TimeoutSec 3
    if (-not $health.serverConnected -or -not $health.runtimeConnected -or
        $health.instance.pid -ne $newListenerId -or -not (Same-Path $health.instance.dataRoot $dataRoot)) {
      throw '新健康响应的服务身份、数据目录或运行时不符。'
    }
    $status = Invoke-RestMethod 'http://127.0.0.1:4173/api/ethere/v1/runtime/status' -TimeoutSec 3
    if ($expectedSession.threadId -and $status.threadId -ne $expectedSession.threadId) { throw '新线程 ID 与重启前不符。' }
    if ($expectedSettings.model -and $status.model -ne $expectedSettings.model) { throw '新模型与重启前不符。' }
    if ($expectBridge) {
      $bridge = Invoke-RestMethod 'http://127.0.0.1:4174/health' -TimeoutSec 3
      if (-not $bridge.connected) { continue }
    }
    $supervisor = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $_.ParentProcessId -eq $newWatchdogId -and $_.CommandLine -and
      $_.CommandLine.IndexOf($memorySupervisorPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($supervisor.Count -ne 1) { throw '新记忆服务监督器并非当前看门狗的唯一子进程。' }
    $memoryId = Get-ListenerPid 4191
    $embeddingId = Get-ListenerPid 8180
    if (-not $memoryId -or -not $embeddingId) { continue }
    $memory = Get-VerifiedProcess $memoryId $memoryServerPath
    $embedding = Get-VerifiedProcess $embeddingId $embeddingPath
    if ($memory.ParentProcessId -ne $supervisor[0].ProcessId -or $embedding.ParentProcessId -ne $supervisor[0].ProcessId) {
      throw '4191 或 8180 不属于新记忆服务监督器；拒绝视为已完成重启。'
    }
    $healthy = $true
    break
  } catch { $lastError = $_.Exception.Message }
}
if (-not $healthy) { throw "Ethere 重启后未通过实例身份和数据目录校验：$lastError" }
Write-Host "Ethere 已验证：4173 PID $newListenerId；数据目录 $dataRoot；原线程与模型未变。"
