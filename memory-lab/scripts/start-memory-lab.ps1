$ErrorActionPreference = 'Stop'
$labRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Split-Path -Parent $labRoot
$runtimeDir = Join-Path $labRoot 'runtime'
$logDir = Join-Path $runtimeDir 'logs'
$embeddingPath = Join-Path $projectRoot 'models\bge-base-zh-v1.5\bge-base-zh-v1.5-q8_0.gguf'
$llamaServer = Join-Path $labRoot 'vendor\llama.cpp\b12128\llama-server.exe'
$nodeExe = (Get-Command node).Source

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
if (-not (Test-Path -LiteralPath $embeddingPath)) { throw "Embedding 模型文件不存在：$embeddingPath" }
if (-not (Test-Path -LiteralPath $llamaServer)) { throw "llama-server 不存在：$llamaServer" }

function Test-Endpoint([string]$Uri) {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $Uri).StatusCode -eq 200 } catch { return $false }
}

if (-not (Test-Endpoint 'http://127.0.0.1:8180/health')) {
  $embeddingArgs = @('-m', $embeddingPath, '--host', '127.0.0.1', '--port', '8180', '--embedding', '--pooling', 'cls', '--ctx-size', '512', '--batch-size', '512', '--alias', 'bge-base-zh-v1.5-q8')
  $embeddingProcess = Start-Process -FilePath $llamaServer -ArgumentList $embeddingArgs -WorkingDirectory (Split-Path $llamaServer) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'embedding.out.log') -RedirectStandardError (Join-Path $logDir 'embedding.err.log') -PassThru
  Set-Content -LiteralPath (Join-Path $runtimeDir 'embedding.pid') -Value $embeddingProcess.Id
  $ready = $false
  foreach ($i in 1..60) { Start-Sleep -Milliseconds 500; if (Test-Endpoint 'http://127.0.0.1:8180/health') { $ready = $true; break }; if ($embeddingProcess.HasExited) { break } }
  if (-not $ready) { throw "Embedding 服务启动失败，请查看 $logDir\embedding.err.log" }
}

if (-not (Test-Endpoint 'http://127.0.0.1:4191/api/health')) {
  $env:MEMORY_LAB_DATA_DIR = $runtimeDir
  $env:MEMORY_LAB_PORT = '4191'
  $env:MEMORY_LAB_EMBEDDING_URL = 'http://127.0.0.1:8180/v1'
  $env:MEMORY_LAB_EMBEDDING_NAME = 'bge-base-zh-v1.5-q8'
  $env:MEMORY_LAB_ENABLE_LEGACY_AUTO = 'false'
  $env:MEMORY_LAB_LOCAL_ORGANIZER_ENABLED = 'false'
  $labProcess = Start-Process -FilePath $nodeExe -ArgumentList (Join-Path $labRoot 'src\server.mjs') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'lab.out.log') -RedirectStandardError (Join-Path $logDir 'lab.err.log') -PassThru
  Set-Content -LiteralPath (Join-Path $runtimeDir 'lab.pid') -Value $labProcess.Id
  foreach ($i in 1..20) { Start-Sleep -Milliseconds 500; if (Test-Endpoint 'http://127.0.0.1:4191/api/health') { break } }
}

Write-Output 'Memory Lab ready: http://127.0.0.1:4191 (BGE embedding :8180, local organizer disabled)'

