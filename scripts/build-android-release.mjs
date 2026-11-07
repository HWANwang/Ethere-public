import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const serverUrl = String(process.env.ETHERE_APP_SERVER_URL || '').trim().replace(/\/+$/, '');
if (!/^https:\/\/[^/]+/.test(serverUrl)) {
  throw new Error('请通过 ETHERE_APP_SERVER_URL 提供 Tailscale 的 HTTPS 地址。');
}

const signingProperties = join(projectRoot, 'android', 'keystore.properties');
await readFile(signingProperties, 'utf8').catch(() => { throw new Error('尚未创建 Release 签名，请先运行 scripts/setup-release-signing.ps1。'); });

const capacitorCli = join(projectRoot, 'node_modules', '@capacitor', 'cli', 'dist', 'index.js');
execFileSync(process.execPath, [capacitorCli, 'sync', 'android'], { cwd: projectRoot, stdio: 'inherit' });

const generatedConfigPath = join(projectRoot, 'android', 'app', 'src', 'main', 'assets', 'capacitor.config.json');
const generatedConfig = JSON.parse(await readFile(generatedConfigPath, 'utf8'));
generatedConfig.server = { ...(generatedConfig.server || {}), url: serverUrl, cleartext: false };
await writeFile(generatedConfigPath, `${JSON.stringify(generatedConfig, null, 2)}\n`, 'utf8');

if (process.platform === 'win32') {
  execFileSync('cmd.exe', ['/d', '/s', '/c', 'gradlew.bat assembleRelease'], { cwd: join(projectRoot, 'android'), stdio: 'inherit' });
} else {
  execFileSync('./gradlew', ['assembleRelease'], { cwd: join(projectRoot, 'android'), stdio: 'inherit' });
}

const sourceApk = join(projectRoot, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const outputApk = join(projectRoot, 'dist', 'Ethere-release.apk');
await mkdir(dirname(outputApk), { recursive: true });
await copyFile(sourceApk, outputApk);
console.log(`Release APK：${outputApk}`);
