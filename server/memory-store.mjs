import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ACTIVE_LIMIT = 30;

export class MemoryStore {
  constructor({ dataRoot, idFactory = () => `memory-${randomUUID()}`, now = () => new Date() }) {
    this.file = join(dataRoot, 'memory', 'memories.json');
    this.markdownFile = join(dataRoot, 'memory', 'MEMORY.md');
    this.idFactory = idFactory;
    this.now = now;
    this.document = null;
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    await this.#load();
    await this.#writeMarkdown(this.document);
    return this.summary();
  }

  async summary() {
    await this.writeChain;
    await this.#load();
    const activeCount = this.document.memories.filter((item) => item.status === 'active').length;
    return { revision: this.document.revision, activeCount, archivedCount: this.document.memories.length - activeCount, limit: ACTIVE_LIMIT };
  }

  async list({ status = 'active', query = '' } = {}) {
    await this.writeChain;
    await this.#load();
    const selectedStatus = status === 'archived' ? 'archived' : 'active';
    const normalizedQuery = String(query || '').trim().toLocaleLowerCase('zh-CN');
    const memories = this.document.memories
      .filter((item) => item.status === selectedStatus)
      .filter((item) => !normalizedQuery || `${item.title}\n${item.contentMarkdown}`.toLocaleLowerCase('zh-CN').includes(normalizedQuery))
      .map(publicMemory);
    return { ...(await this.summary()), status: selectedStatus, query: normalizedQuery, memories };
  }

  async get(id) {
    await this.writeChain;
    await this.#load();
    const memory = this.document.memories.find((item) => item.id === String(id || ''));
    return memory ? publicMemory(memory) : null;
  }

