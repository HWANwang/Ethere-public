export const MEMORY_V2_MCP_TOOL_NAMES = Object.freeze(['search_memories', 'get_memory', 'get_related_memories', 'get_memory_evidence', 'report_memory_issue']);

export function createMemoryV2McpTools({ client }) {
  const tools = [
    tool('search_memories', '按当前话题主动搜索 Watch/Remember 长期记忆。自动召回不足、用户追问往事或需要更多线索时使用。', { query: string(), limit: integer(1, 10) }, ['query'], (a) => client.search(a)),
    tool('get_memory', '读取一条新记忆的完整内容与最近变更。', { memory_id: string() }, ['memory_id'], (a) => client.getMemory(a.memory_id)),
    tool('get_related_memories', '沿一层关系查看与指定记忆相关、冲突或被替代的记忆。', { memory_id: string() }, ['memory_id'], (a) => client.getRelated(a.memory_id)),
    tool('get_memory_evidence', '查看指定记忆对应的聊天、时间线或空间证据。', { memory_id: string(), full: { type: 'boolean' } }, ['memory_id'], (a) => client.getEvidence(a.memory_id, a.full === true)),
    tool('report_memory_issue', '报告新记忆错误、过时、混合、缺少上下文，或用户明确要求遗忘。报告后当前回合不要继续把该记忆当作确定事实。', { memory_id: string(), issue_type: { type: 'string', enum: ['incorrect', 'outdated', 'mixed', 'missing_context', 'forget_requested'] }, current_user_message_id: string(), note: string() }, ['memory_id', 'issue_type'], (a) => client.reportIssue(a)),
  ];
  return { list: () => tools.map(({ call, ...value }) => value), async call(name, args = {}) { const selected = tools.find((item) => item.name === name); if (!selected) throw new Error(`未知工具：${name}`); return selected.call(args); } };
}

function tool(name, description, properties, required, call) { return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint: name !== 'report_memory_issue' }, call }; }
function string() { return { type: 'string', minLength: 1 }; }
function integer(minimum, maximum) { return { type: 'integer', minimum, maximum }; }
