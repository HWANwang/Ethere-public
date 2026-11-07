import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const STATUSES = new Set(['scheduled', 'completed', 'cancelled']);

export function validateLinkedReminderDraft(value = {}, now = new Date()) {
  if (!String(value.title || '').trim()) throw httpError(400, '提醒标题不能为空');
  if (!String(value.triggerAt || '').trim()) throw httpError(400, '请设置首次提醒时间');
  const reminder = normalizeInput(value, { now: now.toISOString(), author: 'ai' });
  if (new Date(reminder.triggerAt).getTime() <= now.getTime()) throw httpError(409, '提醒时间已过，请重新设置后再审批');
  return {
    title: reminder.title, message: reminder.message, triggerAt: reminder.triggerAt,
    ...(reminder.repeatMinutes ? { repeatMinutes: reminder.repeatMinutes } : {}),
  };
}

export class ReminderStore {
  constructor({ dataRoot, now = () => new Date() }) {
    this.file = join(dataRoot, 'reminders', 'reminders.json');
    this.now = now;
    this.items = [];
    this.loaded = false;
    this.writeChain = Promise.resolve();
    this.listeners = new Set();
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('提醒变更监听器必须是函数');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      this.items = Array.isArray(value?.reminders) ? value.reminders.map(normalizeStored).filter(Boolean) : [];
    } catch {
      this.items = [];
    }
  }

  async list({ status = '' } = {}) {
    await this.initialize();
    const statuses = String(status || '').split(',').map((item) => item.trim()).filter(Boolean);
    return this.items
      .filter((item) => !statuses.length || statuses.includes(item.status))
      .sort((a, b) => a.triggerAt.localeCompare(b.triggerAt))
      .map(clone);
  }

  async get(id) {
    await this.initialize();
    const item = this.items.find((candidate) => candidate.id === String(id));
    return item ? clone(item) : null;
  }

  async create(input, { author = 'ai' } = {}) {
    await this.initialize();
    const now = this.now().toISOString();
    const reminder = normalizeInput(input, { now, author, recalculateDaily: true });
    return this.#write(async () => {
      if (this.items.some((item) => item.id === reminder.id)) throw httpError(409, '提醒 ID 已存在');
      this.items.push(reminder);
      await this.#persist();
      return clone(reminder);
    });
  }

  async update(id, patch, { baseRevision } = {}) {
    await this.initialize();
    return this.#write(async () => {
      const index = this.items.findIndex((item) => item.id === String(id));
      if (index < 0) throw httpError(404, '提醒任务不存在');
      const current = this.items[index];
      assertRevision(current, baseRevision);
      if (current.status !== 'scheduled') throw httpError(409, '只能修改待触发的提醒');
      const merged = normalizeInput({ ...current, ...patch, id: current.id }, {
        now: this.now().toISOString(), author: current.author, revision: current.revision + 1, createdAt: current.createdAt,
        recalculateDaily: Object.hasOwn(patch, 'dailyAt') || Object.hasOwn(patch, 'timezone'),
      });
      this.items[index] = merged;
      await this.#persist();
      return clone(merged);
    });
  }

  async cancel(id, { baseRevision } = {}) {
    return this.#transition(id, baseRevision, (item, now) => ({ ...item, status: 'cancelled', updatedAt: now, revision: item.revision + 1 }));
  }

  async complete(id, { firedAt = null, baseRevision = null } = {}) {
    return this.#transition(id, baseRevision, (item, now) => ({ ...item, status: 'completed', firedAt: firedAt || now, updatedAt: now, lastError: '', revision: item.revision + 1 }));
  }

  async rescheduleAfterFire(id, triggerAt, { firedAt = null, baseRevision = null } = {}) {
    return this.#transition(id, baseRevision, (item, now) => ({ ...item, status: 'scheduled', triggerAt: isoDate(triggerAt, '下次提醒时间'), firedAt: firedAt || now, updatedAt: now, lastError: '', revision: item.revision + 1 }));
  }

  async rescheduleDailyAfterFire(id, { firedAt = null, baseRevision = null } = {}) {
    return this.#transition(id, baseRevision, (item, now) => {
      if (!item.dailyAt) throw httpError(409, '这不是每日提醒');
      const successAt = firedAt || now;
      const lastSuccessDate = localDateKey(new Date(successAt), item.timezone);
      return {
        ...item,
        status: 'scheduled',
        triggerAt: nextDailyTrigger(new Date(now), item.dailyAt, item.timezone, lastSuccessDate),
        lastSuccessDate,
        firedAt: successAt,
        updatedAt: now,
        lastError: '',
        revision: item.revision + 1,
      };
    });
  }

  async retry(id, triggerAt, error, { baseRevision = null } = {}) {
    return this.#transition(id, baseRevision, (item, now) => ({ ...item, status: 'scheduled', triggerAt: isoDate(triggerAt, '重试时间'), updatedAt: now, lastError: String(error || '').slice(0, 500), revision: item.revision + 1 }));
  }

  async due(now = this.now()) {
    await this.initialize();
    const timestamp = now.getTime();
    return this.items.filter((item) => item.status === 'scheduled' && new Date(item.triggerAt).getTime() <= timestamp).sort((a, b) => a.triggerAt.localeCompare(b.triggerAt)).map(clone);
  }

  async next() {
    const scheduled = await this.list({ status: 'scheduled' });
    return scheduled[0] || null;
  }

  async #transition(id, baseRevision, transform) {
    await this.initialize();
    return this.#write(async () => {
      const index = this.items.findIndex((item) => item.id === String(id));
      if (index < 0) throw httpError(404, '提醒任务不存在');
      const current = this.items[index];
      if (baseRevision != null) assertRevision(current, baseRevision);
      const next = transform(current, this.now().toISOString());
      this.items[index] = next;
      await this.#persist();
      return clone(next);
    });
  }

  #write(operation) {
    const next = this.writeChain.then(operation);
    this.writeChain = next.catch(() => {});
    return next;
  }

  async #persist() {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 2, reminders: this.items }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, this.file);
    const scheduledCount = this.items.filter((item) => item.status === 'scheduled').length;
    for (const listener of this.listeners) {
      try { listener({ scheduledCount }); } catch { /* A disconnected browser must not fail a reminder write. */ }
    }
  }
}

