import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const OWNERS = new Set(['user', 'assistant', 'relationship']);
const STATUSES = new Set(['active', 'archived']);
const TIERS = new Set(['core', 'retrievable']);
const SOURCE_TYPES = new Set(['chat', 'space', 'timeline']);

export class MemoryNodeStore {
  constructor({ dataRoot, now = () => new Date(), idFactory = () => `node-${randomUUID()}` }) {
    this.file = join(dataRoot, 'memory', 'memory-nodes.sqlite');
    this.now = now;
    this.idFactory = idFactory;
    this.database = null;
  }

  async initialize() {
    if (this.database) return;
    await mkdir(dirname(this.file), { recursive: true });
    const database = new DatabaseSync(this.file);
    database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
    database.exec(`CREATE TABLE IF NOT EXISTS memory_nodes (
      id TEXT PRIMARY KEY, topic_key TEXT NOT NULL UNIQUE, content TEXT NOT NULL,
      owner TEXT NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL,
      revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_nodes_tier_status ON memory_nodes(tier, status, updated_at);
    CREATE TABLE IF NOT EXISTS memory_sources (
      node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL, source_id TEXT NOT NULL, relation TEXT NOT NULL,
      excerpt TEXT NOT NULL DEFAULT '', PRIMARY KEY(node_id, source_type, source_id, relation)
    );
    CREATE INDEX IF NOT EXISTS memory_sources_lookup ON memory_sources(source_type, source_id);
    CREATE TABLE IF NOT EXISTS memory_aliases (
      node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
      alias TEXT NOT NULL, PRIMARY KEY(node_id, alias)
    );
    CREATE INDEX IF NOT EXISTS memory_aliases_name ON memory_aliases(alias);
    CREATE TABLE IF NOT EXISTS memory_revisions (
      node_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL,
      changed_at TEXT NOT NULL, PRIMARY KEY(node_id, revision)
    );
    CREATE TABLE IF NOT EXISTS memory_review_cursor (
      name TEXT PRIMARY KEY, last_user_seq INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT, last_daily_check TEXT
    );
    CREATE TABLE IF NOT EXISTS thread_handoffs (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at TEXT NOT NULL,
      consumed_at TEXT, expires_at TEXT NOT NULL
    );`);
    database.exec('PRAGMA foreign_keys = ON');
    this.database = database;
    // Older retrievable nodes waited for manual confirmation; they now become usable automatically.
    database.exec('BEGIN IMMEDIATE');
    try {
      const pending = database.prepare("SELECT * FROM memory_nodes WHERE tier = 'retrievable' AND status = 'candidate'").all();
      for (const row of pending) {
        const next = { ...row, status: 'active', revision: row.revision + 1, updated_at: this.now().toISOString() };
        database.prepare('UPDATE memory_nodes SET status = ?, revision = ?, updated_at = ? WHERE id = ?')
          .run(next.status, next.revision, next.updated_at, next.id);
        this.#recordRevision(next);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  async importLegacyCore(memories = []) {
    await this.initialize();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const memory of memories) {
        const id = String(memory.id || '').trim();
        if (!id) continue;
        const existing = this.database.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id);
        if (existing) {
          // Re-running the migration also fills the single legacy rollback snapshot.
          this.#importLegacyPrevious(memory, existing);
          continue;
        }
        const node = {
          id,
          topic_key: String(memory.title || '').trim(),
          content: String(memory.contentMarkdown || '').trim(),
          owner: 'user', tier: 'core',
          status: memory.status === 'archived' ? 'archived' : 'active',
          revision: Math.max(1, Number(memory.revision) || 1),
          created_at: memory.createdAt || this.now().toISOString(),
          updated_at: memory.updatedAt || memory.createdAt || this.now().toISOString(),
        };
        if (!node.topic_key || !node.content) throw storeError(400, `旧记忆 ${id} 缺少标题或内容，迁移已中止`);
        this.database.prepare(`INSERT INTO memory_nodes(id, topic_key, content, owner, tier, status, revision, created_at, updated_at)
          VALUES(@id, @topic_key, @content, @owner, @tier, @status, @revision, @created_at, @updated_at)`).run(node);
        this.#recordRevision(node);
        this.#importLegacyPrevious(memory, node);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async create(input = {}) {
    await this.initialize();
    const node = normalizeNode(input, { now: this.now().toISOString(), id: this.idFactory() });
    if (node.tier === 'core' && input.approved !== true) throw storeError(403, '核心记忆需要用户审批');
    const aliases = [...new Set((Array.isArray(input.aliases) ? input.aliases : []).map((value) => String(value || '').trim().slice(0, 80)).filter(Boolean))].slice(0, 20);
    const sources = Array.isArray(input.sources) ? input.sources : [];
    for (const source of sources) {
      if (!SOURCE_TYPES.has(source?.type) || !String(source?.id || '').trim()) throw storeError(400, '来源类型或 ID 无效');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`INSERT INTO memory_nodes(id, topic_key, content, owner, tier, status, revision, created_at, updated_at)
        VALUES(@id, @topic_key, @content, @owner, @tier, @status, @revision, @created_at, @updated_at)`).run(node);
      for (const alias of aliases) this.database.prepare('INSERT INTO memory_aliases(node_id, alias) VALUES(?, ?)').run(node.id, alias);
      const uniqueSources = new Map(sources.map((source) => [`${source.type}:${String(source.id).trim()}`, source]));
      for (const source of uniqueSources.values()) this.database.prepare('INSERT OR IGNORE INTO memory_sources(node_id, source_type, source_id, relation, excerpt) VALUES(?, ?, ?, ?, ?)')
        .run(node.id, source.type, String(source.id).trim(), ['supports', 'corrects', 'contradicts'].includes(source.relation) ? source.relation : 'supports', '');
      this.#recordRevision(node);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (String(error.message).includes('UNIQUE')) throw storeError(409, '这个主题已有记忆节点，请更新原节点');
      throw error;
    }
    return this.get(node.id);
  }

