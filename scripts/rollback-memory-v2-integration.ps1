param(
  [switch]$RestartServices,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$checkpointRoot = Join-Path $projectRoot 'memory-integration-checkpoints\00-before-memory-v2-integration-2026-11-06'
$manifestPath = Join-Path $checkpointRoot 'MANIFEST.json'
$readyRoot = Join-Path $projectRoot 'memory-integration-checkpoints\06-real-context-recall-memory-v2'
$readyManifestPath = Join-Path $readyRoot 'MANIFEST.json'

if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "缺少接入前检查点：$manifestPath"
}

$manifest = @(Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json)
foreach ($entry in $manifest) {
  if ([IO.Path]::IsPathRooted($entry.path) -or $entry.path -match '(^|[\\/])\.\.([\\/]|$)') {
    throw "检查点包含越界路径：$($entry.path)"
  }
  $source = Join-Path $checkpointRoot $entry.path
  if (-not (Test-Path -LiteralPath $source)) { throw "检查点文件缺失：$($entry.path)" }
  $actualHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
  if ($actualHash -ne $entry.sha256) { throw "检查点校验失败：$($entry.path)" }
}

# 先确认当前代码没有在最终检查点之后被继续编辑；否则拒绝覆盖新工作。
if (-not (Test-Path -LiteralPath $readyManifestPath)) {
  throw "缺少最终检查点，拒绝覆盖当前代码：$readyManifestPath"
}
$readyManifest = @(Get-Content -LiteralPath $readyManifestPath -Raw | ConvertFrom-Json)
foreach ($entry in $readyManifest) {
  if ([IO.Path]::IsPathRooted($entry.path) -or $entry.path -match '(^|[\\/])\.\.([\\/]|$)') {
    throw "最终检查点包含越界路径：$($entry.path)"
  }
  $target = Join-Path $projectRoot $entry.path
  if (-not (Test-Path -LiteralPath $target)) { throw "最终检查点之后文件已删除，拒绝覆盖：$($entry.path)" }
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $entry.sha256) {
    throw "最终检查点之后文件已修改，拒绝覆盖：$($entry.path)"
  }
}

if ($DryRun) {
  Write-Host "回滚干跑通过：接入前 $($manifest.Count) 个文件与最终检查点 $($readyManifest.Count) 个文件均校验一致；没有修改代码或数据。"
  return
}

foreach ($entry in $manifest) {
  $source = Join-Path $checkpointRoot $entry.path
  $target = Join-Path $projectRoot $entry.path
  $targetParent = Split-Path -Parent $target
  if (-not (Test-Path -LiteralPath $targetParent)) {
    New-Item -ItemType Directory -Path $targetParent | Out-Null
  }
  Copy-Item -LiteralPath $source -Destination $target -Force

  # Capacitor keeps a second copy of web assets for the phone build.
  if ($entry.path.StartsWith('web\', [StringComparison]::OrdinalIgnoreCase)) {
    $assetRelativePath = $entry.path.Substring(4)
    $phoneTarget = Join-Path $projectRoot (Join-Path 'android\app\src\main\assets\public' $assetRelativePath)
    $phoneParent = Split-Path -Parent $phoneTarget
    if (-not (Test-Path -LiteralPath $phoneParent)) { New-Item -ItemType Directory -Path $phoneParent | Out-Null }
    Copy-Item -LiteralPath $source -Destination $phoneTarget -Force
  }
}

# These files did not exist at the checkpoint. Remove only the exact integration files.
$newIntegrationFiles = @(
  'server\memory-v2-client.mjs',
  'server\memory-v2-mcp-tools.mjs',
  'server\memory-v2-source-sync.mjs',
  'server\memory-v2-ownership.mjs',
  'scripts\memory-v2-supervisor.mjs',
  'scripts\backup-memory-lab.mjs',
  'test\memory-v2-tools.test.mjs',
  'test\memory-v2-source-sync.test.mjs',
  'test\memory-v2-supervisor.test.mjs',
  'test\project-data-root.test.mjs',
  'test\instance-guard.test.mjs',
  'test\shared-memory-instructions.test.mjs'
)
foreach ($relativePath in $newIntegrationFiles) {
  $target = Join-Path $projectRoot $relativePath
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
}

Write-Host '已恢复到接入新记忆库之前的代码；聊天、时间线、空间、核心记忆和 memory-lab 数据均未删除。未要求重启时，正在运行的进程保持原状态。'
if ($RestartServices) {
  & (Join-Path $PSScriptRoot 'restart-ethere-service.ps1')
}

