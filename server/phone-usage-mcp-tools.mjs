export const PHONE_USAGE_MCP_TOOL_NAMES = Object.freeze(['ethere_phone_usage_recent_get']);

export function createPhoneUsageMcpTools({ apiBase = process.env.ETHERE_API_BASE || 'http://127.0.0.1:4173', fetchImpl = fetch } = {}) {
  const tool = {
    name: 'ethere_phone_usage_recent_get',
    description: '调用时请求手机现采集最近一段时间的屏幕状态与 App 前台片段，再返回统计和切换顺序。适合这些线索有助于理解用户近况或提供具体帮助时主动调用。手机无法实时响应时会明确报错，不可把旧数据当作当前状态；屏幕熄灭或某个 App 使用较久也不能证明用户已睡着或正在做某件事。',
    inputSchema: { type: 'object', properties: { lookbackMinutes: { type: 'integer', minimum: 5, maximum: 10080, description: '向前查询多少分钟，默认 120。' }, appIds: { type: 'array', maxItems: 30, items: { type: 'string' }, description: '可选，只返回这些应用包名。' }, includeTimeline: { type: 'boolean', description: '是否返回最多 100 条切换片段，默认 true。' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  };
  return { list: () => [tool], async call(name, args = {}) { if (name !== tool.name) throw Object.assign(new Error(`未知工具：${name}`), { code: 'UNKNOWN_TOOL' }); const query = new URLSearchParams({ lookbackMinutes: String(args.lookbackMinutes || 120), includeTimeline: String(args.includeTimeline !== false), fresh: 'true' }); for (const id of args.appIds || []) query.append('appId', id); const response = await fetchImpl(`${apiBase}/api/ethere/v1/phone-usage/recent?${query}`); const payload = await response.json().catch(() => ({})); if (!response.ok) throw Object.assign(new Error(payload.error || '无法读取手机使用情况'), { code: 'PHONE_USAGE_QUERY_FAILED' }); return payload; } };
}
