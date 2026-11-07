$ErrorActionPreference = 'Stop'

$ensureScript = Join-Path $PSScriptRoot 'ensure-ethere-running.ps1'
$launcher = Join-Path $PSScriptRoot 'ensure-ethere-running.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$taskCommand = "`"$wscript`" `"$launcher`""
& schtasks.exe /Create /TN 'Ethere Watchdog' /TR $taskCommand /SC MINUTE /MO 3 /RL LIMITED /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法创建 Ethere 看门狗计划任务。' }
Start-Process -FilePath $wscript -ArgumentList @($launcher) -WindowStyle Hidden
Write-Host 'Ethere 看门狗已安装并启动。'
