import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeveloperTaskManager } from '../server/developer-task-manager.mjs';
import { createDeveloperBridgeServer } from '../server/developer-bridge-api.mjs';

const dataRoot = process.env.ETHERE_DATA_DIR;
if (!dataRoot) throw new Error('开发代理桥需要显式 ETHERE_DATA_DIR');
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultWorkspace = join(projectRoot, 'developer-workspace');
await mkdir(defaultWorkspace, { recursive: true });
const allowedRoots = process.env.ETHERE_DEVELOPER_PROJECT_ROOTS
  ? process.env.ETHERE_DEVELOPER_PROJECT_ROOTS.split(delimiter).filter(Boolean) : [defaultWorkspace];
const tokenFile = join(dataRoot, 'runtime', 'developer-bridge-token');
await mkdir(dirname(tokenFile), { recursive: true });
try { await writeFile(tokenFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const token = (await readFile(tokenFile, 'utf8')).trim();
const manager = new DeveloperTaskManager({ dataRoot, allowedRoots });
await manager.initialize();
const server = createDeveloperBridgeServer({ manager, token });
const port = Number(process.env.ETHERE_DEVELOPER_BRIDGE_PORT || 4174);
server.listen(port, '127.0.0.1', () => {
  console.log(`Ethere developer bridge: http://127.0.0.1:${server.address().port}`);
  console.log(`Ethere data: ${dataRoot}`);
  console.log(`Developer allowed roots: ${allowedRoots.join(', ')}`);
});
async function close() { server.close(); await manager.close(); }
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
