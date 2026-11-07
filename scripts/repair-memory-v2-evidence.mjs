import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryLabStore } from '../memory-lab/src/store.mjs';
import { sourceInstanceForDataRoot } from '../server/memory-v2-client.mjs';
import { resolveProjectDataRoot } from '../server/paths.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const batchId = process.argv[2];
const backupName = process.argv[3];
if (!/^maintenance-[a-z0-9-]+$/.test(batchId || '') || !/^[0-9]{2}-[a-z0-9-]+$/.test(backupName || '')) {
  throw new Error('需要明确批次 ID 和备份名称');
}
const dbPath = join(root, 'memory-lab', 'runtime', 'memory-lab.sqlite');
const backupPath = join(root, 'memory-integration-checkpoints', backupName, 'DATA', 'memory-lab.sqlite');
if (!existsSync(backupPath)) throw new Error('缺少修复前 SQLite 备份');
const [health, status] = await Promise.all([
  fetch('http://127.0.0.1:4191/api/health').then((response) => response.json()),
  fetch('http://127.0.0.1:4191/api/maintenance/status').then((response) => response.json()),
]);
if (resolve(health.dbPath) !== resolve(dbPath) || !health.pid || status.running) throw new Error('记忆服务身份不符或正在维护');
const store = new MemoryLabStore(dbPath);
try {
  const row = store.db.prepare('SELECT result_json FROM maintenance_applies WHERE batch_id=?').get(batchId);
  if (!row) throw new Error('指定批次尚未成功提交');
  const result = JSON.parse(row.result_json);
  const memoryIds = [...new Set([...(result.created || []), ...(result.updated || [])])];
  const repaired = store.repairEvidenceFromSources(memoryIds, { sourceInstance: sourceInstanceForDataRoot(resolveProjectDataRoot(root)) });
  process.stdout.write(`${JSON.stringify({ batchId, backupPath, memoryIds, ...repaired }, null, 2)}\n`);
} finally { store.close(); }
