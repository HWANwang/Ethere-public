import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SCHEMA_VERSION = 1;
const MAX_EVENT_DURATION_MS = 48 * 60 * 60 * 1_000;
const MAX_MUTATIONS_PER_DAY = 500;
const CATEGORY_STATUSES = new Set(['active', 'inactive']);
const EVENT_AUTHORS = new Set(['user', 'ai']);

export const DEFAULT_TIMELINE_CATEGORIES = Object.freeze([
  category('uncategorized', '未分类', '#9398A5', [['to-organize', '待整理']]),
]);

export class TimelineStore {
  constructor({ dataRoot, now = () => new Date(), idFactory = () => `evt_${randomUUID()}`, initialCategories = DEFAULT_TIMELINE_CATEGORIES } = {}) {
    if (!dataRoot) throw new Error('缺少时间轴数据目录');
    this.root = join(dataRoot, 'timeline');
    this.categoriesFile = join(this.root, 'categories.json');
    this.now = now;
    this.idFactory = idFactory;
    this.initialCategories = clone(initialCategories);
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    await this.#write(async () => {
      try {
        await readFile(this.categoriesFile, 'utf8');
      } catch {
        await writeJsonAtomic(this.categoriesFile, {
          schemaVersion: SCHEMA_VERSION,
          revision: 1,
          updatedAt: this.now().toISOString(),
          categories: clone(this.initialCategories),
        });
      }
    });
    return this.listCategories({ includeInactive: true });
  }

  async listCategories({ includeInactive = false } = {}) {
    const document = await this.#readCategories();
    const categories = document.categories
      .filter((item) => includeInactive || item.status === 'active')
      .map((item) => ({
        ...item,
        children: item.children.filter((child) => includeInactive || child.status === 'active'),
      }));
    return { revision: document.revision, categories: clone(categories) };
  }

  async addCategory({ id, name, color, children = [], baseRevision } = {}) {
    return this.#updateCategories(baseRevision, (document) => {
      const normalizedId = stableId(id);
      if (document.categories.some((item) => item.id === normalizedId)) throw httpError(409, '分类 ID 已存在');
      document.categories.push(normalizeCategory({ id: normalizedId, name, color, status: 'active', children }));
    });
  }

  async addSubcategory({ categoryId, id, name, baseRevision } = {}) {
    return this.#updateCategories(baseRevision, (document) => {
      const parent = findCategoryTarget(document.categories, categoryId, null);
      const normalizedId = stableId(id);
      if (parent.children.some((item) => item.id === normalizedId)) throw httpError(409, '二级分类 ID 已存在');
      parent.children.push({ id: normalizedId, name: displayName(name), status: 'active' });
    });
  }

  async renameCategory({ categoryId, subcategoryId = null, name, color, baseRevision } = {}) {
    return this.#updateCategories(baseRevision, (document) => {
      const target = findCategoryTarget(document.categories, categoryId, subcategoryId);
      target.name = displayName(name);
      if (!subcategoryId && color !== undefined) target.color = categoryColor(color);
    });
  }

  async setCategoryStatus({ categoryId, subcategoryId = null, status, baseRevision } = {}) {
    if (!CATEGORY_STATUSES.has(status)) throw httpError(400, '分类状态无效');
    if (categoryId === 'uncategorized') throw httpError(400, '未分类兜底项不能停用');
    return this.#updateCategories(baseRevision, (document) => {
      const target = findCategoryTarget(document.categories, categoryId, subcategoryId);
      target.status = status;
    });
  }

  async createEvent(input = {}) {
    return this.#write(async () => {
      const mutationId = requiredMutationId(input.mutationId);
      const event = normalizeNewEvent(input, { id: this.idFactory(), now: this.now() });
      await this.#assertCategory(event.categoryId, event.subcategoryId);
      const document = await this.#readDay(event.date);
      const previous = findMutation(document, mutationId);
      if (previous) {
        if (previous.operation !== 'create') throw httpError(409, 'mutationId 已用于其他操作');
        return clone(document.events.find((item) => item.id === previous.eventId));
      }
      if (document.events.some((item) => item.id === event.id)) throw httpError(409, '事件 ID 已存在');
      document.events.push(event);
      recordMutation(document, { id: mutationId, eventId: event.id, operation: 'create', appliedAt: this.now().toISOString() });
      await this.#writeDay(document);
      return clone(event);
    });
  }

  async createEvents(inputs = [], { categoryRevision } = {}) {
    if (!Array.isArray(inputs) || inputs.length < 1) throw httpError(400, '至少需要一条时间轴事件');
    if (inputs.length > 50) throw httpError(413, '一次最多新增 50 条时间轴事件');
    return this.#write(async () => {
      const taxonomy = await this.#readCategories();
      assertCategoryRevision(taxonomy, categoryRevision);
      const prepared = inputs.map((input) => ({
        mutationId: requiredMutationId(input?.mutationId),
        event: normalizeNewEvent(input, { id: this.idFactory(), now: this.now() }),
      }));
      for (const { event } of prepared) assertCategoryInTaxonomy(taxonomy, event.categoryId, event.subcategoryId);

      const documents = new Map();
      const results = [];
      for (const { mutationId, event } of prepared) {
        const document = documents.get(event.date) || await this.#readDay(event.date);
        documents.set(event.date, document);
        const previous = findMutation(document, mutationId);
        if (previous) {
          if (previous.operation !== 'create') throw httpError(409, 'mutationId 已用于其他操作');
          const existing = document.events.find((item) => item.id === previous.eventId);
          if (!existing) throw httpError(409, '重复请求对应的事件已经不存在');
          results.push(existing);
          continue;
        }
        document.events.push(event);
        recordMutation(document, { id: mutationId, eventId: event.id, operation: 'create', appliedAt: this.now().toISOString() });
        results.push(event);
      }
      for (const document of documents.values()) await this.#writeDay(document);
      return clone(results);
    });
  }

  async getEvent(id) {
    for (const file of await this.#listDayFiles()) {
      const document = await readDayFile(file);
      const event = document.events.find((item) => item.id === id);
      if (event) return clone(event);
    }
    throw httpError(404, '时间轴事件不存在');
  }

  async query({ start, end = start, includeDeleted = false } = {}) {
    const startDate = calendarDate(start);
    const endDate = calendarDate(end);
    if (startDate > endDate) throw httpError(400, '结束日期不能早于开始日期');
    const rangeStart = new Date(`${startDate}T00:00:00+08:00`).getTime();
    const rangeEnd = new Date(`${addDays(endDate, 1)}T00:00:00+08:00`).getTime();
    const dates = dateRange(addDays(startDate, -1), endDate);
    const events = [];
    for (const date of dates) {
      const document = await this.#readDay(date);
      for (const event of document.events) {
        if (!includeDeleted && event.deletedAt) continue;
        if (Date.parse(event.startedAt) < rangeEnd && Date.parse(event.endedAt) > rangeStart) events.push(clone(event));
      }
    }
    events.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.id.localeCompare(right.id));
    return events;
  }

  async listAll({ offset = 0, limit = 200 } = {}) {
    const events = [];
    for (const file of await this.#listDayFiles()) {
      const document = JSON.parse(await readFile(file, 'utf8'));
      events.push(...(document.events || []).map(clone));
    }
    events.sort((left, right) => left.id.localeCompare(right.id));
    const start = Math.max(0, Number(offset) || 0);
    const pageSize = Math.max(1, Math.min(200, Number(limit) || 200));
    return { events: events.slice(start, start + pageSize), total: events.length, hasMore: start + pageSize < events.length };
  }

  async stats({ start, end = start } = {}) {
    const startDate = calendarDate(start);
    const endDate = calendarDate(end);
    if (startDate > endDate) throw httpError(400, '结束日期不能早于开始日期');
    const rangeStart = new Date(`${startDate}T00:00:00+08:00`).getTime();
    const rangeEnd = new Date(`${addDays(endDate, 1)}T00:00:00+08:00`).getTime();
    const [events, taxonomy] = await Promise.all([
      this.query({ start: startDate, end: endDate }),
      this.listCategories({ includeInactive: true }),
    ]);
    const categoryMap = new Map(taxonomy.categories.map((item) => [item.id, item]));
    const groups = new Map();
    let totalMinutes = 0;
    for (const event of events) {
      const overlapMs = Math.max(0, Math.min(Date.parse(event.endedAt), rangeEnd) - Math.max(Date.parse(event.startedAt), rangeStart));
      const minutes = Math.round(overlapMs / 60_000);
      if (!minutes) continue;
      totalMinutes += minutes;
      const parent = categoryMap.get(event.categoryId);
      const child = parent?.children.find((item) => item.id === event.subcategoryId);
      const group = groups.get(event.categoryId) || {
        categoryId: event.categoryId,
        name: parent?.name || event.categoryId,
        color: parent?.color || '#9398A5',
        minutes: 0,
        children: new Map(),
      };
      group.minutes += minutes;
      const childGroup = group.children.get(event.subcategoryId) || {
        subcategoryId: event.subcategoryId,
        name: child?.name || event.subcategoryId,
        minutes: 0,
      };
      childGroup.minutes += minutes;
      group.children.set(event.subcategoryId, childGroup);
      groups.set(event.categoryId, group);
    }
    return {
      start: startDate,
      end: endDate,
      totalMinutes,
      groups: [...groups.values()]
        .map((group) => ({ ...group, children: [...group.children.values()].sort((left, right) => right.minutes - left.minutes) }))
        .sort((left, right) => right.minutes - left.minutes),
    };
  }

  async updateEvent(id, patch = {}, { baseRevision, mutationId, categoryRevision, requireCategoryRevision = false } = {}) {
    return this.#mutateEvent(id, { baseRevision, mutationId, operation: 'update' }, async (event, document) => {
      if ((patch.categoryId !== undefined || patch.subcategoryId !== undefined) && (requireCategoryRevision || categoryRevision !== undefined)) {
        assertCategoryRevision(await this.#readCategories(), categoryRevision);
      }
      const next = normalizeUpdatedEvent(event, patch, this.now());
      await this.#assertCategory(next.categoryId, next.subcategoryId, { allowInactive: event.categoryId === next.categoryId && event.subcategoryId === next.subcategoryId });
      if (next.date !== document.date) throw httpError(409, '修改开始日期需要使用移动事件操作');
      return next;
    });
  }

  async updateEventWithCategoryRevision(id, patch = {}, { baseRevision, mutationId, categoryRevision } = {}) {
    return this.updateEvent(id, patch, { baseRevision, mutationId, categoryRevision, requireCategoryRevision: true });
  }

  async archiveEvent(id, options = {}) {
    return this.#mutateEvent(id, { ...options, operation: 'archive' }, async (event) => {
      if (event.deletedAt) return event;
      return nextRevision(event, { deletedAt: this.now().toISOString() }, this.now());
    });
  }

  async restoreEvent(id, options = {}) {
    return this.#mutateEvent(id, { ...options, operation: 'restore' }, async (event) => {
      if (!event.deletedAt) return event;
      return nextRevision(event, { deletedAt: null }, this.now());
    });
  }

  async getReview(date) {
    const document = await this.#readDay(calendarDate(date));
    return clone(document.review);
  }

  async setReview(date, { text, author = 'user', baseRevision = 0, mutationId } = {}) {
    return this.#write(async () => {
      const normalizedDate = calendarDate(date);
      const document = await this.#readDay(normalizedDate);
      const idempotencyKey = requiredMutationId(mutationId);
      const previous = findMutation(document, idempotencyKey);
      if (previous) {
        if (previous.operation !== 'review') throw httpError(409, 'mutationId 已用于其他操作');
        return clone(document.review);
      }
      const currentRevision = document.review?.revision || 0;
      if (Number(baseRevision) !== currentRevision) throw httpError(409, '当日回顾已经更新，请刷新后重试');
      if (!EVENT_AUTHORS.has(author)) throw httpError(400, '回顾作者无效');
      const value = String(text ?? '').trim();
      if (value.length > 12_000) throw httpError(413, '当日回顾过长');
      document.review = value ? {
        text: value,
        author,
        revision: currentRevision + 1,
        updatedAt: this.now().toISOString(),
      } : null;
      recordMutation(document, { id: idempotencyKey, eventId: null, operation: 'review', appliedAt: this.now().toISOString() });
      await this.#writeDay(document);
      return clone(document.review);
    });
  }

  async #mutateEvent(id, { baseRevision, mutationId, operation }, transform) {
    return this.#write(async () => {
      const idempotencyKey = requiredMutationId(mutationId);
      for (const file of await this.#listDayFiles()) {
        const document = await readDayFile(file);
        const index = document.events.findIndex((item) => item.id === id);
        if (index < 0) continue;
        const previous = findMutation(document, idempotencyKey);
        if (previous) {
          if (previous.operation !== operation || previous.eventId !== id) throw httpError(409, 'mutationId 已用于其他操作');
          return clone(document.events[index]);
        }
        const current = document.events[index];
        if (Number(baseRevision) !== current.revision) throw httpError(409, '事件已经更新，请刷新后重试');
        const next = await transform(current, document);
        document.events[index] = next;
        recordMutation(document, { id: idempotencyKey, eventId: id, operation, appliedAt: this.now().toISOString() });
        await this.#writeDay(document);
        return clone(next);
      }
      throw httpError(404, '时间轴事件不存在');
    });
  }

  async #assertCategory(categoryId, subcategoryId, { allowInactive = false } = {}) {
    const { categories } = await this.listCategories({ includeInactive: true });
    const parent = categories.find((item) => item.id === categoryId);
    const child = parent?.children.find((item) => item.id === subcategoryId);
    if (!parent || !child) throw httpError(400, '时间轴分类不存在');
    if (!allowInactive && (parent.status !== 'active' || child.status !== 'active')) throw httpError(400, '时间轴分类已停用');
  }

  async #readCategories() {
    try {
      const document = JSON.parse(await readFile(this.categoriesFile, 'utf8'));
      return normalizeCategoryDocument(document);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const document = {
        schemaVersion: SCHEMA_VERSION,
        revision: 1,
        updatedAt: this.now().toISOString(),
        categories: clone(this.initialCategories),
      };
      await writeJsonAtomic(this.categoriesFile, document);
      return document;
    }
  }

  async #updateCategories(baseRevision, mutator) {
    return this.#write(async () => {
      const document = await this.#readCategories();
      if (Number(baseRevision) !== document.revision) throw httpError(409, '分类已经更新，请刷新后重试');
      mutator(document);
      document.revision += 1;
      document.updatedAt = this.now().toISOString();
      await writeJsonAtomic(this.categoriesFile, document);
      return { revision: document.revision, categories: clone(document.categories) };
    });
  }

  async #readDay(date) {
    const normalizedDate = calendarDate(date);
    const file = this.#dayFile(normalizedDate);
    try {
      return await readDayFile(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return emptyDay(normalizedDate);
    }
  }

  async #writeDay(document) {
    document.updatedAt = this.now().toISOString();
    await writeJsonAtomic(this.#dayFile(document.date), document);
  }

  #dayFile(date) {
    const [year, month] = date.split('-');
    return join(this.root, year, month, `${date}.json`);
  }

  async #listDayFiles() {
    const files = [];
    let years = [];
    try { years = await readdir(this.root, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return files; throw error; }
    for (const year of years.filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))) {
      const yearRoot = join(this.root, year.name);
      const months = await readdir(yearRoot, { withFileTypes: true });
      for (const month of months.filter((entry) => entry.isDirectory() && /^\d{2}$/.test(entry.name))) {
        const monthRoot = join(yearRoot, month.name);
        const names = await readdir(monthRoot, { withFileTypes: true });
        for (const file of names.filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))) files.push(join(monthRoot, file.name));
      }
    }
    return files.sort();
  }

  #write(operation) {
    const next = this.writeChain.then(operation);
    this.writeChain = next.catch(() => {});
    return next;
  }
}

