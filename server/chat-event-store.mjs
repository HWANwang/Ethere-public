import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class ChatEventStore {
  constructor({ dataRoot, maxEvents = Number.POSITIVE_INFINITY }) {
    this.file = join(dataRoot, 'state', 'chat-events.json');
    this.databaseFile = join(dataRoot, 'state', 'chat-events.sqlite');
    this.maxEvents = maxEvents;
    this.database = null;
    this.loadPromise = null;
    this.writeChain = Promise.resolve();
    this.listeners = new Set();
  }

  async append(event) {
    const operation = this.writeChain.then(async () => {
      await this.#load();
      const id = String(event?.id || '').trim();
      if (!id) throw new Error('聊天事件缺少 ID');
      const existing = this.#byId(id);
      if (existing) return existing;
      const stored = {
        id,
        role: ['assistant', 'activity', 'notice'].includes(event.role) ? event.role : 'user',
        content: String(event.content || ''),
        createdAt: event.createdAt || new Date().toISOString(),
        status: event.status || 'completed',
        imageCount: Math.max(0, Number(event.imageCount) || 0),
        files: Array.isArray(event.files) ? event.files.slice(0, 3).map((file) => ({ id: String(file.id || ''), name: String(file.name || ''), size: Number(file.size) || 0 })) : [],
        replyTo: String(event.replyTo || ''),
        ...(event.role === 'user' && event.quote?.sourceMessageId && event.quote?.text ? {
          quote: {
            sourceMessageId: String(event.quote.sourceMessageId),
            sourceRole: event.quote.sourceRole === 'assistant' ? 'assistant' : 'user',
            text: String(event.quote.text).slice(0, 4000),
          },
        } : {}),
        turnComplete: event.turnComplete === true,
        source: ['checkin', 'compaction', 'mcp', 'settings', 'thread', 'reminder', 'space', 'phone-usage', 'developer-task', 'memory', 'device-action', 'voice-call'].includes(event.source) ? event.source : 'chat',
        ...(normalizeApproval(event.approval) ? { approval: normalizeApproval(event.approval) } : {}),
        ...(normalizeStudyCard(event.card) ? { card: normalizeStudyCard(event.card) } : {}),
      };
      const inserted = this.#insert(stored);
      this.#trim();
      this.#publish(inserted);
      return inserted;
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  async listAfter(cursor = 0, limit = 200) {
    await this.writeChain;
    await this.#load();
    const after = Math.max(0, Number(cursor) || 0);
    const latest = this.database.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM chat_events').get().seq;
    const pageSize = Math.max(1, Math.min(500, Number(limit) || 200));
    if (after > latest) {
      const events = this.database.prepare('SELECT seq, payload FROM chat_events ORDER BY seq LIMIT ?').all(pageSize).map(readEvent);
      return { events, cursor: events.at(-1)?.seq || latest, reset: true };
    }
    const events = this.database.prepare('SELECT seq, payload FROM chat_events WHERE seq > ? ORDER BY seq LIMIT ?').all(after, pageSize).map(readEvent);
    return { events, cursor: events.at(-1)?.seq || after, reset: false };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('聊天事件监听器必须是函数');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listHistory({ before = null, after = null, limit = 50, date = '', query = '', roles = null } = {}) {
    await this.writeChain;
    await this.#load();
    const pageSize = Math.max(1, Math.min(200, Number(limit) || 50));
    const beforeSeq = Number(before);
    const afterSeq = Number(after);
    const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : '';
    const literalQuery = String(query || '').trim();
    const filters = ["(role != 'notice' OR source IN ('phone-usage', 'device-action', 'voice-call'))", "(role != 'notice' OR content != '')", "NOT (role = 'notice' AND source = 'device-action' AND id LIKE 'device-action-result-%')"];
    const parameters = [];
    if (Array.isArray(roles) && roles.length) {
      const selectedRoles = roles.filter((role) => ['user', 'assistant', 'activity', 'notice'].includes(role));
      if (selectedRoles.length) { filters.push(`role IN (${selectedRoles.map(() => '?').join(',')})`); parameters.push(...selectedRoles); }
    }
    if (selectedDate) { filters.push('beijing_date = ?'); parameters.push(selectedDate); }
    if (literalQuery) { filters.push('instr(content, ?) > 0'); parameters.push(literalQuery); }
    if (selectedDate) {
      if (Number.isFinite(afterSeq) && afterSeq > 0) { filters.push('seq > ?'); parameters.push(afterSeq); }
      const rows = this.database.prepare(`SELECT seq, payload FROM chat_events WHERE ${filters.join(' AND ')} ORDER BY seq LIMIT ?`).all(...parameters, pageSize + 1);
      const events = rows.slice(0, pageSize).map(readEvent);
      return {
        events,
        after: events.at(-1)?.seq || null,
        hasMore: rows.length > pageSize,
        date: selectedDate,
        query: literalQuery,
      };
    }
    if (Number.isFinite(beforeSeq) && beforeSeq > 0) { filters.push('seq < ?'); parameters.push(beforeSeq); }
    const rows = this.database.prepare(`SELECT seq, payload FROM chat_events WHERE ${filters.join(' AND ')} ORDER BY seq DESC LIMIT ?`).all(...parameters, pageSize + 1);
    const events = rows.slice(0, pageSize).reverse().map(readEvent);
    return {
      events,
      before: events[0]?.seq || null,
      hasMore: rows.length > pageSize,
      date: selectedDate || null,
      query: literalQuery,
    };
  }

  async getById(id) {
    await this.writeChain;
    await this.#load();
    return this.#byId(id);
  }

  async listApprovals({ kind = '', status = 'pending' } = {}) {
    await this.writeChain;
    await this.#load();
    const rows = this.database.prepare('SELECT seq, payload FROM chat_events WHERE approval_kind IS NOT NULL ORDER BY seq').all();
    return rows.map(readEvent).filter((event) => (!kind || event.approval.kind === kind) && (!status || event.approval.status === status));
  }

  async update(id, patch = {}) {
    const operation = this.writeChain.then(async () => {
      await this.#load();
      const current = this.#byId(id);
      if (!current) return null;
      const next = {
        ...current,
        ...(typeof patch.content === 'string' ? { content: patch.content } : {}),
        ...(typeof patch.status === 'string' ? { status: patch.status } : {}),
        ...(patch.approval ? { approval: normalizeApproval(patch.approval) } : {}),
      };
      this.database.exec('BEGIN IMMEDIATE');
      let revised;
      try {
        this.database.prepare('DELETE FROM chat_events WHERE id = ?').run(id);
        revised = this.#insert(next);
        this.#trim();
        this.database.exec('COMMIT');
      } catch (error) { this.database.exec('ROLLBACK'); throw error; }
      this.#publish(revised);
      return revised;
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  async findReplyTo(id) {
    await this.writeChain;
    await this.#load();
    const row = this.database.prepare("SELECT seq, payload FROM chat_events WHERE reply_to = ? AND role = 'assistant' ORDER BY seq LIMIT 1").get(id);
    return row ? readEvent(row) : null;
  }

  async listRepliesTo(id) {
    await this.writeChain;
    await this.#load();
    return this.database.prepare("SELECT seq, payload FROM chat_events WHERE reply_to = ? AND role IN ('assistant', 'activity') ORDER BY seq").all(id).map(readEvent);
  }

  async reviewBatch(afterSeq = 0, userLimit = 50) {
    await this.writeChain;
    await this.#load();
    const start = Math.max(0, Number(afterSeq) || 0);
    const users = this.database.prepare("SELECT seq FROM chat_events WHERE seq > ? AND role = 'user' ORDER BY seq LIMIT ?").all(start, Math.max(1, Math.min(100, Number(userLimit) || 50)));
    const targetSeq = users.at(-1)?.seq || start;
    const events = users.length
      ? this.database.prepare("SELECT seq, payload FROM chat_events WHERE seq > ? AND seq <= ? AND role IN ('user', 'assistant') ORDER BY seq LIMIT 500").all(start, targetSeq).map(readEvent)
      : [];
    const includedUsers = events.filter((event) => event.role === 'user');
    return { events, userCount: includedUsers.length, lastUserSeq: includedUsers.at(-1)?.seq || start };
  }

  async latestUserSeq() {
    await this.writeChain;
    await this.#load();
    return this.database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM chat_events WHERE role = 'user'").get().seq;
  }

  async #load() {
    if (this.database) return;
    if (!this.loadPromise) this.loadPromise = this.#open().catch((error) => { this.loadPromise = null; throw error; });
    await this.loadPromise;
  }

  async #open() {
    await mkdir(dirname(this.databaseFile), { recursive: true });
    const database = new DatabaseSync(this.databaseFile);
    database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
    database.exec(`CREATE TABLE IF NOT EXISTS chat_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      source TEXT NOT NULL,
      reply_to TEXT NOT NULL,
      created_at TEXT NOT NULL,
      beijing_date TEXT NOT NULL,
      content TEXT NOT NULL,
      approval_kind TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_events_date_seq ON chat_events(beijing_date, seq);
    CREATE INDEX IF NOT EXISTS chat_events_reply_to ON chat_events(reply_to, seq);
    CREATE INDEX IF NOT EXISTS chat_events_approval ON chat_events(approval_kind, seq);
    CREATE TABLE IF NOT EXISTS chat_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const migrated = database.prepare("SELECT value FROM chat_meta WHERE key = 'legacy_imported'").get();
    if (!migrated) {
      let legacy = [];
      try {
        const saved = JSON.parse(await readFile(this.file, 'utf8'));
        if (!Array.isArray(saved.events)) throw new Error('旧聊天记录格式错误');
        legacy = saved.events;
      } catch (error) { if (error.code !== 'ENOENT') { database.close(); throw error; } }
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const event of legacy) insertEvent(database, event, event.seq);
        database.prepare("INSERT INTO chat_meta(key, value) VALUES('legacy_imported', ?)").run(String(legacy.length));
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); database.close(); throw error; }
    }
    this.database = database;
  }

  #byId(id) {
    const row = this.database.prepare('SELECT seq, payload FROM chat_events WHERE id = ?').get(String(id || ''));
    return row ? readEvent(row) : null;
  }

  #insert(event) { return insertEvent(this.database, event); }

  #trim() {
    if (!Number.isFinite(this.maxEvents)) return;
    this.database.prepare('DELETE FROM chat_events WHERE seq NOT IN (SELECT seq FROM chat_events ORDER BY seq DESC LIMIT ?)').run(Math.max(0, this.maxEvents));
  }

  #publish(event) {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* 一个断开的客户端不能影响事件写入。 */ }
    }
  }
}

function insertEvent(database, event, seq = null) {
  const payload = JSON.stringify(event);
  const values = [String(event.id), String(event.role), String(event.source || 'chat'), String(event.replyTo || ''), String(event.createdAt || ''), beijingDateKey(event.createdAt), String(event.content || ''), event.approval?.kind || null, payload];
  const result = seq == null
    ? database.prepare('INSERT INTO chat_events(id, role, source, reply_to, created_at, beijing_date, content, approval_kind, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...values)
    : database.prepare('INSERT INTO chat_events(seq, id, role, source, reply_to, created_at, beijing_date, content, approval_kind, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(seq, ...values);
  return { ...event, seq: Number(result.lastInsertRowid) };
}

function readEvent(row) { return { ...JSON.parse(row.payload), seq: row.seq }; }

function normalizeStudyCard(value) {
  if (value?.kind !== 'study-plan' || !['created', 'opened', 'updated'].includes(value.action)) return null;
  const title = String(value.title || '').trim().slice(0, 80);
  if (!title) return null;
  return {
    kind: 'study-plan', action: value.action, title,
    planId: String(value.planId || '').slice(0, 80),
    currentLesson: String(value.currentLesson || '').slice(0, 100),
    completedCount: Math.max(0, Number(value.completedCount) || 0),
    lessonCount: Math.max(0, Math.min(24, Number(value.lessonCount) || 0)),
  };
}

function normalizeApproval(value) {
  if (!value) return null;
  if (value.kind === 'memory-change') return normalizeMemoryApproval(value);
  if (value.kind === 'document-change') return normalizeDocumentApproval(value);
  if (value.kind === 'dida-task-change') return normalizeDidaTaskApproval(value);
  if (value.kind === 'dida-task-with-reminder') return normalizeTaskReminderApproval(value);
  if (value.kind !== 'timeline-category-create') return null;
  const proposal = value.proposal || {};
  const level = proposal.level === 'primary' ? 'primary' : proposal.level === 'secondary' ? 'secondary' : '';
  const name = String(proposal.name || '').trim().slice(0, 40);
  const reason = String(proposal.reason || '').trim().slice(0, 200);
  const parentCategoryId = String(proposal.parentCategoryId || '').trim().slice(0, 100);
  const color = /^#[0-9A-Fa-f]{6}$/.test(String(proposal.color || '')) ? String(proposal.color).toUpperCase() : '';
  if (!level || !name || !reason || (level === 'secondary' && !parentCategoryId)) return null;
  return {
    kind: 'timeline-category-create',
    status: ['pending', 'accepted', 'rejected'].includes(value.status) ? value.status : 'pending',
    proposal: { level, name, reason, ...(parentCategoryId ? { parentCategoryId } : {}), ...(color ? { color } : {}) },
    ...(value.resolvedAt ? { resolvedAt: String(value.resolvedAt) } : {}),
    ...(value.categoryId ? { categoryId: String(value.categoryId) } : {}),
    ...(value.subcategoryId ? { subcategoryId: String(value.subcategoryId) } : {}),
  };
}

function normalizeDidaTaskApproval(value) {
  const proposal = value.proposal || {};
  const operation = proposal.operation === 'create' ? 'create' : proposal.operation === 'update' ? 'update' : '';
  const projectId = String(proposal.projectId || '').trim().slice(0, 120);
  const projectName = String(proposal.projectName || '').trim().slice(0, 120);
  const taskId = String(proposal.taskId || '').trim().slice(0, 120);
  const taskTitle = String(proposal.taskTitle || '').trim().slice(0, 300);
  const title = String(proposal.title || '').trim().slice(0, 300);
  const reason = String(proposal.reason || '').trim().slice(0, 240);
  if (!operation || !reason || (operation === 'create' && (!projectId || !title)) || (operation === 'update' && !taskId)) return null;
  return {
    kind: 'dida-task-change',
    status: ['pending', 'accepted', 'rejected'].includes(value.status) ? value.status : 'pending',
    proposal: {
      operation, reason,
      ...(projectId ? { projectId } : {}), ...(projectName ? { projectName } : {}),
      ...(taskId ? { taskId } : {}), ...(taskTitle ? { taskTitle } : {}), ...(title ? { title } : {}),
      ...(proposal.content !== undefined ? { content: String(proposal.content || '').trim().slice(0, 8_000) } : {}),
      ...(proposal.startAt !== undefined ? { startAt: proposal.startAt === null ? null : String(proposal.startAt) } : {}),
      ...(proposal.dueAt !== undefined ? { dueAt: proposal.dueAt === null ? null : String(proposal.dueAt) } : {}),
      ...(proposal.isAllDay !== undefined ? { isAllDay: proposal.isAllDay === true } : {}),
      ...([0, 1, 3, 5].includes(Number(proposal.priority)) ? { priority: Number(proposal.priority) } : {}),
      ...(proposal.repeatFlag !== undefined ? { repeatFlag: proposal.repeatFlag === null ? null : String(proposal.repeatFlag).trim().slice(0, 160) } : {}),
    },
    ...(value.resolvedAt ? { resolvedAt: String(value.resolvedAt) } : {}),
    ...(value.taskId ? { taskId: String(value.taskId) } : {}),
  };
}

function normalizeTaskReminderApproval(value) {
  const raw = value.proposal || {};
  const taskApproval = normalizeDidaTaskApproval({ proposal: raw.task || {} });
  const reminder = raw.reminder || {};
  const title = String(taskApproval?.proposal.title || '').trim().slice(0, 120);
  const message = String(reminder.message || '').trim().slice(0, 2000);
  const triggerAt = String(reminder.triggerAt || '').trim();
  const repeatMinutes = reminder.repeatMinutes === undefined ? 0 : Number(reminder.repeatMinutes);
  if (!taskApproval || taskApproval.proposal.operation !== 'create' || !title || !message || Number.isNaN(new Date(triggerAt).getTime())
    || !Number.isInteger(repeatMinutes) || repeatMinutes < 0 || (repeatMinutes > 0 && repeatMinutes < 5) || repeatMinutes > 10080) return null;
  const statuses = ['pending', 'task-creating', 'task-created', 'task-uncertain', 'accepted', 'rejected'];
  return {
    kind: 'dida-task-with-reminder',
    status: statuses.includes(value.status) ? value.status : 'pending',
    proposal: {
      task: taskApproval.proposal,
      reminder: { title, message, triggerAt, ...(repeatMinutes ? { repeatMinutes } : {}) },
      reason: String(raw.reason || taskApproval.proposal.reason || '').trim().slice(0, 240),
    },
    ...(value.taskId ? { taskId: String(value.taskId).slice(0, 160) } : {}),
    ...(value.reminderId ? { reminderId: String(value.reminderId).slice(0, 160) } : {}),
    ...(value.lastError ? { lastError: String(value.lastError).slice(0, 300) } : {}),
    ...(value.resolvedAt ? { resolvedAt: String(value.resolvedAt) } : {}),
  };
}

function normalizeMemoryApproval(value) {
  const proposal = value.proposal || {};
  const operation = ['create', 'update', 'promote'].includes(proposal.operation) ? proposal.operation : '';
  const title = String(proposal.title || '').trim().slice(0, 80);
  const contentMarkdown = String(proposal.contentMarkdown || '').trim().slice(0, 20_000);
  const reason = String(proposal.reason || '').trim().slice(0, 240);
  const targetMemoryId = String(proposal.targetMemoryId || '').trim().slice(0, 120);
  const baseRevision = Number(proposal.baseRevision);
  if (!operation || !title || !contentMarkdown || !reason || (operation !== 'create' && !targetMemoryId)
    || (operation === 'promote' && (!Number.isInteger(baseRevision) || baseRevision < 1))) return null;
  const duplicate = proposal.duplicateCandidate;
  const duplicateCandidate = duplicate && String(duplicate.memoryId || '').trim()
    ? {
      memoryId: String(duplicate.memoryId).trim().slice(0, 120),
      title: String(duplicate.title || '').trim().slice(0, 80),
      revision: Math.max(1, Number(duplicate.revision) || 1),
      reason: String(duplicate.reason || '').trim().slice(0, 80),
      score: Math.max(0, Math.min(1, Number(duplicate.score) || 0)),
    } : null;
  return {
    kind: 'memory-change',
    status: ['pending', 'accepted', 'rejected'].includes(value.status) ? value.status : 'pending',
    proposal: {
      operation, title, contentMarkdown, reason,
      ...(targetMemoryId ? { targetMemoryId } : {}),
      ...(Number.isInteger(baseRevision) ? { baseRevision } : {}),
      ...(duplicateCandidate ? { duplicateCandidate } : {}),
    },
    ...(value.resolvedAt ? { resolvedAt: String(value.resolvedAt) } : {}),
    ...(value.memoryId ? { memoryId: String(value.memoryId) } : {}),
    ...(value.application ? { application: {
      applied: value.application.applied === true,
      status: String(value.application.status || 'pending').slice(0, 40),
      ...(value.application.error ? { error: String(value.application.error).slice(0, 300) } : {}),
    } } : {}),
  };
}

function normalizeDocumentApproval(value) {
  const proposal = value.proposal || {};
  const name = ['persona', 'operations'].includes(proposal.name) ? proposal.name : '';
  const baseRevision = String(proposal.baseRevision || '');
  const previousText = String(proposal.previousText ?? '').slice(0, 40_000);
  const text = String(proposal.text ?? '').trim().slice(0, 40_000);
  const reason = String(proposal.reason || '').trim().slice(0, 240);
  if (!name || !/^[a-f0-9]{16}$/.test(baseRevision) || !text || !reason) return null;
  return {
    kind: 'document-change',
    status: ['pending', 'accepted', 'rejected'].includes(value.status) ? value.status : 'pending',
    proposal: { name, baseRevision, previousText, text, reason },
    ...(value.resolvedAt ? { resolvedAt: String(value.resolvedAt) } : {}),
    ...(value.application ? { application: value.application } : {}),
  };
}

function beijingDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
