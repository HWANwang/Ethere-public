$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  $bridgeCommit = (& git rev-parse --verify 'refs/tags/ethere-developer-bridge-2026-11-01').Trim()
  if ($LASTEXITCODE -ne 0 -or -not $bridgeCommit) { throw '缺少开发代理桥提交标签，未执行回滚。' }
  & git ls-files --error-unmatch -- server/developer-task-manager.mjs *> $null
  if ($LASTEXITCODE -ne 0) { throw '开发代理桥已不在当前工作树；未重复回滚。' }
  $featurePaths = @(& git diff-tree --no-commit-id --name-only -r $bridgeCommit)
  $dirtyPaths = @(& git diff --name-only) + @(& git diff --cached --name-only)
  $overlap = @($featurePaths | Where-Object { $dirtyPaths -contains $_ })
  if ($overlap.Count -gt 0) { throw "这些桥接文件有未提交改动，未覆盖：$($overlap -join ', ')" }
  & git revert --no-edit $bridgeCommit
  if ($LASTEXITCODE -ne 0) { throw 'Git 回滚遇到冲突；未继续重启，请先检查 git status。' }
  & (Join-Path $PSScriptRoot 'restart-ethere-service.ps1')
  Write-Host '开发代理桥提交已回滚；其他未提交改动保持原样。'
} finally {
  Pop-Location
}