function category(id, name, color, children) {
  return { id, name, color, status: 'active', children: children.map(([childId, childName]) => ({ id: childId, name: childName, status: 'active' })) };
}

function normalizeCategoryDocument(value = {}) {
  const categories = Array.isArray(value.categories) ? value.categories.map(normalizeCategory) : [];
  const ids = new Set();
  for (const item of categories) {
    if (ids.has(item.id)) throw new Error(`分类 ID 重复：${item.id}`);
    ids.add(item.id);
    const childIds = new Set();
    for (const child of item.children) {
      if (childIds.has(child.id)) throw new Error(`二级分类 ID 重复：${item.id}/${child.id}`);
      childIds.add(child.id);
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: positiveInteger(value.revision, 1),
    updatedAt: validDateTime(value.updatedAt) || new Date(0).toISOString(),
    categories,
  };
}

function normalizeCategory(value = {}) {
  return {
    id: stableId(value.id),
    name: displayName(value.name),
    color: categoryColor(value.color, '#9398A5'),
    status: CATEGORY_STATUSES.has(value.status) ? value.status : 'active',
    children: Array.isArray(value.children) ? value.children.map((child) => ({
      id: stableId(child.id),
      name: displayName(child.name),
      status: CATEGORY_STATUSES.has(child.status) ? child.status : 'active',
    })) : [],
  };
}

function categoryColor(value, fallback = '') {
  if (!/^#[0-9A-Fa-f]{6}$/.test(value || '')) {
    if (fallback) return fallback;
    throw httpError(400, '分类颜色无效');
  }
  return value.toUpperCase();
}

function findCategoryTarget(categories, categoryId, subcategoryId) {
  const parent = categories.find((item) => item.id === stableId(categoryId));
  if (!parent) throw httpError(404, '一级分类不存在');
  if (!subcategoryId) return parent;
  const child = parent.children.find((item) => item.id === stableId(subcategoryId));
  if (!child) throw httpError(404, '二级分类不存在');
  return child;
}

function assertCategoryRevision(taxonomy, suppliedRevision) {
  if (Number(suppliedRevision) === taxonomy.revision) return;
  const error = httpError(409, '时间轴分类已经更新，请重新读取分类后重试');
  error.code = 'CATEGORY_REVISION_CHANGED';
  error.currentRevision = taxonomy.revision;
  throw error;
}

function assertCategoryInTaxonomy(taxonomy, categoryId, subcategoryId) {
  const parent = taxonomy.categories.find((item) => item.id === categoryId);
  const child = parent?.children.find((item) => item.id === subcategoryId);
  if (!parent || !child) throw httpError(400, '时间轴分类不存在');
  if (parent.status !== 'active' || child.status !== 'active') throw httpError(400, '时间轴分类已停用');
}

function normalizeNewEvent(input, { id, now }) {
  const startedAt = normalizeDateTime(input.startedAt);
  const endedAt = normalizeDateTime(input.endedAt);
  validateEventTimes(startedAt, endedAt);
  const createdAt = now.toISOString();
  return {
    id,
    date: beijingDate(startedAt),
    startedAt,
    endedAt,
    title: requiredText(input.title, '事件标题', 200),
    note: optionalText(input.note, 12_000),
    categoryId: stableId(input.categoryId || 'uncategorized'),
    subcategoryId: stableId(input.subcategoryId || 'to-organize'),
    author: EVENT_AUTHORS.has(input.author) ? input.author : 'user',
    source: normalizeSource(input.source),
    revision: 1,
    history: [],
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
}

function normalizeUpdatedEvent(current, patch, now) {
  const startedAt = patch.startedAt === undefined ? current.startedAt : normalizeDateTime(patch.startedAt);
  const endedAt = patch.endedAt === undefined ? current.endedAt : normalizeDateTime(patch.endedAt);
  validateEventTimes(startedAt, endedAt);
  return nextRevision(current, {
    date: beijingDate(startedAt),
    startedAt,
    endedAt,
    title: patch.title === undefined ? current.title : requiredText(patch.title, '事件标题', 200),
    note: patch.note === undefined ? current.note : optionalText(patch.note, 12_000),
    categoryId: patch.categoryId === undefined ? current.categoryId : stableId(patch.categoryId),
    subcategoryId: patch.subcategoryId === undefined ? current.subcategoryId : stableId(patch.subcategoryId),
    author: patch.author === undefined ? current.author : EVENT_AUTHORS.has(patch.author) ? patch.author : invalid('事件作者无效'),
    source: patch.source === undefined ? current.source : normalizeSource(patch.source),
  }, now);
}

function nextRevision(current, patch, now) {
  const snapshot = { ...current };
  delete snapshot.history;
  return {
    ...current,
    ...patch,
    revision: current.revision + 1,
    history: [...(current.history || []), snapshot],
    updatedAt: now.toISOString(),
  };
}

function normalizeSource(value = {}) {
  const type = ['manual', 'chat', 'mcp', 'import'].includes(value?.type) ? value.type : 'manual';
  return { type, messageId: typeof value?.messageId === 'string' && value.messageId.trim() ? value.messageId.trim().slice(0, 200) : null };
}

function validateEventTimes(startedAt, endedAt) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (start >= end) throw httpError(400, '结束时间必须晚于开始时间');
  if (end - start > MAX_EVENT_DURATION_MS) throw httpError(400, '单条事件不能超过 48 小时');
}

function emptyDay(date) {
  return { schemaVersion: SCHEMA_VERSION, date, updatedAt: null, events: [], review: null, mutations: [] };
}

async function readDayFile(file) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  const date = calendarDate(value.date);
  return {
    schemaVersion: SCHEMA_VERSION,
    date,
    updatedAt: validDateTime(value.updatedAt),
    events: Array.isArray(value.events) ? value.events.map(normalizeStoredEvent) : [],
    review: value.review ? normalizeReview(value.review) : null,
    mutations: Array.isArray(value.mutations) ? value.mutations.filter((item) => typeof item?.id === 'string') : [],
  };
}