  async create(input = {}, { allowDuplicate = false } = {}) {
    return this.#write(async (document) => {
      const activeCount = document.memories.filter((item) => item.status === 'active').length;
      if (activeCount >= ACTIVE_LIMIT) throw storeError(409, `当前记忆已达到 ${ACTIVE_LIMIT} 条，请先合并或归档`);
      const normalized = normalizeMemoryInput(input);
      const duplicate = allowDuplicate ? null : findDuplicateIn(document.memories, normalized);
      if (duplicate) throw duplicateError(duplicate);
      const timestamp = this.now().toISOString();
      const memory = {
        id: this.idFactory(), title: normalized.title, contentMarkdown: normalized.contentMarkdown,
        status: 'active', revision: 1, previousContent: null,
        createdAt: timestamp, updatedAt: timestamp,
      };
      document.memories.push(memory);
      document.revision += 1;
      return publicMemory(memory);
    });
  }

  async update(id, input = {}, { baseRevision } = {}) {
    return this.#write(async (document) => {
      const memory = requireMemory(document, id);
      if (memory.status !== 'active') throw storeError(409, '归档记忆需要先恢复再编辑');
      if (!Number.isInteger(baseRevision) || baseRevision !== memory.revision) throw revisionError(memory);
      const normalized = normalizeMemoryInput(input);
      const duplicate = findDuplicateIn(document.memories, normalized, memory.id);
      if (duplicate) throw duplicateError(duplicate);
      memory.previousContent = { title: memory.title, contentMarkdown: memory.contentMarkdown, revision: memory.revision };
      memory.title = normalized.title;
      memory.contentMarkdown = normalized.contentMarkdown;
      memory.revision += 1;
      memory.updatedAt = this.now().toISOString();
      document.revision += 1;
      return publicMemory(memory);
    });
  }

  async archive(id, { baseRevision } = {}) {
    return this.#changeStatus(id, 'archived', baseRevision);
  }

  async restore(id, { baseRevision } = {}) {
    return this.#write(async (document) => {
      if (document.memories.filter((item) => item.status === 'active').length >= ACTIVE_LIMIT) {
        throw storeError(409, `当前记忆已达到 ${ACTIVE_LIMIT} 条，请先归档一条`);
      }
      return changeStatus(document, id, 'active', baseRevision, this.now);
    });
  }

  async findDuplicate(input = {}, { excludeId = '' } = {}) {
    await this.writeChain;
    await this.#load();
    let normalized;
    try { normalized = normalizeMemoryInput(input); } catch { return null; }
    const match = findDuplicateIn(this.document.memories, normalized, excludeId);
    return match ? { memory: publicMemory(match.memory), score: match.score, reason: match.reason } : null;
  }

  async context() {
    await this.writeChain;
    await this.#load();
    return {
      revision: this.document.revision,
      text: compileMemoryMarkdown(this.document.memories.filter((item) => item.status === 'active')),
      activeCount: this.document.memories.filter((item) => item.status === 'active').length,
    };
  }

  async #changeStatus(id, status, baseRevision) {
    return this.#write(async (document) => changeStatus(document, id, status, baseRevision, this.now));
  }

  async #load() {
    if (this.document) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.document = normalizeDocument(parsed);
    } catch {
      this.document = { schemaVersion: 1, revision: 1, memories: [] };
    }
  }

  async #write(operation) {
    const next = this.writeChain.then(async () => {
      await this.#load();
      const document = structuredClone(this.document);
      const result = await operation(document);
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, this.file);
      await this.#writeMarkdown(document);
      this.document = document;
      return result;
    });
    this.writeChain = next.catch(() => {});
    return next;
  }

  async #writeMarkdown(document) {
    await mkdir(dirname(this.markdownFile), { recursive: true });
    const temporary = `${this.markdownFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, compileMemoryMarkdown(document.memories.filter((item) => item.status === 'active')), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, this.markdownFile);
  }
}

function normalizeDocument(value) {
  const memories = Array.isArray(value?.memories) ? value.memories.map(normalizeStoredMemory).filter(Boolean) : [];
  return { schemaVersion: 1, revision: Math.max(1, Number(value?.revision) || 1), memories };
}

function normalizeStoredMemory(value) {
  try {
    const id = String(value?.id || '').trim();
    if (!id) return null;
    const input = normalizeMemoryInput(value);
    return {
      id, ...input,
      status: value.status === 'archived' ? 'archived' : 'active',
      revision: Math.max(1, Number(value.revision) || 1),
      previousContent: value.previousContent || null,
      createdAt: value.createdAt || new Date(0).toISOString(),
      updatedAt: value.updatedAt || value.createdAt || new Date(0).toISOString(),
    };
  } catch { return null; }
}

function normalizeMemoryInput(value) {
  const title = String(value?.title || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const contentMarkdown = String(value?.contentMarkdown || '').trim().slice(0, 20_000);
  if (!title) throw storeError(400, '请输入记忆标题');
  if (!contentMarkdown) throw storeError(400, '请输入记忆内容');
  return { title, contentMarkdown };
}

function publicMemory(memory) { return structuredClone(memory); }

function requireMemory(document, id) {
  const memory = document.memories.find((item) => item.id === String(id || ''));
  if (!memory) throw storeError(404, '记忆不存在');
  return memory;
}

function changeStatus(document, id, status, baseRevision, now) {
  const memory = requireMemory(document, id);
  if (!Number.isInteger(baseRevision) || baseRevision !== memory.revision) throw revisionError(memory);
  if (memory.status === status) return publicMemory(memory);
  memory.status = status;
  memory.revision += 1;
  memory.updatedAt = now().toISOString();
  document.revision += 1;
  return publicMemory(memory);
}

export function findDuplicateIn(memories, input, excludeId = '') {
  const candidates = memories.filter((item) => item.status === 'active' && item.id !== excludeId);
  const title = normalizeComparable(input.title);
  for (const memory of candidates) {
    const other = normalizeComparable(memory.title);
    if (title === other) return { memory, score: 1, reason: '标题相同' };
    if (title.length >= 4 && other.length >= 4 && (title.includes(other) || other.includes(title))) return { memory, score: .92, reason: '标题高度相似' };
  }
  const content = normalizeComparable(input.contentMarkdown);
  const source = `${title}${content}`;
  let best = null;
  for (const memory of candidates) {
    const otherTitle = normalizeComparable(memory.title);
    const otherContent = normalizeComparable(memory.contentMarkdown);
    const titleScore = diceCoefficient(title, otherTitle);
    const contentScore = diceCoefficient(content, otherContent);
    const sourceScore = diceCoefficient(source, `${otherTitle}${otherContent}`);
    const containment = bigramContainment(source, `${otherTitle}${otherContent}`);
    const weightedScore = titleScore * .62 + contentScore * .38;
    const score = Math.max(titleScore, contentScore, sourceScore, weightedScore, containment * .86);
    const titleLikely = Math.min(title.length, otherTitle.length) >= 5 && titleScore >= .36;
    const similar = titleLikely || contentScore >= .42 || sourceScore >= .4 || weightedScore >= .34 || containment >= .52;
    if (similar && (!best || score > best.score)) {
      const reason = titleLikely ? '标题相似' : containment >= .52 ? '包含大量相同内容' : '内容相似';
      best = { memory, score: Number(score.toFixed(3)), reason };
    }
  }
  return best;
}

function normalizeComparable(value) { return String(value || '').toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, ''); }
function diceCoefficient(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (text) => { const map = new Map(); for (let i = 0; i < text.length - 1; i += 1) map.set(text.slice(i, i + 2), (map.get(text.slice(i, i + 2)) || 0) + 1); return map; };
  const a = grams(left); const b = grams(right); let overlap = 0;
  for (const [gram, count] of a) overlap += Math.min(count, b.get(gram) || 0);
  return (2 * overlap) / (Math.max(0, left.length - 1) + Math.max(0, right.length - 1));
}
function bigramContainment(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (text) => { const result = new Set(); for (let i = 0; i < text.length - 1; i += 1) result.add(text.slice(i, i + 2)); return result; };
  const a = grams(left); const b = grams(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const gram of a) if (b.has(gram)) overlap += 1;
  return overlap / Math.min(a.size, b.size);
}

export function compileMemoryMarkdown(memories = []) {
  const active = memories.filter((item) => item.status !== 'archived');
  const body = active.map((item) => `<!-- memory-id: ${item.id} -->\n## ${item.title}\n\n${item.contentMarkdown.trim()}`).join('\n\n');
  return `# 长期记忆\n\n${body || '暂无长期记忆。'}\n`;
}

function storeError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
function revisionError(memory) { const error = storeError(409, '记忆已经更新，请刷新后重试'); error.currentRevision = memory.revision; return error; }
function duplicateError(match) { const error = storeError(409, `可能与“${match.memory.title}”重复，请改为更新现有主题`); error.duplicate = { memory: publicMemory(match.memory), score: match.score, reason: match.reason }; return error; }

export const MEMORY_ACTIVE_LIMIT = ACTIVE_LIMIT;
