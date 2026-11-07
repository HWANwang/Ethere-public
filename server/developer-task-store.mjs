import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class DeveloperTaskStore {
  constructor({ dataRoot }) {
    if (!dataRoot) throw new Error('开发任务必须指定 ETHERE_DATA_DIR');
    this.file = join(dataRoot, 'state', 'developer-tasks.sqlite');
    this.database = null;
  }

  async initialize() {
    if (this.database) return;
    await mkdir(dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS developer_tasks (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS developer_tasks_status ON developer_tasks(status, updated_at);
      CREATE TABLE IF NOT EXISTS developer_events (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, payload TEXT NOT NULL,
        delivered_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS developer_events_pending ON developer_events(delivered_at, created_at);`);
    this.database = db;
  }

  async put(task) {
    await this.initialize();
    const next = { ...task, updatedAt: new Date().toISOString() };
    this.database.prepare(`INSERT INTO developer_tasks(id, status, updated_at, payload) VALUES(?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, payload=excluded.payload`)
      .run(next.id, next.status, next.updatedAt, JSON.stringify(next));
    return next;
  }

  async get(id) {
    await this.initialize();
    const row = this.database.prepare('SELECT payload FROM developer_tasks WHERE id = ?').get(id);
    return row ? JSON.parse(row.payload) : null;
  }

  async list({ limit = 30 } = {}) {
    await this.initialize();
    return this.database.prepare('SELECT payload FROM developer_tasks ORDER BY updated_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(100, Number(limit) || 30))).map((row) => JSON.parse(row.payload));
  }

  async nextQueued() {
    await this.initialize();
    const row = this.database.prepare("SELECT payload FROM developer_tasks WHERE status = 'queued' ORDER BY updated_at, id LIMIT 1").get();
    return row ? JSON.parse(row.payload) : null;
  }

  async appendEvent(event) {
    await this.initialize();
    const result = this.database.prepare(`INSERT OR IGNORE INTO developer_events(id, task_id, payload, delivered_at, created_at)
      VALUES(?, ?, ?, NULL, ?)`).run(event.id, event.taskId, JSON.stringify(event), event.createdAt || new Date().toISOString());
    return result.changes > 0;
  }

  async pendingEvents({ limit = 20 } = {}) {
    await this.initialize();
    return this.database.prepare('SELECT payload FROM developer_events WHERE delivered_at IS NULL ORDER BY created_at, id LIMIT ?')
      .all(Math.max(1, Math.min(100, Number(limit) || 20))).map((row) => JSON.parse(row.payload));
  }

  async acknowledgeEvent(id) {
    await this.initialize();
    return this.database.prepare('UPDATE developer_events SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?')
      .run(new Date().toISOString(), id).changes > 0;
  }

  async close() {
    this.database?.close();
    this.database = null;
  }
}
