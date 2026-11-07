$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$propertiesPath = Join-Path $projectRoot 'android\keystore.properties'
$signingRoot = Join-Path $env:LOCALAPPDATA 'Ethere\signing'
$keystorePath = Join-Path $signingRoot 'ethere-release.jks'

if ((Test-Path -LiteralPath $propertiesPath) -or (Test-Path -LiteralPath $keystorePath)) {
  throw 'Release 签名已经存在。为避免破坏今后的应用升级，本脚本不会覆盖它。'
}

$keytoolCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Eclipse Adoptium\jdk-21.0.12.1+1\bin\keytool.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Android Studio Rabbit 2\android-studio\jbr\bin\keytool.exe')
)
$keytool = $keytoolCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $keytool) { throw '没有找到 keytool，请先安装 JDK 21。' }

$bytes = [byte[]]::new(24)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$password = [Convert]::ToBase64String($bytes).Replace('+', 'A').Replace('/', 'B').TrimEnd('=')
New-Item -ItemType Directory -Path $signingRoot -Force | Out-Null

& $keytool -genkeypair -v -keystore $keystorePath -storepass $password -keypass $password -alias ethere -keyalg RSA -keysize 4096 -validity 10000 -dname 'CN=Ethere, OU=Personal, O=Ethere, L=Shanghai, ST=Shanghai, C=CN'
if ($LASTEXITCODE -ne 0) { throw '生成 Release 签名失败。' }

$normalizedKeystore = $keystorePath.Replace('\', '/')
$properties = @(
  "storeFile=$normalizedKeystore"
  "storePassword=$password"
  'keyAlias=ethere'
  "keyPassword=$password"
) -join "`r`n"
[System.IO.File]::WriteAllText($propertiesPath, "$properties`r`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "Release 签名已创建：$keystorePath"
Write-Host '请保留该文件；丢失后，已安装应用将无法用新版本覆盖升级。'
