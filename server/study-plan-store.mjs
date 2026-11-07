import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const MAX_LESSONS = 24;

export class StudyPlanStore {
  constructor({ dataRoot, now = () => new Date() }) {
    this.file = join(dataRoot, 'learning', 'study-plans.sqlite');
    this.now = now;
    this.database = null;
    this.loadPromise = null;
  }

  async initialize() {
    if (this.database) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const database = new DatabaseSync(this.file);
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS study_plans (
          id TEXT PRIMARY KEY,
          title_key TEXT NOT NULL UNIQUE,
          revision INTEGER NOT NULL,
          status TEXT NOT NULL,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS study_plans_updated ON study_plans(updated_at DESC);
        CREATE TABLE IF NOT EXISTS study_plan_versions (
          plan_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY(plan_id, revision)
        );
      `);
      this.database = database;
    })();
    try { await this.loadPromise; } finally { this.loadPromise = null; }
  }

  async list({ includeArchived = false } = {}) {
    await this.initialize();
    const rows = this.database.prepare(`SELECT payload FROM study_plans ${includeArchived ? '' : "WHERE status != 'archived'"} ORDER BY updated_at DESC LIMIT 100`).all();
    return rows.map((row) => summary(JSON.parse(row.payload)));
  }

  close() {
    this.database?.close();
    this.database = null;
  }

  async get(id) {
    await this.initialize();
    const row = this.database.prepare('SELECT payload FROM study_plans WHERE id = ?').get(String(id || ''));
    return row ? JSON.parse(row.payload) : null;
  }

  async create({ title, goal = '', lessons }) {
    await this.initialize();
    const cleanTitle = bounded(title, 80, '学习计划标题');
    const cleanLessons = normalizeNewLessons(lessons);
    const timestamp = this.now().toISOString();
    const plan = {
      id: randomUUID(), title: cleanTitle, goal: optionalText(goal, 400),
      status: 'active', revision: 1, lessons: cleanLessons,
      currentLessonId: cleanLessons[0].id, checkpoint: '',
      createdAt: timestamp, updatedAt: timestamp,
    };
    try {
      this.database.prepare('INSERT INTO study_plans(id, title_key, revision, status, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(plan.id, titleKey(cleanTitle), 1, plan.status, JSON.stringify(plan), timestamp);
    } catch (error) {
      if (String(error).includes('UNIQUE constraint')) throw storeError(409, '已有同名学习计划，请先打开并续学或修改');
      throw error;
    }
    return plan;
  }

  async update(id, { baseRevision, action, ...input } = {}) {
    await this.initialize();
    if (!Number.isInteger(baseRevision) || baseRevision < 1) throw storeError(400, '修改学习计划需要当前 revision');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database.prepare('SELECT payload FROM study_plans WHERE id = ?').get(String(id || ''));
      if (!row) throw storeError(404, '学习计划不存在');
      const current = JSON.parse(row.payload);
      if (current.revision !== baseRevision) throw storeError(409, '学习计划已更新，请重新读取后再修改');
      const next = applyAction(current, action, input);
      next.revision += 1;
      next.updatedAt = this.now().toISOString();
      this.database.prepare('INSERT INTO study_plan_versions(plan_id, revision, payload) VALUES (?, ?, ?)')
        .run(current.id, current.revision, JSON.stringify(current));
      this.database.prepare('UPDATE study_plans SET title_key = ?, revision = ?, status = ?, payload = ?, updated_at = ? WHERE id = ?')
        .run(titleKey(next.title), next.revision, next.status, JSON.stringify(next), next.updatedAt, current.id);
      this.database.exec('COMMIT');
      return next;
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (String(error).includes('UNIQUE constraint')) throw storeError(409, '已有同名学习计划');
      throw error;
    }
  }
}

function applyAction(current, action, input) {
  const next = structuredClone(current);
  if (action === 'checkpoint') {
    if (next.status === 'archived') throw storeError(409, '已归档的计划不能更新进度');
    next.checkpoint = bounded(input.note, 500, '暂停点');
    if (input.lessonId) next.currentLessonId = requireLesson(next, input.lessonId).id;
    next.status = 'active';
  } else if (action === 'complete_lesson') {
    if (next.status === 'archived') throw storeError(409, '已归档的计划不能更新进度');
    const lesson = requireLesson(next, input.lessonId || next.currentLessonId);
    if (lesson.id !== next.currentLessonId || lesson.status === 'done') {
      throw storeError(409, '只能完成当前正在学习的课节；请先读取最新进度');
    }
    lesson.status = 'done';
    lesson.summary = bounded(input.summary, 500, '本节摘要');
    const following = next.lessons.find((item) => item.status !== 'done');
    next.currentLessonId = following?.id || '';
    next.checkpoint = '';
    next.status = following ? 'active' : 'completed';
  } else if (action === 'focus_lesson') {
    next.currentLessonId = requireLesson(next, input.lessonId).id;
    next.checkpoint = '';
    next.status = 'active';
  } else if (action === 'revise_outline') {
    const requested = Array.isArray(input.lessons) ? input.lessons : [];
    if (!requested.length || requested.length > MAX_LESSONS) throw storeError(400, '学习大纲需有 1 至 24 节');
    const prior = new Map(next.lessons.map((lesson) => [lesson.id, lesson]));
    const used = new Set();
    next.lessons = requested.map((item) => {
      const old = item?.id ? prior.get(String(item.id)) : null;
      if (item?.id && !old) throw storeError(400, '大纲包含不存在的课节 ID');
      if (old && used.has(old.id)) throw storeError(400, '大纲重复引用了同一课节');
      if (old) used.add(old.id);
      return old ? { ...old, title: bounded(item.title, 100, '课节标题') }
        : { id: randomUUID(), title: bounded(item?.title, 100, '课节标题'), status: 'pending', summary: '' };
    });
    if (new Set(next.lessons.map((item) => item.title.toLocaleLowerCase('zh-CN'))).size !== next.lessons.length) {
      throw storeError(400, '学习大纲有重复课节');
    }
    const omittedDone = [...prior.values()].some((item) => item.status === 'done' && !used.has(item.id));
    if (omittedDone) throw storeError(409, '不能直接移除已讲课节；请保留其 ID 和摘要');
    if (!next.lessons.some((item) => item.id === next.currentLessonId)) {
      next.currentLessonId = next.lessons.find((item) => item.status !== 'done')?.id || '';
      next.checkpoint = '';
    }
    next.status = next.currentLessonId ? 'active' : 'completed';
  } else if (action === 'rename') {
    next.title = bounded(input.title, 80, '学习计划标题');
    if (input.goal !== undefined) next.goal = optionalText(input.goal, 400);
  } else if (action === 'pause') {
    next.status = 'paused';
  } else if (action === 'archive') {
    next.status = 'archived';
  } else if (action === 'resume') {
    next.status = next.currentLessonId ? 'active' : 'completed';
  } else {
    throw storeError(400, '未知的学习计划操作');
  }
  return next;
}

function normalizeNewLessons(lessons) {
  if (!Array.isArray(lessons) || !lessons.length || lessons.length > MAX_LESSONS) throw storeError(400, '学习大纲需有 1 至 24 节');
  const result = lessons.map((item) => ({ id: randomUUID(), title: bounded(typeof item === 'string' ? item : item?.title, 100, '课节标题'), status: 'pending', summary: '' }));
  if (new Set(result.map((item) => item.title.toLocaleLowerCase('zh-CN'))).size !== result.length) throw storeError(400, '学习大纲有重复课节');
  return result;
}

function requireLesson(plan, id) {
  const lesson = plan.lessons.find((item) => item.id === String(id || ''));
  if (!lesson) throw storeError(404, '课节不存在，请重新打开学习计划');
  return lesson;
}

function summary(plan) {
  const current = plan.lessons.find((item) => item.id === plan.currentLessonId);
  return {
    id: plan.id, title: plan.title, goal: plan.goal, status: plan.status, revision: plan.revision,
    completedCount: plan.lessons.filter((item) => item.status === 'done').length,
    lessonCount: plan.lessons.length, currentLessonId: current?.id || '', currentLessonTitle: current?.title || '',
    checkpoint: plan.checkpoint, updatedAt: plan.updatedAt,
  };
}

function bounded(value, maximum, field) {
  const text = String(value || '').trim();
  if (!text || text.length > maximum) throw storeError(400, `${field}需为 1 至 ${maximum} 字`);
  return text;
}

function optionalText(value, maximum) {
  const text = String(value || '').trim();
  if (text.length > maximum) throw storeError(400, `说明不能超过 ${maximum} 字`);
  return text;
}

function titleKey(value) { return String(value).trim().toLocaleLowerCase('zh-CN'); }

function storeError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
