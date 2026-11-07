export class MemoryV2Client {
  constructor({ baseUrl = process.env.ETHERE_MEMORY_V2_URL || 'http://127.0.0.1:4191', recallTimeoutMs = 250, requestTimeoutMs = 4000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.recallTimeoutMs = recallTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  health() { return this.request('/api/health'); }
  stats() { return this.request('/api/stats'); }
  listMemories(params = {}) { return this.request(`/api/memories?${new URLSearchParams(params)}`); }
  getMemory(id) { return this.request(`/api/tools/get_memory/${encodeURIComponent(id)}`); }
  getEvidence(id, full = false) { return this.request(`/api/tools/get_memory_evidence/${encodeURIComponent(id)}?full=${full}`); }
  getRelated(id) { return this.request(`/api/tools/get_related_memories/${encodeURIComponent(id)}`); }
  search(args) { return this.request('/api/tools/search_memories', { method: 'POST', body: args }); }
  reportIssue(args) { return this.request('/api/tools/report_memory_issue', { method: 'POST', body: args }); }
  revise(id, args) { return this.request(`/api/memories/${encodeURIComponent(id)}`, { method: 'PATCH', body: args }); }
  importSources(records) { return this.request('/api/sources/import', { method: 'POST', body: { records } }); }
  maintenanceStatus() { return this.request('/api/maintenance/status'); }
  maintenanceHistory(limit = 20) { return this.request(`/api/maintenance?limit=${Math.min(100, Math.max(1, Number(limit) || 20))}`); }
  triggerMaintenance() { return this.request('/api/maintenance/trigger', { method: 'POST' }); }
  setMaintenanceEnabled(enabled) { return this.request('/api/maintenance/enabled', { method: 'POST', body: { enabled: enabled === true } }); }

  async recallForTurn(text, { limit = 3, threshold = 0.40, context = [], occurredAt } = {}) {
    try {
      const result = await this.request('/api/recall', { method: 'POST', body: { query: text, limit, threshold, context, occurredAt } }, this.recallTimeoutMs);
      return { memories: result.injection || [], latencyMs: result.latencyMs || 0 };
    } catch (error) {
      return { memories: [], latencyMs: 0, degraded: true, error: error.message };
    }
  }

  async request(path, options = {}, timeoutMs = this.requestTimeoutMs) {
    const response = await fetch(this.baseUrl + path, {
      method: options.method || 'GET',
      headers: { 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || `Memory V2 HTTP ${response.status}`), { statusCode: response.status });
    return payload;
  }
}

export function memoryV2ContextBlock(memories) {
  if (!memories?.length) return '';
  const rows = memories.map((memory) => `- [${memory.memory_id}] ${memory.state === 'watch' ? '待观察、可修正的判断：' : '长期记忆：'}${memory.content}${memory.valid_from || memory.valid_to ? `（有效期：${memory.valid_from || '未知'} 至 ${memory.valid_to || '现在'}）` : ''}${memory.relation_context ? `；关联：${memory.relation_context}` : ''}`);
  return `\n\n[系统按当前话题召回的记忆。Watch 只是待观察判断，不可当成确定事实；可自然参考、必要时核对来源。记忆也可能过时或有误，不要向用户展示内部 ID。若发现问题，调用 report_memory_issue。]\n${rows.join('\n')}`;
}

export function sourceRecord(type, value, sourceInstance = '') {
  if (type === 'chat') return { sourceType: 'chat', externalId: value.id, role: value.role, author: value.role, content: value.content, occurredAt: value.createdAt, sourceInstance, metadata: { seq: value.seq, source: value.source, replyTo: value.replyTo } };
  if (type === 'timeline') return { sourceType: 'timeline', externalId: value.id, author: value.author || 'user', content: [value.title, value.note, value.description].filter(Boolean).join('\n'), occurredAt: value.startedAt, sourceInstance, deleted: Boolean(value.deletedAt), metadata: { endedAt: value.endedAt, categoryId: value.categoryId, subcategoryId: value.subcategoryId, revision: value.revision } };
  return { sourceType: 'space', externalId: value.id, author: value.author, content: value.contentMarkdown, occurredAt: value.occurredAt, sourceInstance, deleted: value.status === 'archived', metadata: { revision: value.revision, source: value.source } };
}
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export function sourceInstanceForDataRoot(dataRoot) {
  if (!dataRoot) throw new Error('来源缺少 dataRoot');
  return `ethere-${createHash('sha256').update(resolve(dataRoot).toLowerCase()).digest('hex').slice(0, 20)}`;
}