function normalizeStoredEvent(value) {
  const event = normalizeNewEvent(value, { id: String(value.id || ''), now: new Date(validDateTime(value.createdAt) || 0) });
  if (!event.id) throw new Error('时间轴事件缺少 ID');
  event.revision = positiveInteger(value.revision, 1);
  event.history = Array.isArray(value.history) ? value.history : [];
  event.createdAt = validDateTime(value.createdAt) || new Date(0).toISOString();
  event.updatedAt = validDateTime(value.updatedAt) || event.createdAt;
  event.deletedAt = value.deletedAt ? validDateTime(value.deletedAt) : null;
  return event;
}

function normalizeReview(value) {
  return {
    text: optionalText(value.text, 12_000),
    author: EVENT_AUTHORS.has(value.author) ? value.author : 'user',
    revision: positiveInteger(value.revision, 1),
    updatedAt: validDateTime(value.updatedAt) || new Date(0).toISOString(),
  };
}

function findMutation(document, mutationId) {
  return document.mutations.find((item) => item.id === mutationId) || null;
}

function recordMutation(document, mutation) {
  document.mutations.push(mutation);
  if (document.mutations.length > MAX_MUTATIONS_PER_DAY) document.mutations.splice(0, document.mutations.length - MAX_MUTATIONS_PER_DAY);
}