function normalizeInput(value = {}, { now, author, revision = 1, createdAt = now, recalculateDaily = false }) {
  const message = String(value.message || '').trim().slice(0, 2000);
  if (!message) throw httpError(400, '提醒内容不能为空');
  const dailyAt = dailyTime(value.dailyAt);
  const timezone = dailyAt ? validTimezone(value.timezone || 'Asia/Shanghai') : '';
  const repeatMinutes = value.repeatMinutes == null || value.repeatMinutes === '' ? 0 : Number(value.repeatMinutes);
  if (!Number.isInteger(repeatMinutes) || repeatMinutes < 0 || repeatMinutes > 10_080 || (repeatMinutes > 0 && repeatMinutes < 5)) {
    throw httpError(400, '复查间隔必须为 0，或 5 至 10080 分钟');
  }
  if (dailyAt && repeatMinutes > 0) throw httpError(400, '每日提醒不能同时设置复查间隔');
  if (dailyAt && value.relatedTaskId) throw httpError(400, '每日提醒不能关联监督任务');
  const lastSuccessDate = dailyAt ? validDateKey(value.lastSuccessDate) : '';
  const triggerAt = dailyAt && (recalculateDaily || !value.triggerAt)
    ? nextDailyTrigger(new Date(now), dailyAt, timezone, lastSuccessDate)
    : isoDate(value.triggerAt, '提醒时间');
  return {
    id: String(value.id || `reminder_${randomUUID()}`),
    revision,
    title: String(value.title || message).trim().slice(0, 120),
    message,
    triggerAt,
    repeatMinutes,
    dailyAt,
    timezone,
    catchUpPolicy: dailyAt ? 'latest_once' : '',
    lastSuccessDate,
    relatedTaskId: String(value.relatedTaskId || '').trim().slice(0, 160),
    relatedTaskTitle: String(value.relatedTaskTitle || '').trim().slice(0, 300),
    status: 'scheduled',
    author: author === 'user' ? 'user' : 'ai',
    createdAt,
    updatedAt: now,
    firedAt: null,
    lastError: '',
  };
}

function normalizeStored(value) {
  if (!value || typeof value !== 'object' || !value.id || !STATUSES.has(value.status)) return null;
  try {
    const normalized = normalizeInput(value, { now: value.updatedAt || new Date().toISOString(), author: value.author, revision: Number(value.revision) || 1, createdAt: value.createdAt });
    return { ...normalized, status: value.status, firedAt: value.firedAt || null, lastError: String(value.lastError || '') };
  } catch { return null; }
}

function isoDate(value, label) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) throw httpError(400, `${label}无效`);
  return date.toISOString();
}
function dailyTime(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) throw httpError(400, '每日提醒时间必须是 HH:mm');
  return text;
}
function validTimezone(value) {
  const timezone = String(value || '').trim();
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()); }
  catch { throw httpError(400, '时区无效'); }
  return timezone;
}
function validDateKey(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}
export function localDateKey(date, timezone) {
  const parts = zonedParts(date, timezone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}
export function nextDailyTrigger(now, dailyAt, timezone, lastSuccessDate = '') {
  const current = zonedParts(now, timezone);
  const [hour, minute] = dailyAt.split(':').map(Number);
  let date = { year: current.year, month: current.month, day: current.day };
  let candidate = zonedDateToUtc({ ...date, hour, minute }, timezone);
  const today = `${date.year}-${pad(date.month)}-${pad(date.day)}`;
  if (candidate.getTime() <= now.getTime() || (lastSuccessDate && today <= lastSuccessDate)) {
    const following = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
    date = { year: following.getUTCFullYear(), month: following.getUTCMonth() + 1, day: following.getUTCDate() };
    candidate = zonedDateToUtc({ ...date, hour, minute }, timezone);
  }
  return candidate.toISOString();
}
function zonedDateToUtc(target, timezone) {
  const targetWall = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  let guess = new Date(targetWall);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const shown = zonedParts(guess, timezone);
    const shownWall = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
    guess = new Date(guess.getTime() + targetWall - shownWall);
  }
  return guess;
}
function zonedParts(date, timezone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return values;
}
function pad(value) { return String(value).padStart(2, '0'); }
function assertRevision(item, baseRevision) {
  if (!Number.isInteger(Number(baseRevision)) || Number(baseRevision) !== item.revision) throw httpError(409, '提醒已变化，请刷新后重试');
}
function clone(value) { return structuredClone(value); }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
