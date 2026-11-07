const API_ROOT = '/api/ethere/v1';

export class EthereApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'EthereApiError';
    this.status = status;
  }
}

async function request(path, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_ROOT}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new EthereApiError(payload?.error || `请求失败 (${response.status})`, response.status);
    }
    if (response.status === 204) return null;
    return response.json();
  } catch (error) {
    if (error instanceof EthereApiError) throw error;
    throw new EthereApiError(error.name === 'AbortError' ? '连接超时' : '电脑端未连接');
  } finally {
    window.clearTimeout(timer);
  }
}

export const ethereApi = {
  health: () => request('/health'),
  voiceHealth: () => request('/voice/health'),
  voiceAsr: (audioBase64) => request('/voice/asr', { method: 'POST', body: JSON.stringify({ audioBase64 }) }, 45_000),
  recordCallEvent: (payload) => request('/chat/call-events', { method: 'POST', body: JSON.stringify(payload) }, 10_000),
  reportVoiceTiming: (payload) => request('/voice/timing', { method: 'POST', body: JSON.stringify(payload) }, 4000),
  async voiceTts(text, voiceId, signal) {
    const response = await fetch(`${API_ROOT}/voice/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voiceId }), signal });
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new EthereApiError(payload.error || '语音合成失败', response.status); }
    return response.blob();
  },
  reportChatLatency: (payload) => request('/chat/latency', { method: 'POST', body: JSON.stringify(payload) }, 4000),
  async streamChat({ message = '', images = [], files = [], messageId = '', quote = null, channel = 'chat' }, onEvent) {
    let response;
    try {
      response = await fetch(`${API_ROOT}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, images, files, messageId, quote, channel }),
      });
    } catch {
      throw new EthereApiError('电脑端未连接');
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new EthereApiError(payload?.error || `请求失败 (${response.status})`, response.status);
    }
    if (!response.body) throw new EthereApiError('浏览器不支持流式回复');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) completed = handleStreamLine(line, onEvent) || completed;
      if (done) break;
    }
    if (buffer.trim()) completed = handleStreamLine(buffer, onEvent) || completed;
    if (!completed) throw new EthereApiError('回复流提前断开，正在核对结果');
  },
  interruptChat: () => request('/chat/interrupt', { method: 'POST', body: '{}' }),
  uploadChatFile: (name, dataUrl) => request('/chat/files', { method: 'POST', body: JSON.stringify({ name, dataUrl }) }, 60_000),
  chatEvents: (after = 0) => request(`/chat/events?after=${encodeURIComponent(after)}`),
  chatTurn: (messageId) => request(`/chat/turns/${encodeURIComponent(messageId)}`),
  openChatEventStream(after = 0, { onBatch, onOpen, onError } = {}) {
    if (typeof window.EventSource !== 'function') return null;
    const source = new window.EventSource(`${API_ROOT}/chat/events/stream?after=${encodeURIComponent(after)}`);
    source.addEventListener('open', () => onOpen?.());
    source.addEventListener('message', (event) => {
      try {
        onBatch?.(JSON.parse(event.data));
      } catch (error) {
        onError?.(error);
      }
    });
    source.addEventListener('error', (error) => onError?.(error));
    return () => source.close();
  },
  resolveApproval: (id, payload, timeoutMs = 8000) => request(`/chat/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(payload) }, timeoutMs),
  approvals: ({ kind = '', status = 'pending' } = {}) => request(`/chat/approvals?kind=${encodeURIComponent(kind)}&status=${encodeURIComponent(status)}`),
  chatHistory: ({ before = '', after = '', limit = 50, date = '', query = '' } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', String(before));
    if (after) params.set('after', String(after));
    if (date) params.set('date', date);
    if (query) params.set('query', query);
    return request(`/chat/history?${params}`);
  },
  settings: () => request('/settings'),
  phoneUsageStatus: () => request('/phone-usage/status'),
  savePhoneUsageSnapshot: (payload) => request('/phone-usage/snapshots', { method: 'POST', body: JSON.stringify(payload) }),
  recentPhoneUsage: (lookbackMinutes = 120) => request(`/phone-usage/recent?lookbackMinutes=${encodeURIComponent(lookbackMinutes)}`),
  didaStatus: () => request('/integrations/dida/status'),
  startDidaLogin: () => request('/integrations/dida/oauth/start', { method: 'POST', body: '{}' }),
  didaProjects: () => request('/integrations/dida/projects'),
  selectDidaProjects: (projectIds) => request('/integrations/dida/supervised-project', { method: 'PUT', body: JSON.stringify({ projectIds }) }),
  supervisedTasks: ({ scope = 'all', keyword = '', limit = 50 } = {}) => {
    const params = new URLSearchParams({ scope, limit: String(limit) });
    if (keyword) params.set('keyword', keyword);
    return request(`/tasks/supervised?${params}`);
  },
  reminders: (status = 'all') => request(`/reminders?status=${encodeURIComponent(status)}`),
  studyPlans: () => request('/study/plans'),
  studyPlan: (id) => request(`/study/plans/${encodeURIComponent(id)}`),
  cancelReminder: (id, baseRevision) => request(`/reminders/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({ baseRevision }) }),
  memories: ({ status = 'active', query = '' } = {}) => request(`/memory?status=${encodeURIComponent(status)}&query=${encodeURIComponent(query)}`),
  memoryNodes: ({ tier = 'retrievable', status = '', query = '', limit = 20, offset = 0 } = {}) => request(`/memory/nodes?tier=${encodeURIComponent(tier)}&status=${encodeURIComponent(status)}&query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`),
  memoryNode: (id) => request(`/memory/nodes/${encodeURIComponent(id)}`),
  memoryV2List: ({ state = '', status = 'available', type = '', limit = 200 } = {}) => request(`/memory-v2?state=${encodeURIComponent(state)}&status=${encodeURIComponent(status)}&type=${encodeURIComponent(type)}&limit=${limit}`),
  memoryV2Stats: () => request('/memory-v2/stats'),
  memoryV2Maintenance: () => request('/memory-v2/maintenance'),
  memoryV2MaintenanceTrigger: () => request('/memory-v2/maintenance/trigger', { method: 'POST' }),
  memoryV2MaintenanceEnabled: (enabled) => request('/memory-v2/maintenance/enabled', { method: 'POST', body: JSON.stringify({ enabled }) }),
  memoryV2: (id) => request(`/memory-v2/${encodeURIComponent(id)}`),
  memoryV2Evidence: (id, full = false) => request(`/memory-v2/${encodeURIComponent(id)}/evidence?full=${full}`),
  memoryV2Related: (id) => request(`/memory-v2/${encodeURIComponent(id)}/related`),
  updateMemoryV2: (id, payload) => request(`/memory-v2/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  reportMemoryV2Issue: (payload) => request('/memory-v2/issues', { method: 'POST', body: JSON.stringify(payload) }),
  createMemoryNode: (payload) => request('/memory/nodes', { method: 'POST', body: JSON.stringify(payload) }),
  updateMemoryNode: (id, payload) => request(`/memory/nodes/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  memory: (id) => request(`/memory/${encodeURIComponent(id)}`),
  createMemory: (payload) => request('/memory', { method: 'POST', body: JSON.stringify(payload) }),
  checkMemoryDuplicate: (payload) => request('/memory/duplicate-check', { method: 'POST', body: JSON.stringify(payload) }),
  updateMemory: (id, payload) => request(`/memory/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) }),
  archiveMemory: (id, payload) => request(`/memory/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify(payload) }),
  restoreMemory: (id, payload) => request(`/memory/${encodeURIComponent(id)}/restore`, { method: 'POST', body: JSON.stringify(payload) }),
  timeline: ({ start, end }) => request(`/timeline?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  timelineStats: ({ start, end }) => request(`/timeline/stats?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  timelineCategories: ({ includeInactive = false } = {}) => request(`/timeline/categories${includeInactive ? '?includeInactive=true' : ''}`),
  createTimelineCategory: (payload) => request('/timeline/categories', { method: 'POST', body: JSON.stringify(payload) }),
  createTimelineSubcategory: (categoryId, payload) => request(`/timeline/categories/${encodeURIComponent(categoryId)}/children`, { method: 'POST', body: JSON.stringify(payload) }),
  updateTimelineCategory: (categoryId, payload) => request(`/timeline/categories/${encodeURIComponent(categoryId)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  updateTimelineSubcategory: (categoryId, subcategoryId, payload) => request(`/timeline/categories/${encodeURIComponent(categoryId)}/children/${encodeURIComponent(subcategoryId)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  timelineReview: (date) => request(`/timeline/reviews/${encodeURIComponent(date)}`),
  createTimelineEvent: (payload) => request('/timeline/events', { method: 'POST', body: JSON.stringify(payload) }),
  updateTimelineEvent: (id, payload) => request(`/timeline/events/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) }),
  archiveTimelineEvent: (id, payload) => request(`/timeline/events/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify(payload) }),
  restoreTimelineEvent: (id, payload) => request(`/timeline/events/${encodeURIComponent(id)}/restore`, { method: 'POST', body: JSON.stringify(payload) }),
  saveTimelineReview: (date, payload) => request(`/timeline/reviews/${encodeURIComponent(date)}`, { method: 'PUT', body: JSON.stringify(payload) }),
  spacePosts: ({ author = 'all', start = '', end = '', limit = 100 } = {}) => {
    const params = new URLSearchParams({ author, limit: String(limit) });
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    return request(`/space/posts?${params}`);
  },
  createSpacePost: (payload) => request('/space/posts', { method: 'POST', body: JSON.stringify(payload) }, 120_000),
  updateSpacePost: (id, payload) => request(`/space/posts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) }, 120_000),
  deleteSpacePost: (id, baseRevision) => request(`/space/posts/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ baseRevision }) }, 30_000),
  updateSettings: (patch) => request('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  runtimeStatus: () => request('/runtime/status'),
  runtimeActivity: () => request('/runtime/activity'),
  models: () => request('/runtime/models'),
  readDocument: (name) => request(`/documents/${encodeURIComponent(name)}`),
  saveDocument: (name, text, baseRevision = '') => request(`/documents/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ text, baseRevision }) }),
  documentHistory: (name) => request(`/documents/${encodeURIComponent(name)}/history`),
  restoreDocument: (name, revision, baseRevision) => request(`/documents/${encodeURIComponent(name)}/restore`, { method: 'POST', body: JSON.stringify({ revision, baseRevision }) }),
  compactThread: () => request('/runtime/compact', { method: 'POST', body: '{}' }, 10 * 60_000),
  startNewThread: () => request('/runtime/thread/new', { method: 'POST', body: '{}' }),
};

function handleStreamLine(line, onEvent) {
  if (!line.trim()) return false;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    throw new EthereApiError('回复流格式错误');
  }
  if (event.type === 'error') throw new EthereApiError(event.message || '回复失败');
  onEvent?.(event);
  return event.type === 'done';
}