function requiredMutationId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 200) throw httpError(400, 'mutationId 无效');
  return id;
}

function normalizeDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw httpError(400, '时间格式无效');
  return beijingDateTime(date);
}

function calendarDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError(400, '日期格式应为 YYYY-MM-DD');
  const date = new Date(`${text}T00:00:00+08:00`);
  if (beijingDate(date) !== text) throw httpError(400, '日期不存在');
  return text;
}

function beijingDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = dateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function beijingDateTime(value) {
  const parts = dateParts(value instanceof Date ? value : new Date(value));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

function dateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function addDays(date, amount) {
  const value = new Date(`${calendarDate(date)}T12:00:00+08:00`);
  value.setUTCDate(value.getUTCDate() + amount);
  return beijingDate(value);
}

function dateRange(start, end) {
  const dates = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) dates.push(cursor);
  return dates;
}

function stableId(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(text)) throw httpError(400, '分类 ID 只能使用小写字母、数字和连字符');
  return text;
}

function displayName(value) {
  return requiredText(value, '分类名称', 40);
}

function requiredText(value, label, maxLength) {
  const text = String(value ?? '').trim();
  if (!text) throw httpError(400, `${label}不能为空`);
  if (text.length > maxLength) throw httpError(413, `${label}过长`);
  return text;
}

function optionalText(value, maxLength) {
  const text = String(value ?? '').trim();
  if (text.length > maxLength) throw httpError(413, '文本过长');
  return text;
}

function validDateTime(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function invalid(message) {
  throw httpError(400, message);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, file);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
