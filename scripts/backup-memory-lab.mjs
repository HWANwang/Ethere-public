import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const source = join(root, 'memory-lab', 'runtime', 'memory-lab.sqlite');
const checkpointName = process.argv[2];
if (!/^[0-9]{2}-[a-z0-9-]+$/.test(checkpointName || '')) throw new Error('检查点名称无效');
const destination = join(root, 'memory-integration-checkpoints', checkpointName, 'DATA');
const backup = join(destination, 'memory-lab.sqlite');
if (!existsSync(source)) throw new Error('记忆库不存在');
if (existsSync(backup)) throw new Error('目标备份已存在，拒绝覆盖');
mkdirSync(destination, { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${backup.replaceAll('\\', '/').replaceAll("'", "''")}'`);
  const counts = {
    memories: db.prepare('SELECT COUNT(*) n FROM memories').get().n,
    sources: db.prepare('SELECT COUNT(*) n FROM source_records').get().n,
    evidence: db.prepare('SELECT COUNT(*) n FROM memory_evidence').get().n,
  };
  writeFileSync(join(destination, 'counts.json'), JSON.stringify(counts, null, 2));
  process.stdout.write(`${backup}\n${JSON.stringify(counts)}\n`);
} finally { db.close(); }