  async update(id, patch = {}, { baseRevision, approved = false } = {}) {
    await this.initialize();
    const current = await this.get(id);
    if (!current) throw storeError(404, '记忆节点不存在');
    if (baseRevision !== current.revision) throw storeError(409, '记忆节点已更新，请刷新后重试');
    const next = normalizeNode({ ...current, ...patch }, { id: current.id, now: current.createdAt });
    if (next.tier === 'core' && current.tier !== 'core' && !approved) throw storeError(403, '晋升为核心记忆需要用户审批');
    next.revision = current.revision + 1;
    next.updated_at = this.now().toISOString();
    next.created_at = current.createdAt;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`UPDATE memory_nodes SET topic_key=@topic_key, content=@content, owner=@owner,
        tier=@tier, status=@status, revision=@revision, updated_at=@updated_at WHERE id=@id`).run({
        id: next.id, topic_key: next.topic_key, content: next.content, owner: next.owner,
        tier: next.tier, status: next.status, revision: next.revision, updated_at: next.updated_at,
      });
      this.#recordRevision(next);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (String(error.message).includes('UNIQUE')) throw storeError(409, '这个主题已有记忆节点，请更新原节点');
      throw error;
    }
    return this.get(id);
  }

  async reviseRetrievable(id, { title, content, sources = [], aliases = [] } = {}, { baseRevision } = {}) {
    await this.initialize();
    const sourceItems = Array.isArray(sources) ? sources : [];
    const aliasItems = Array.isArray(aliases) ? aliases : [];
    if (sourceItems.length > 5) throw storeError(400, '每次最多追加 5 条新来源');
    for (const source of sourceItems) {
      if (!SOURCE_TYPES.has(source?.type) || !String(source?.id || '').trim()) throw storeError(400, '来源类型或 ID 无效');
      if (source.relation && !['supports', 'corrects', 'contradicts'].includes(source.relation)) throw storeError(400, '来源关系无效');
    }
    if (aliasItems.length > 8 || aliasItems.some((alias) => !String(alias || '').trim())) throw storeError(400, '别名无效');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(String(id || ''));
      if (!current || current.status !== 'active' || current.tier !== 'retrievable') throw storeError(404, '可修订的按需记忆节点不存在');
      if (Number(baseRevision) !== current.revision) throw storeError(409, '记忆节点已更新，请重新打开后修订');
      const nextTitle = title == null ? current.topic_key : String(title).trim().replace(/\s+/g, ' ');
      if (!nextTitle || nextTitle.length > 120) throw storeError(400, '记忆标题无效');
      const nextContent = content == null ? current.content : String(content).trim();
      if (!nextContent || nextContent.length > 20_000) throw storeError(400, '记忆内容无效');
      if (nextContent !== current.content && !sourceItems.length) throw storeError(400, '修改记忆内容时请提供至少一条新来源');
      let changed = nextContent !== current.content || nextTitle !== current.topic_key;
      for (const source of sourceItems) {
        const sourceId = String(source.id).trim();
        const relation = source.relation || 'supports';
        const previous = this.database.prepare('SELECT relation FROM memory_sources WHERE node_id = ? AND source_type = ? AND source_id = ?')
          .all(current.id, source.type, sourceId);
        if (previous.length === 1 && previous[0].relation === relation) continue;
        this.database.prepare('DELETE FROM memory_sources WHERE node_id = ? AND source_type = ? AND source_id = ?').run(current.id, source.type, sourceId);
        this.database.prepare('INSERT INTO memory_sources(node_id, source_type, source_id, relation, excerpt) VALUES(?, ?, ?, ?, ?)')
          .run(current.id, source.type, sourceId, relation, '');
        changed = true;
      }
      for (const alias of aliasItems) {
        const value = String(alias).trim().slice(0, 80);
        const result = this.database.prepare('INSERT OR IGNORE INTO memory_aliases(node_id, alias) VALUES(?, ?)').run(current.id, value);
        changed ||= result.changes > 0;
      }
      if (nextTitle !== current.topic_key) {
        this.database.prepare('INSERT OR IGNORE INTO memory_aliases(node_id, alias) VALUES(?, ?)').run(current.id, current.topic_key);
      }
      if (changed) {
        const next = { ...current, topic_key: nextTitle, content: nextContent, revision: current.revision + 1, updated_at: this.now().toISOString() };
        this.database.prepare('UPDATE memory_nodes SET topic_key = ?, content = ?, revision = ?, updated_at = ? WHERE id = ?')
          .run(next.topic_key, next.content, next.revision, next.updated_at, next.id);
        this.#recordRevision(next);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (String(error.message).includes('UNIQUE')) throw storeError(409, '这个标题已有记忆节点，请更新原节点');
      throw error;
    }
    return this.get(id);
  }

  async get(id) {
    await this.initialize();
    const row = this.database.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(String(id || ''));
    if (!row) return null;
    return { ...publicNode(row), sources: this.database.prepare('SELECT source_type AS type, source_id AS id, relation, excerpt FROM memory_sources WHERE node_id = ? ORDER BY rowid DESC').all(row.id), aliases: this.database.prepare('SELECT alias FROM memory_aliases WHERE node_id = ? ORDER BY alias').all(row.id).map((item) => item.alias) };
  }

  async findByTopicKey(topicKey) {
    await this.initialize();
    const normalized = String(topicKey || '').trim().replace(/\s+/g, ' ');
    if (!normalized) return null;
    const row = this.database.prepare('SELECT id FROM memory_nodes WHERE topic_key = ?').get(normalized);
    return row ? this.get(row.id) : null;
  }

  async list({ tier = '', status = '', query = '', limit = 20, offset = 0 } = {}) {
    await this.initialize();
    const filters = [];
    const args = [];
    if (TIERS.has(tier)) { filters.push('tier = ?'); args.push(tier); }
    if (STATUSES.has(status)) { filters.push('status = ?'); args.push(status); }
    const term = String(query || '').trim().slice(0, 100);
    if (term) { filters.push('((instr(topic_key, ?) > 0 OR instr(content, ?) > 0) OR EXISTS (SELECT 1 FROM memory_aliases a WHERE a.node_id = memory_nodes.id AND instr(a.alias, ?) > 0))'); args.push(term, term, term); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const pageSize = Math.max(1, Math.min(50, Number(limit) || 20));
    const skip = Math.max(0, Number(offset) || 0);
    const total = this.database.prepare(`SELECT COUNT(*) AS count FROM memory_nodes ${where}`).get(...args).count;
    const rows = this.database.prepare(`SELECT * FROM memory_nodes ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, skip);
    return { nodes: rows.map(publicNode), total, limit: pageSize, offset: skip, hasMore: skip + rows.length < total };
  }

  async search({ query = '', limit = 10 } = {}) {
    await this.initialize();
    const phrase = String(query || '').trim().slice(0, 120).toLocaleLowerCase();
    if (!phrase) return [];
    const rows = this.database.prepare("SELECT * FROM memory_nodes WHERE status != 'archived'").all();
    const aliases = this.database.prepare('SELECT node_id, alias FROM memory_aliases').all();
    const aliasesByNode = new Map();
    for (const item of aliases) aliasesByNode.set(item.node_id, [...(aliasesByNode.get(item.node_id) || []), item.alias.toLocaleLowerCase()]);
    const ranked = [];
    for (const row of rows) {
      const title = row.topic_key.toLocaleLowerCase();
      const content = row.content.toLocaleLowerCase();
      const names = aliasesByNode.get(row.id) || [];
      const score = (title.includes(phrase) ? 100 : 0) + (names.some((name) => name.includes(phrase)) ? 70 : 0) + (content.includes(phrase) ? 15 : 0);
      if (score > 0) ranked.push({ node: publicNode(row), score });
    }
    ranked.sort((a, b) => b.score - a.score || b.node.updatedAt.localeCompare(a.node.updatedAt) || b.node.id.localeCompare(a.node.id));
    return ranked.slice(0, Math.max(1, Math.min(20, Number(limit) || 10))).map(({ node }) => node);
  }

  async matchText(text, limit = 3) {
    await this.initialize();
    const input = String(text || '').trim();
    if (!input) return [];
    const rows = this.database.prepare("SELECT * FROM memory_nodes WHERE status = 'active' AND tier = 'retrievable' ORDER BY updated_at DESC").all();
    const matches = [];
    for (const row of rows) {
      const aliases = this.database.prepare('SELECT alias FROM memory_aliases WHERE node_id = ?').all(row.id).map((item) => item.alias);
      const labels = [row.topic_key, ...aliases].filter((label) => label.length >= 2);
      if (labels.some((label) => input.includes(label))) matches.push(publicNode(row));
      if (matches.length >= Math.max(1, Math.min(20, Number(limit) || 3))) break;
    }
    return matches;
  }

  async addSource(nodeId, { type, id, relation = 'supports' } = {}) {
    await this.initialize();
    if (!SOURCE_TYPES.has(type) || !String(id || '').trim()) throw storeError(400, '来源类型或 ID 无效');
    if (!await this.get(nodeId)) throw storeError(404, '记忆节点不存在');
    const relationName = ['supports', 'corrects', 'contradicts'].includes(relation) ? relation : 'supports';
    this.database.prepare('INSERT OR IGNORE INTO memory_sources(node_id, source_type, source_id, relation, excerpt) VALUES(?, ?, ?, ?, ?)').run(nodeId, type, String(id), relationName, '');
    return this.get(nodeId);
  }

  async setAliases(nodeId, aliases = []) {
    await this.initialize();
    if (!await this.get(nodeId)) throw storeError(404, '记忆节点不存在');
    const values = [...new Set(aliases.map((value) => String(value || '').trim().slice(0, 80)).filter(Boolean))].slice(0, 20);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM memory_aliases WHERE node_id = ?').run(nodeId);
      for (const alias of values) this.database.prepare('INSERT INTO memory_aliases(node_id, alias) VALUES(?, ?)').run(nodeId, alias);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return this.get(nodeId);
  }

  async revisions(nodeId) {
    await this.initialize();
    return this.database.prepare('SELECT revision, snapshot, changed_at AS changedAt FROM memory_revisions WHERE node_id = ? ORDER BY revision DESC').all(nodeId).map((row) => ({ ...row, snapshot: JSON.parse(row.snapshot) }));
  }

  async reviewCursor(name = 'chat') {
    await this.initialize();
    const row = this.database.prepare('SELECT * FROM memory_review_cursor WHERE name = ?').get(name);
    return row ? { lastUserSeq: row.last_user_seq, lastCheckedAt: row.last_checked_at, lastDailyCheck: row.last_daily_check } : { lastUserSeq: 0, lastCheckedAt: null, lastDailyCheck: null };
  }

  async advanceReviewCursor(name, lastUserSeq, { dailyCheck = false } = {}) {
    await this.initialize();
    const date = this.now().toISOString();
    const beijingDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now());
    this.database.prepare(`INSERT INTO memory_review_cursor(name, last_user_seq, last_checked_at, last_daily_check)
      VALUES(?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET
      last_user_seq = MAX(last_user_seq, excluded.last_user_seq),
      last_checked_at = excluded.last_checked_at,
      last_daily_check = COALESCE(excluded.last_daily_check, last_daily_check)`).run(name, Math.max(0, Number(lastUserSeq) || 0), date, dailyCheck ? beijingDay : null);
    return this.reviewCursor(name);
  }

  async saveHandoff(text, { expiresAt } = {}) {
    await this.initialize();
    const now = this.now().toISOString();
    const until = expiresAt || new Date(new Date(now).getTime() + 7 * 86_400_000).toISOString();
    const id = `handoff-${randomUUID()}`;
    this.database.prepare('INSERT INTO thread_handoffs(id, text, created_at, expires_at) VALUES(?, ?, ?, ?)').run(id, String(text || '').trim().slice(0, 4_000), now, until);
    return { id, text: String(text || '').trim().slice(0, 4_000), createdAt: now, expiresAt: until };
  }

  async latestHandoff() {
    await this.initialize();
    const now = this.now().toISOString();
    const row = this.database.prepare('SELECT * FROM thread_handoffs WHERE consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1').get(now);
    if (!row) return null;
    return { id: row.id, text: row.text, createdAt: row.created_at };
  }

  async consumeHandoff(id = '') {
    const handoff = id ? { id } : await this.latestHandoff();
    if (!handoff) return null;
    await this.initialize();
    this.database.prepare('UPDATE thread_handoffs SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(this.now().toISOString(), handoff.id);
    return handoff;
  }

  #recordRevision(node) {
    const sources = this.database.prepare('SELECT source_type AS type, source_id AS id, relation FROM memory_sources WHERE node_id = ? ORDER BY rowid').all(node.id);
    const aliases = this.database.prepare('SELECT alias FROM memory_aliases WHERE node_id = ? ORDER BY alias').all(node.id).map((row) => row.alias);
    this.database.prepare('INSERT INTO memory_revisions(node_id, revision, snapshot, changed_at) VALUES(?, ?, ?, ?)')
      .run(node.id, node.revision, JSON.stringify({ ...publicNode(node), sources, aliases }), node.updated_at);
  }

  #importLegacyPrevious(memory, current) {
    const previous = memory.previousContent;
    const revision = Number(previous?.revision);
    if (!Number.isInteger(revision) || revision < 1 || revision >= current.revision) return;
    const topicKey = String(previous.title || '').trim();
    const content = String(previous.contentMarkdown || '').trim();
    if (!topicKey || !content) return;
    const snapshot = { ...publicNode(current), topicKey, content, revision };
    this.database.prepare('INSERT OR IGNORE INTO memory_revisions(node_id, revision, snapshot, changed_at) VALUES(?, ?, ?, ?)')
      .run(current.id, revision, JSON.stringify(snapshot), current.created_at);
  }
}

function normalizeNode(value, { id, now }) {
  const topic_key = String(value.topicKey ?? value.topic_key ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const content = String(value.content || '').trim().slice(0, 20_000);
  if (!topic_key || !content) throw storeError(400, '请输入主题键和简短内容');
  return {
    id, topic_key, content,
    owner: OWNERS.has(value.owner) ? value.owner : 'user',
    tier: TIERS.has(value.tier) ? value.tier : 'retrievable',
    status: STATUSES.has(value.status) ? value.status : 'active',
    revision: 1,
    created_at: now,
    updated_at: now,
  };
}

function publicNode(row) {
  return {
    id: row.id, topicKey: row.topic_key, content: row.content, owner: row.owner,
    tier: row.tier, status: row.status, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function storeError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
