$labRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $labRoot 'runtime'
foreach ($name in @('lab.pid','model.pid','embedding.pid','embedding-base.pid')) {
  $path = Join-Path $runtimeDir $name
  if (Test-Path -LiteralPath $path) {
    $processId = [int](Get-Content -LiteralPath $path -Raw)
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) { Stop-Process -Id $processId }
    Remove-Item -LiteralPath $path -Force
  }
}
Write-Output 'Memory Lab stopped.'

