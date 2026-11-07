export const SPACE_MCP_TOOL_NAMES = Object.freeze([
  'ethere_space_recent_get',
  'ethere_space_post_create',
  'ethere_space_post_update',
]);

export function createSpaceMcpTools({ apiBase = process.env.ETHERE_API_BASE || 'http://127.0.0.1:4173', fetchImpl = fetch } = {}) {
  const tools = [{
    name: 'ethere_space_recent_get',
    description: '紧凑读取空间中最近的用户记录和助手动态；只返回文本和图片数量，不返回图片内容。',
    inputSchema: objectSchema({
      author: { type: 'string', enum: ['all', 'user', 'assistant'], description: '默认 all。' },
      limit: { type: 'integer', minimum: 1, maximum: 30, description: '默认 10 条。' },
    }, []),
    annotations: { readOnlyHint: true },
    call: (args) => request(fetchImpl, apiBase, `/api/ethere/v1/space/posts?author=${encodeURIComponent(args.author || 'all')}&limit=${encodeURIComponent(args.limit || 10)}&compact=true`),
  }, {
    name: 'ethere_space_post_create',
    description: '以助手身份在空间写入一条动态。作者由服务器固定为 assistant，不会冒充用户。工具成功前不得声称已写入。',
    inputSchema: objectSchema({
      contentMarkdown: { type: 'string', minLength: 1, maxLength: 20_000, description: '动态正文，支持 Markdown。' },
      occurredAt: { type: 'string', description: '可选，含时区的 ISO 8601 发生时间；默认当前时间。' },
    }, ['contentMarkdown']),
    annotations: { readOnlyHint: false, destructiveHint: false },
    call: (args) => request(fetchImpl, apiBase, '/api/ethere/v1/space/posts/assistant', { method: 'POST', body: args }),
  }, {
    name: 'ethere_space_post_update',
    description: '重写一条已有的助手空间动态。先用 ethere_space_recent_get 取得稳定 postId 和 revision；服务器只允许修改 assistant 写的动态，不允许修改用户动态。',
    inputSchema: objectSchema({
      postId: { type: 'string', minLength: 1 },
      baseRevision: { type: 'integer', minimum: 1 },
      contentMarkdown: { type: 'string', minLength: 1, maxLength: 20_000 },
    }, ['postId', 'baseRevision', 'contentMarkdown']),
    annotations: { readOnlyHint: false, destructiveHint: false },
    call: (args) => request(fetchImpl, apiBase, `/api/ethere/v1/space/posts/${encodeURIComponent(args.postId)}/assistant`, { method: 'PUT', body: { baseRevision: args.baseRevision, contentMarkdown: args.contentMarkdown } }),
  }];
  return {
    list: () => tools.map(({ call, ...tool }) => tool),
    async call(name, args = {}) {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw toolError('UNKNOWN_TOOL', `未知工具：${name}`);
      return tool.call(args && typeof args === 'object' ? args : {});
    },
  };
}

async function request(fetchImpl, apiBase, path, options = {}) {
  const response = await fetchImpl(`${apiBase}${path}`, {
    method: options.method || 'GET', headers: { 'Content-Type': 'application/json' },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw toolError('SPACE_REQUEST_FAILED', payload.error || '空间操作失败');
  return payload;
}
function objectSchema(properties, required) { return { type: 'object', properties, required, additionalProperties: false }; }
function toolError(code, message) { const error = new Error(message); error.code = code; return error; }
