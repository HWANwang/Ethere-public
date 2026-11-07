import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectDataRoot } from '../server/paths.mjs';
import { assertOwnedListener, assertMemoryLabIdentity } from '../server/memory-v2-ownership.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const labRoot = join(projectRoot, 'memory-lab');
const dataRoot = resolveProjectDataRoot(projectRoot);
process.env.ETHERE_DATA_DIR = dataRoot;
const logRoot = join(dataRoot, 'logs');
const pidFile = join(dataRoot, 'runtime', 'memory-v2-supervisor.pid');
const embeddingExe = join(labRoot, 'vendor', 'llama.cpp', 'b12128', 'llama-server.exe');
const embeddingModel = join(projectRoot, 'models', 'bge-base-zh-v1.5', 'bge-base-zh-v1.5-q8_0.gguf');
const labData = join(labRoot, 'runtime'); // 保留已验收数据库；迁移数据目录另行显式执行。
let embedding = null; let lab = null; let stopping = false;
await mkdir(logRoot, { recursive: true });
await mkdir(join(dataRoot, 'runtime'), { recursive: true });
await writeFile(pidFile, String(process.pid), 'utf8');
await ensure();
const timer = setInterval(() => void ensure().catch(failClosed), 15_000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown());

async function ensure() {
  if (stopping) return;
  const embeddingHealth = await health('http://127.0.0.1:8180/health');
  if (embeddingHealth) {
    assertOwnedListener({ port: 8180, childPid: embedding?.pid, listenerPid: listenerPid(8180) });
  } else if (!embedding) startEmbedding();
  const labHealth = await health('http://127.0.0.1:4191/api/health');
  if (labHealth) {
    assertMemoryLabIdentity({ childPid: lab?.pid, listenerPid: listenerPid(4191), health: labHealth,
      dataDir: labData, model: 'bge-base-zh-v1.5-q8' });
  } else if (!lab) startLab();
}
function startEmbedding() {
  if (embedding || !existsSync(embeddingExe) || !existsSync(embeddingModel)) return;
  embedding = spawn(embeddingExe, ['-m', embeddingModel, '--host', '127.0.0.1', '--port', '8180', '--embedding', '--pooling', 'cls', '--ctx-size', '512', '--batch-size', '512', '--alias', 'bge-base-zh-v1.5-q8'], childOptions('memory-v2-embedding.log'));
  embedding.once('exit', () => { embedding = null; });
}
function startLab() {
  if (lab) return;
  lab = spawn(process.execPath, [join(labRoot, 'src', 'server.mjs')], { ...childOptions('memory-v2-service.log'), cwd: projectRoot, env: { ...process.env, MEMORY_LAB_DATA_DIR: labData, MEMORY_LAB_PORT: '4191', MEMORY_LAB_EMBEDDING_URL: 'http://127.0.0.1:8180/v1', MEMORY_LAB_EMBEDDING_NAME: 'bge-base-zh-v1.5-q8', MEMORY_LAB_AUTO_MAINTENANCE: 'true' } });
  lab.once('exit', () => { lab = null; });
}
function childOptions(name) { const fd = openSync(join(logRoot, name), 'a'); const options = { cwd: projectRoot, windowsHide: true, stdio: ['ignore', fd, fd] }; queueMicrotask(() => closeSync(fd)); return options; }
async function health(url) { try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); return response.ok ? await response.json() : null; } catch { return null; } }
function listenerPid(port) {
  if (process.platform !== 'win32') return port === 4191 ? lab?.pid : embedding?.pid;
  const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  const ids = [...output.matchAll(new RegExp(`^\\s*TCP\\s+127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'gm'))]
    .map((match) => Number(match[1]));
  if (ids.length !== 1) throw new Error(`端口 ${port} 监听者数量不是 1：${ids.length}`);
  return ids[0];
}
function failClosed(error) { console.error(`Memory V2 supervisor stopped: ${error.message}`); shutdown(); }
function shutdown() {
  stopping = true;
  clearInterval(timer);
  lab?.kill();
  embedding?.kill();
  void unlink(pidFile).catch(() => {}).finally(() => process.exit(0));
}
