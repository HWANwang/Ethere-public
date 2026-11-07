import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm, stat, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectDataRoot } from '../server/paths.mjs';
import { stopOwnedProcessTree } from '../server/owned-process-tree.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const dataRoot = resolveProjectDataRoot(projectRoot);
process.env.ETHERE_DATA_DIR = dataRoot;
const runtimeRoot = join(dataRoot, 'runtime');
const logRoot = join(dataRoot, 'logs');
const lockFile = join(runtimeRoot, 'watchdog.pid');
const logFile = join(logRoot, 'watchdog.log');
const serverLogFile = join(logRoot, 'server.log');
const bridgeLogFile = join(logRoot, 'developer-bridge.log');
const voiceRoot = join(projectRoot, '..', 'voice-lab');
const voiceScript = join(voiceRoot, 'server.mjs');
const voiceLogFile = join(logRoot, 'voice-service.log');
const port = Number(process.env.PORT || 4173);
const bridgePort = Number(process.env.ETHERE_DEVELOPER_BRIDGE_PORT || 4174);
const healthUrl = `http://127.0.0.1:${port}/api/ethere/v1/health`;
const bridgeHealthUrl = `http://127.0.0.1:${bridgePort}/health`;
const voiceHealthUrl = 'http://127.0.0.1:4189/api/health';
const healthIntervalMs = 15_000;
const healthTimeoutMs = 7_000;
const unhealthyLimit = 3;

await mkdir(runtimeRoot, { recursive: true });
await mkdir(logRoot, { recursive: true });
if (!await claimWatchdogLock()) process.exit(0);
if (await isLocalPortOpen(port)) {
  removeOwnedLock();
  throw new Error(`端口 ${port} 已有监听者；拒绝启动第二个 Ethere 实例`);
}

let child = null;
let bridgeChild = null;
let voiceChild = null;
let memoryV2Child = null;
let stopping = false;
let failures = 0;
let bridgeFailures = 0;
let voiceFailures = 0;
let restartDelayMs = 1_000;

await log(`看门狗启动，健康检查：${healthUrl}`);
void startServer();
void startBridge();
void startMemoryV2();
void checkVoiceHealth();
const healthTimer = setInterval(() => { void checkHealth(); }, healthIntervalMs);
const bridgeHealthTimer = setInterval(() => { void checkBridgeHealth(); }, healthIntervalMs);
const voiceHealthTimer = setInterval(() => { void checkVoiceHealth(); }, healthIntervalMs);

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
process.once('exit', removeOwnedLock);

async function startServer() {
  if (stopping || child) return;
  await rotateLog(serverLogFile);
  const output = openSync(serverLogFile, 'a');
  child = spawn(process.execPath, [join(projectRoot, 'scripts', 'serve.mjs')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ETHERE_DATA_DIR: dataRoot,
      ...(process.env.ETHERE_CODEX_COMMAND ? { ETHERE_CODEX_COMMAND: process.env.ETHERE_CODEX_COMMAND } : {}),
      PORT: String(port),
    },
    windowsHide: true,
    stdio: ['ignore', output, output],
  });
  closeSync(output);
  void log(`服务已启动，PID ${child.pid}`);
  child.once('exit', (code, signal) => {
    const exited = child;
    child = null;
    if (stopping) return;
    void log(`服务退出（PID ${exited.pid}，code=${code ?? '-'}，signal=${signal ?? '-'}），${restartDelayMs / 1000} 秒后重启`);
    const delay = restartDelayMs;
    restartDelayMs = Math.min(restartDelayMs * 2, 30_000);
    setTimeout(() => { void startServer(); }, delay);
  });
}

async function startBridge() {
  if (stopping || bridgeChild) return;
  await rotateLog(bridgeLogFile);
  const output = openSync(bridgeLogFile, 'a');
  bridgeChild = spawn(process.execPath, [join(projectRoot, 'scripts', 'developer-bridge.mjs')], {
    cwd: projectRoot,
    env: { ...process.env, ETHERE_DATA_DIR: dataRoot, ETHERE_DEVELOPER_BRIDGE_PORT: String(bridgePort) },
    windowsHide: true,
    stdio: ['ignore', output, output],
  });
  closeSync(output);
  await log(`开发代理桥已启动，PID ${bridgeChild.pid}`);
  bridgeChild.once('exit', (code, signal) => {
    const exited = bridgeChild;
    bridgeChild = null;
    if (stopping) return;
    void log(`开发代理桥退出（PID ${exited.pid}，code=${code ?? '-'}，signal=${signal ?? '-'}），稍后重启`);
    setTimeout(() => { void startBridge(); }, 5_000);
  });
}

async function startMemoryV2() {
  if (stopping || memoryV2Child) return;
  const output = openSync(join(logRoot, 'memory-v2-supervisor.log'), 'a');
  memoryV2Child = spawn(process.execPath, [join(projectRoot, 'scripts', 'memory-v2-supervisor.mjs')], {
    cwd: projectRoot, env: { ...process.env, ETHERE_DATA_DIR: dataRoot }, windowsHide: true, stdio: ['ignore', output, output],
  });
  closeSync(output);
  await log(`新记忆服务监督器已启动，PID ${memoryV2Child.pid}`);
  memoryV2Child.once('exit', () => { memoryV2Child = null; if (!stopping) setTimeout(() => void startMemoryV2(), 5_000); });
}

