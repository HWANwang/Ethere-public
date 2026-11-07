import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileMemoryMarkdown, findDuplicateIn, MEMORY_ACTIVE_LIMIT } from './memory-store.mjs';

// The JSON file is an import-only snapshot. All subsequent reads and writes use memory-nodes.sqlite.
export class UnifiedMemoryStore {
  constructor({ dataRoot, memoryNodeStore }) {
    this.legacyFile = join(dataRoot, 'memory', 'memories.json');
    this.nodes = memoryNodeStore;
  }

  async initialize() {
    await this.nodes.initialize();
    let legacy = [];
    try { legacy = JSON.parse(await readFile(this.legacyFile, 'utf8')).memories || []; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.nodes.importLegacyCore(legacy);
    return this.summary();
  }

  async #allCore() {
    const result = await this.nodes.list({ tier: 'core', limit: 50 });
    if (result.hasMore) throw new Error('核心记忆超过单页上限，请先扩展分页读取');
    return result.nodes.map(asMemory);
  }

  async summary() {
    const memories = await this.#allCore();
    const activeCount = memories.filter((memory) => memory.status === 'active').length;
    return { revision: memories.map((memory) => `${memory.id}:${memory.revision}`).sort().join('|'), activeCount, archivedCount: memories.length - activeCount, limit: MEMORY_ACTIVE_LIMIT };
  }

  async list({ status = 'active', query = '' } = {}) {
    const selectedStatus = status === 'archived' ? 'archived' : 'active';
    const normalizedQuery = String(query || '').trim().toLocaleLowerCase('zh-CN');
    const memories = (await this.#allCore()).filter((memory) => memory.status === selectedStatus)
      .filter((memory) => !normalizedQuery || `${memory.title}\n${memory.contentMarkdown}`.toLocaleLowerCase('zh-CN').includes(normalizedQuery));
    return { ...(await this.summary()), status: selectedStatus, query: normalizedQuery, memories };
  }

  async get(id) {
    const node = await this.nodes.get(id);
    return node?.tier === 'core' ? asMemory(node) : null;
  }

  async findDuplicate(input = {}, { excludeId = '' } = {}) {
    const title = String(input.title || '').trim();
    const contentMarkdown = String(input.contentMarkdown || '').trim();
    if (!title || !contentMarkdown) return null;
    return findDuplicateIn(await this.#allCore(), { title, contentMarkdown }, excludeId);
  }

  async create(input = {}, { allowDuplicate = false } = {}) {
    const { title, contentMarkdown } = validateInput(input);
    if ((await this.summary()).activeCount >= MEMORY_ACTIVE_LIMIT) throw storeError(409, `当前核心记忆已达到 ${MEMORY_ACTIVE_LIMIT} 条，请先合并或归档`);
    const duplicate = allowDuplicate ? null : await this.findDuplicate({ title, contentMarkdown });
    if (duplicate) throw duplicateError(duplicate);
    return asMemory(await this.nodes.create({ topicKey: title, content: contentMarkdown, owner: 'user', tier: 'core', status: 'active', approved: true }));
  }

  async update(id, input = {}, { baseRevision } = {}) {
    const current = await this.get(id);
    if (!current) throw storeError(404, '记忆不存在');
    if (current.status !== 'active') throw storeError(409, '归档记忆需要先恢复再编辑');
    const { title, contentMarkdown } = validateInput(input);
    const duplicate = await this.findDuplicate({ title, contentMarkdown }, { excludeId: id });
    if (duplicate) throw duplicateError(duplicate);
    return asMemory(await this.nodes.update(id, { topicKey: title, content: contentMarkdown }, { baseRevision }));
  }

  async archive(id, { baseRevision } = {}) {
    if (!await this.get(id)) throw storeError(404, '记忆不存在');
    return asMemory(await this.nodes.update(id, { status: 'archived' }, { baseRevision }));
  }

  async restore(id, { baseRevision } = {}) {
    if (!await this.get(id)) throw storeError(404, '记忆不存在');
    if ((await this.summary()).activeCount >= MEMORY_ACTIVE_LIMIT) throw storeError(409, `当前核心记忆已达到 ${MEMORY_ACTIVE_LIMIT} 条，请先归档一条`);
    return asMemory(await this.nodes.update(id, { status: 'active' }, { baseRevision }));
  }

  async promote(id, input = {}, { baseRevision } = {}) {
    const current = await this.nodes.get(id);
    if (!current || current.tier !== 'retrievable') throw storeError(404, '可检索记忆节点不存在');
    const { title, contentMarkdown } = validateInput(input);
    if ((await this.summary()).activeCount >= MEMORY_ACTIVE_LIMIT) throw storeError(409, `当前核心记忆已达到 ${MEMORY_ACTIVE_LIMIT} 条`);
    const duplicate = await this.findDuplicate({ title, contentMarkdown });
    if (duplicate) throw duplicateError(duplicate);
    return asMemory(await this.nodes.update(id, { topicKey: title, content: contentMarkdown, tier: 'core', status: 'active' }, { baseRevision, approved: true }));
  }

  async context() {
    const memories = (await this.#allCore()).filter((memory) => memory.status === 'active');
    return { revision: (await this.summary()).revision, text: compileMemoryMarkdown(memories), activeCount: memories.length };
  }
}

function asMemory(node) {
  return { id: node.id, title: node.topicKey, contentMarkdown: node.content, status: node.status,
    revision: node.revision, previousContent: null, createdAt: node.createdAt, updatedAt: node.updatedAt };
}
function validateInput(input) {
  const title = String(input.title || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const contentMarkdown = String(input.contentMarkdown || '').trim().slice(0, 20_000);
  if (!title) throw storeError(400, '请输入记忆标题');
  if (!contentMarkdown) throw storeError(400, '请输入记忆内容');
  return { title, contentMarkdown };
}
function storeError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
function duplicateError(match) { return storeError(409, `可能与“${match.memory.title}”重复，请改为更新现有主题`); }
