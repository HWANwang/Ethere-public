$ErrorActionPreference = 'Stop'
$labRoot = $PSScriptRoot
$runtimeDir = Join-Path $labRoot 'runtime'
$pidFile = Join-Path $runtimeDir 'server.pid'
$url = 'http://127.0.0.1:4189/api/health'

try {
    $response = Invoke-RestMethod -Uri $url -TimeoutSec 2
    if ($response.chat -eq $true) {
        Write-Output 'Voice Lab 已运行：http://127.0.0.1:4189/'
        exit 0
    }
} catch { }

$owner = Get-NetTCPConnection -LocalPort 4189 -State Listen -ErrorAction SilentlyContinue
if ($owner) { throw '4189 端口已被其他服务占用；不会覆盖或停止它。' }

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$node = (Get-Command node.exe -ErrorAction Stop).Source
$serverPath = Join-Path $labRoot 'server.mjs'
$process = Start-Process -FilePath $node -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $labRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'server.out.log') -RedirectStandardError (Join-Path $runtimeDir 'server.err.log')
[string]$process.Id | Set-Content -LiteralPath $pidFile -Encoding ascii

for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $response = Invoke-RestMethod -Uri $url -TimeoutSec 2
        if ($response.chat -eq $true) {
            Write-Output 'Voice Lab 已启动：http://127.0.0.1:4189/'
            exit 0
        }
    } catch { }
}
throw 'Voice Lab 启动失败；请查看 runtime/server.err.log。'