async function checkHealth() {
  if (stopping) return;
  if (!child) return void startServer();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), healthTimeoutMs);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    if (health?.instance?.pid !== child.pid || !samePath(health?.instance?.dataRoot, dataRoot)) {
      throw new Error('4173 响应来自其他进程或数据目录');
    }
    if (!health.serverConnected) throw new Error('4173 服务未连接');
    if (!health.runtimeConnected) throw new Error(`Codex 运行时未连接：${health.runtimeError || '原因未上报'}`);
    failures = 0;
    restartDelayMs = 1_000;
  } catch (error) {
    failures += 1;
    await log(`健康检查失败 ${failures}/${unhealthyLimit}：${error?.message || error}`);
    if (failures >= unhealthyLimit) {
      failures = 0;
      await log(`服务连续无响应，停止 PID ${child.pid} 的完整进程树以释放专属 app-server`);
      const unhealthyChild = child;
      try { await stopOwnedProcessTree(unhealthyChild); }
      catch (stopError) { await log(`进程树停止失败，拒绝假装已解锁：${stopError.message}`); }
    }
  } finally {
    clearTimeout(timer);
  }
}

async function checkBridgeHealth() {
  if (stopping) return;
  if (!bridgeChild) return void startBridge();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), healthTimeoutMs);
  try {
    const response = await fetch(bridgeHealthUrl, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bridgeFailures = 0;
  } catch (error) {
    bridgeFailures += 1;
    await log(`开发代理桥健康检查失败 ${bridgeFailures}/${unhealthyLimit}：${error?.message || error}`);
    if (bridgeFailures >= unhealthyLimit) {
      bridgeFailures = 0;
      try { await stopOwnedProcessTree(bridgeChild); }
      catch (stopError) { await log(`开发代理桥停止失败：${stopError.message}`); }
    }
  } finally { clearTimeout(timer); }
}

async function startVoice() {
  if (stopping || voiceChild || !existsSync(voiceScript)) return;
  await rotateLog(voiceLogFile);
  const output = openSync(voiceLogFile, 'a');
  const voiceEnv = { ...process.env };
  if (!voiceEnv.HTTPS_PROXY && !voiceEnv.https_proxy) {
    const proxyPort = Number(voiceEnv.ETHERE_FISH_PROXY_PORT || 7897);
    if (Number.isInteger(proxyPort) && proxyPort > 0 && proxyPort <= 65535 && await isLocalPortOpen(proxyPort)) {
      voiceEnv.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
      await log(`语音服务使用本机代理端口 ${proxyPort}`);
    }
  }
  const useProxy = Boolean(voiceEnv.HTTPS_PROXY || voiceEnv.https_proxy);
  voiceChild = spawn(process.execPath, [...(useProxy ? ['--use-env-proxy'] : []), voiceScript], {
    cwd: voiceRoot, env: voiceEnv, windowsHide: true, stdio: ['ignore', output, output],
  });
  closeSync(output);
  await log(`语音服务已启动，PID ${voiceChild.pid}`);
  voiceChild.once('exit', (code, signal) => {
    const exited = voiceChild;
    voiceChild = null;
    if (!stopping) void log(`语音服务退出（PID ${exited.pid}，code=${code ?? '-'}，signal=${signal ?? '-'}）`);
  });
}

function isLocalPortOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (open) => { if (settled) return; settled = true; socket.destroy(); resolve(open); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function checkVoiceHealth() {
  if (stopping || !existsSync(voiceScript)) return;
  try {
    const response = await fetch(voiceHealthUrl, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    voiceFailures = 0;
  } catch {
    voiceFailures += 1;
    if (!voiceChild) return void startVoice();
    if (voiceFailures >= unhealthyLimit) {
      voiceFailures = 0;
      await log(`语音服务连续无响应，重启 PID ${voiceChild.pid}`);
      try { await stopOwnedProcessTree(voiceChild); }
      catch (stopError) { await log(`语音服务停止失败：${stopError.message}`); }
    }
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(healthTimer);
  clearInterval(bridgeHealthTimer);
  clearInterval(voiceHealthTimer);
  await log('看门狗停止');
  const stopped = await Promise.allSettled([child, bridgeChild, voiceChild, memoryV2Child].map(stopOwnedProcessTree));
  for (const result of stopped) {
    if (result.status === 'rejected') await log(`进程树停止失败：${result.reason?.message || result.reason}`);
  }
  removeOwnedLock();
  process.exit(0);
}

async function claimWatchdogLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockFile, 'wx');
      try { await handle.writeFile(String(process.pid), 'utf8'); }
      finally { await handle.close(); }
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number((await readFile(lockFile, 'utf8').catch(() => '')).trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('看门狗锁内容无效；拒绝自动覆盖');
      try { process.kill(pid, 0); return false; }
      catch (checkError) {
        if (checkError.code !== 'ESRCH') throw checkError;
        await rm(lockFile, { force: true });
      }
    }
  }
  throw new Error('无法取得看门狗锁；拒绝启动第二实例');
}

function removeOwnedLock() {
  try {
    if (readFileSync(lockFile, 'utf8').trim() === String(process.pid)) unlinkSync(lockFile);
  } catch { /* 锁已被清理或目录不可用。 */ }
}

function samePath(actual, expected) {
  if (typeof actual !== 'string' || !actual) return false;
  const left = resolve(actual);
  const right = resolve(expected);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function rotateLog(path) {
  try {
    if ((await stat(path)).size > 5 * 1024 * 1024) {
      await rm(`${path}.1`, { force: true });
      await rename(path, `${path}.1`);
    }
  } catch { /* 首次运行没有日志。 */ }
}

async function log(message) {
  await rotateLog(logFile);
  const line = `${new Date().toISOString()} ${message}\n`;
  await mkdir(dirname(logFile), { recursive: true });
  await appendFile(logFile, line, 'utf8');
  console.log(message);
}
