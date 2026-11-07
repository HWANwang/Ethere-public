import { appendMemoryNotice } from './memory-notice.mjs';

export const MEMORY_MCP_TOOL_NAMES = Object.freeze(['ethere_memory_list', 'ethere_memory_propose', 'ethere_chat_history_search']);

export function createMemoryMcpTools({ memoryStore, memoryNodeStore = null, chatEventStore = null, spaceStore = null, timelineStore = null, includeLegacyNodes = true, includePromotion = true }) {
  if (!memoryStore) throw new Error('缺少记忆存储');
  async function verifySources(sources) {
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 5) throw toolError('SOURCES_REQUIRED', '请提供 1–5 条真实来源');
    const verified = [];
    for (const source of sources) {
      const type = String(source?.type || '');
      const id = String(source?.id || '').trim();
      let original = null;
      if (type === 'chat') original = await chatEventStore?.getById(id);
      if (type === 'space') original = await spaceStore?.get(id);
      if (type === 'timeline') original = await timelineStore?.getEvent(id).catch(() => null);
      if (!original || original.deletedAt || original.status === 'archived' || (type === 'chat' && !['user', 'assistant'].includes(original.role))) {
        throw toolError('SOURCE_NOT_FOUND', `来源 ${type}:${id} 不存在或不可引用，请先查找真实记录`);
      }
      verified.push({ type, id, relation: source.relation || 'supports' });
    }
    return verified;
  }
  const tools = [{
    name: 'ethere_memory_list',
    description: '读取当前有效的核心记忆及其稳定 ID、标题和完整内容。更新记忆前先用它定位现存主题；可用 query 按标题或内容筛选，避免引用旧线程里已归档或变化的 ID。',
    inputSchema: objectSchema({
      query: { type: 'string', maxLength: 120, description: '可选，按主题标题或内容关键词筛选；省略时列出全部当前记忆。' },
    }, []),
    annotations: { readOnlyHint: true },
    async call(args) {
      const result = await memoryStore.list({ status: 'active', query: String(args.query || '').trim().slice(0, 120) });
      return { memories: result.memories.map(({ id, title, contentMarkdown, revision }) => ({ id, title, contentMarkdown, revision })) };
    },
  }, {
    name: 'ethere_memory_propose',
    description: includePromotion
      ? '向用户提交核心记忆的新增、更新或按需记忆节点晋升建议，均需用户审批。只有明确长期偏好、关系边界、稳定事实，或用户要求每个新线程都知道的内容才建议放入核心。更新前调用 ethere_memory_list。人设与工具规则修改应使用文档审批工具。'
      : '向用户提交核心记忆的新增或更新建议，均需用户审批。只有明确长期偏好、关系边界、稳定事实，或用户要求每个新线程都知道的内容才建议放入核心。更新前调用 ethere_memory_list。人设与工具规则修改应使用文档审批工具。',
    inputSchema: objectSchema({
      operation: { type: 'string', enum: includePromotion ? ['create', 'update', 'promote'] : ['create', 'update'], description: includePromotion ? '新建核心主题用 create；更新已有核心用 update；将旧节点升为核心用 promote。' : '新建核心主题用 create；更新已有核心用 update。' },
      targetMemoryId: { type: 'string', description: 'update 时为核心记忆 ID；promote 时为可检索节点 ID。' },
      baseRevision: { type: 'integer', minimum: 1, description: 'promote 时填写刚打开的可检索节点修订号，用于防止审批期间覆盖较新的版本。' },
      title: { type: 'string', minLength: 1, maxLength: 80, description: '面向用户的具体主题标题，避免“用户偏好”一类过宽标题。' },
      contentMarkdown: { type: 'string', minLength: 1, maxLength: 20000, description: '该主题审批通过后的完整 Markdown 内容；更新时提交合并后的完整版本，而不是只写增量。' },
      reason: { type: 'string', minLength: 1, maxLength: 240, description: '简述为什么它值得跨线程长期保留。' },
    }, ['operation', 'title', 'contentMarkdown', 'reason']),
    annotations: { readOnlyHint: true },
    async call(args) {
      const allowedOperations = includePromotion ? ['create', 'update', 'promote'] : ['create', 'update'];
      const operation = allowedOperations.includes(args.operation) ? args.operation : '';
      const targetMemoryId = String(args.targetMemoryId || '').trim();
      if (!operation) throw toolError('INVALID_OPERATION', `operation 必须是 ${allowedOperations.join(' 或 ')}`);
      if (operation !== 'create' && !targetMemoryId) throw toolError('TARGET_REQUIRED', '更新或晋升记忆必须提供 targetMemoryId');
      const title = String(args.title || '').trim();
      const contentMarkdown = String(args.contentMarkdown || '').trim();
      const reason = String(args.reason || '').trim();
      if (!title || !contentMarkdown || !reason) throw toolError('INCOMPLETE_PROPOSAL', '记忆建议内容不完整');
      let target = null;
      let duplicate = null;
      if (operation === 'promote') {
        target = await memoryNodeStore?.get(targetMemoryId);
        if (!target || target.tier !== 'retrievable' || target.status === 'archived') throw toolError('NODE_NOT_FOUND', '要晋升的可检索节点不存在或已归档，请重新搜索节点');
        if (Number(args.baseRevision) !== target.revision) throw toolError('NODE_CHANGED', '可检索节点修订号不匹配，请重新打开节点核对后提交');
        duplicate = await memoryStore.findDuplicate({ title, contentMarkdown });
        if (duplicate) throw toolError('DUPLICATE_CORE', `已有相近核心主题“${duplicate.memory.title}”（ID: ${duplicate.memory.id}），请先考虑更新现有核心记忆，不要晋升出重复主题`);
      } else if (operation === 'update') {
        target = await memoryStore.get(targetMemoryId);
        if (!target || target.status !== 'active') {
          const current = await memoryStore.list({ status: 'active' });
          const candidates = current.memories.map((memory) => `${memory.id}：${memory.title}`).join('；');
          throw toolError('MEMORY_NOT_FOUND', `目标记忆不存在或已经归档。当前有效主题与 ID：${candidates || '暂无'}。请定位对应主题后重新提交更新，不要新建重复记忆。`);
        }
      } else {
        duplicate = await memoryStore.findDuplicate({ title, contentMarkdown });
      }
      return {
        pendingApproval: true,
        proposal: {
          operation,
          ...(target ? { targetMemoryId: target.id, baseRevision: target.revision } : {}),
          title,
          contentMarkdown,
          reason,
          ...(duplicate ? { duplicateCandidate: { memoryId: duplicate.memory.id, title: duplicate.memory.title, revision: duplicate.memory.revision, reason: duplicate.reason, score: duplicate.score } } : {}),
        },
      };
    },
  }];
  if (memoryNodeStore && includeLegacyNodes) tools.push({
    name: 'ethere_memory_nodes_search',
    description: '在用户追问过去经历、已知人物或项目时，搜索同一记忆库中的核心记忆和按需记忆；两者都可检索，区别只是核心还会完整带入新线程。普通闲聊无需例行调用。输入多个线索词时用空格或逗号分隔，工具自动逐词检索并按词分组返回，每条标明档位和状态；不要把多个词当成一个精确标题。搜索结果不是原始证据，细节需打开来源。搜到核心不要再复制创建按需节点。',
    inputSchema: objectSchema({ query: { type: 'string', minLength: 1, maxLength: 120 } }, ['query']),
    annotations: { readOnlyHint: true },
    async call(args) {
      const query = String(args.query || '').trim();
      if (!query) throw toolError('QUERY_REQUIRED', '请提供具体人物、项目或经历关键词');
      const terms = [...new Set(query.split(/[\s,，、;；]+/u).filter(Boolean))].slice(0, 6);
      if (!terms.length) throw toolError('QUERY_REQUIRED', '请提供具体人物、项目或经历关键词');
      const groups = await Promise.all(terms.map(async (term) => ({ term, nodes: (await memoryNodeStore.search({ query: term, limit: 5 })).map(briefNode) })));
      const nodes = [...new Map(groups.flatMap((group) => group.nodes).map((node) => [node.id, node])).values()].slice(0, 10);
      return { nodes, groups, queryMode: terms.length > 1 ? 'split-by-term' : 'single-term' };
    },
  }, {
    name: 'ethere_memory_node_open',
    description: '打开一个已检索到的记忆节点及仍存在的原始来源。要谈具体细节时先核对来源；来源已删除就不要复述其旧内容。',
    inputSchema: objectSchema({ id: { type: 'string', minLength: 1 }, sourceOffset: { type: 'integer', minimum: 0, description: '来源超过 8 条时继续读取后续来源；默认从最新开始。' } }, ['id']),
    annotations: { readOnlyHint: true },
    async call(args) {
      const node = await memoryNodeStore.get(String(args.id || ''));
      if (!node || node.status === 'archived') throw toolError('NOT_FOUND', '记忆节点不存在或已归档');
      const sourceOffset = Math.max(0, Number(args.sourceOffset) || 0);
      const sources = await Promise.all(node.sources.slice(sourceOffset, sourceOffset + 8).map(async (source) => {
        let original = null;
        if (source.type === 'chat') original = await chatEventStore?.getById(source.id);
        if (source.type === 'space') original = await spaceStore?.get(source.id);
        if (source.type === 'timeline') original = await timelineStore?.getEvent(source.id).catch(() => null);
        if (!original || original.deletedAt) return { type: source.type, id: source.id, unavailable: true };
        return { type: source.type, id: source.id, content: String(original.content || original.contentMarkdown || original.title || '').slice(0, 2_000), createdAt: original.createdAt || original.occurredAt || '' };
      }));
      return { node: { id: node.id, topicKey: node.topicKey, content: node.content, tier: node.tier, status: node.status, owner: node.owner, revision: node.revision, aliases: node.aliases }, sources, sourceCount: node.sources.length, nextSourceOffset: sourceOffset + sources.length < node.sources.length ? sourceOffset + sources.length : null };
    },
  }, {
    name: 'ethere_memory_node_create',
    description: '将对未来有用、但无需每个新线程完整加载的经历或待验证观察写为按需记忆节点。创建前先搜索整个记忆库，避免重复；必须引用真实的聊天、空间或时间线来源 ID。创建后立即可检索，无需用户逐条确认；待验证的理解应在内容中明确标注，不能说成已证实的事实。只有升级或新增核心记忆才用 ethere_memory_propose 申请审批。不要把原始聊天逐条照抄成节点。',
    inputSchema: objectSchema({
      topicKey: { type: 'string', minLength: 1, maxLength: 120, description: '用户在记忆页面看见的标题，不是仅供机器使用的内部键；简短具体，已有主题应沿用。' },
      content: { type: 'string', minLength: 1, maxLength: 2000, description: '可复用的简短理解；不确定的判断明确写为待验证，不把一次经历定型。' },
      owner: { type: 'string', enum: ['user', 'assistant', 'relationship'], description: '关于用户、你自己或彼此关系。默认 user。' },
      aliases: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 80 }, description: '可选的称呼或检索别名。' },
      sources: { type: 'array', minItems: 1, maxItems: 5, items: objectSchema({ type: { type: 'string', enum: ['chat', 'space', 'timeline'] }, id: { type: 'string', minLength: 1 } }, ['type', 'id']), description: '至少一条已存在的原始记录，可用聊天搜索获取消息 ID。' },
    }, ['topicKey', 'content', 'sources']),
    annotations: { readOnlyHint: false, destructiveHint: false },
    async call(args) {
      const topicKey = String(args.topicKey || '').trim();
      const content = String(args.content || '').trim();
      const sources = args.sources;
      if (!topicKey || !content || topicKey.length > 120 || content.length > 2000) throw toolError('INVALID_NODE', '请提供简短、具体的主题键和内容');
      const verifiedSources = await verifySources(sources);
      const matches = await Promise.all((await memoryNodeStore.search({ query: topicKey, limit: 20 })).map((node) => memoryNodeStore.get(node.id)));
      const existing = matches.find((node) => node?.status === 'active' && (node.topicKey === topicKey || node.aliases.includes(topicKey)));
      if (existing) throw toolError('NODE_EXISTS', `主题“${topicKey}”已有${existing.tier === 'core' ? '核心记忆' : '按需记忆'}节点（ID: ${existing.id}），请先打开并${existing.tier === 'core' ? '按核心审批规则处理' : '修订已有节点'}，不要重复创建`);
      const node = await memoryNodeStore.create({ topicKey, content, owner: args.owner, aliases: args.aliases, sources: verifiedSources, tier: 'retrievable', status: 'active' });
      await appendMemoryNotice(chatEventStore, 'created', node.topicKey);
      return { created: true, node: { id: node.id, topicKey: node.topicKey, tier: node.tier, status: node.status, revision: node.revision, sourceCount: node.sources.length } };
    },
  }, {
    name: 'ethere_memory_node_revise',
    description: '修订已有按需记忆的显示标题、内容、别名或来源，而不是新建近义节点。先搜索并打开旧节点、核对修订号。topicKey 是页面标题，不是不可改的内部键；改标题用 title，节点 ID 保持不变，旧标题会保留为检索别名。改内容时须追加 1–5 条真实新来源；只纠正标题时不必补来源。旧来源与版本保留。按需修订直接生效；核心记忆只能通过 ethere_memory_propose 申请审批。',
    inputSchema: objectSchema({
      nodeId: { type: 'string', minLength: 1, description: '搜索并打开后取得的已有按需节点 ID。' },
      baseRevision: { type: 'integer', minimum: 1, description: '刚打开节点时的修订号；已变化时需重新读取。' },
      title: { type: 'string', minLength: 1, maxLength: 120, description: '可选，用户在记忆页面看到的新标题。只改标题可以不提供新来源；旧标题自动成为检索别名。' },
      content: { type: 'string', minLength: 1, maxLength: 2000, description: '可选，融合旧理解与新证据后的完整短内容；仅补来源时可省略。' },
      aliases: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 80 }, description: '可选的新检索别名，只追加、不覆盖旧别名。' },
      sources: { type: 'array', minItems: 1, maxItems: 5, items: objectSchema({ type: { type: 'string', enum: ['chat', 'space', 'timeline'] }, id: { type: 'string', minLength: 1 }, relation: { type: 'string', enum: ['supports', 'corrects', 'contradicts'] } }, ['type', 'id']), description: '修改内容时至少一条真实原始记录；只改标题或别名时可省略。重复来源自动去重。' },
    }, ['nodeId', 'baseRevision']),
    annotations: { readOnlyHint: false, destructiveHint: false },
    async call(args) {
      const node = await memoryNodeStore.get(String(args.nodeId || ''));
      if (!node || node.tier !== 'retrievable' || node.status !== 'active') throw toolError('NODE_NOT_FOUND', '可修订的按需记忆节点不存在；核心内容必须走审批');
      if (Number(args.baseRevision) !== node.revision) throw toolError('NODE_CHANGED', '记忆节点已更新，请重新打开后修订');
      if (args.title != null && (!String(args.title).trim() || String(args.title).trim().length > 120)) throw toolError('INVALID_NODE', '请提供不超过 120 字的记忆标题');
      if (args.content != null && (!String(args.content).trim() || String(args.content).length > 2_000)) throw toolError('INVALID_NODE', '请提供不超过 2000 字的完整短内容');
      if (args.content == null && args.title == null && !args.aliases?.length && !args.sources?.length) throw toolError('INVALID_NODE', '请提供要修改的标题、内容、别名或来源');
      const sources = args.sources == null ? [] : await verifySources(args.sources);
      const revised = await memoryNodeStore.reviseRetrievable(node.id, { title: args.title, content: args.content, sources, aliases: args.aliases || [] }, { baseRevision: args.baseRevision });
      if (revised.revision !== node.revision) await appendMemoryNotice(chatEventStore, 'revised', revised.topicKey);
      return { revised: revised.revision !== node.revision, node: { id: revised.id, topicKey: revised.topicKey, tier: revised.tier, status: revised.status, revision: revised.revision, sourceCount: revised.sources.length } };
    },
  });
  if (chatEventStore) tools.push({
    name: 'ethere_chat_history_search',
    description: '仅在用户追问过去的具体对话、人物或经历，而记忆短线索不足以回答时，按中文关键词检索原始聊天。返回有限片段和消息 ID；不应把搜索不到当作事情没发生。',
    inputSchema: objectSchema({ query: { type: 'string', minLength: 1, maxLength: 120 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, ['query']),
    annotations: { readOnlyHint: true },
    async call(args) {
      const query = String(args.query || '').trim().slice(0, 120);
      if (!query) throw toolError('QUERY_REQUIRED', '请提供要找的原文关键词');
      const result = await chatEventStore.listHistory({ query, roles: ['user', 'assistant'], limit: Math.max(1, Math.min(10, Number(args.limit) || 8)) });
      return { events: result.events.map((event) => ({ id: event.id, role: event.role, createdAt: event.createdAt, content: String(event.content || '').slice(0, 2_000) })), hasMore: result.hasMore };
    },
  });
  return {
    list: () => tools.map(({ call, ...tool }) => tool),
    async call(name, args = {}) {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw toolError('UNKNOWN_TOOL', `未知工具：${name}`);
      return tool.call(args && typeof args === 'object' ? args : {});
    },
  };
}

function objectSchema(properties, required) { return { type: 'object', properties, required, additionalProperties: false }; }
function briefNode(node) { return { id: node.id, topicKey: node.topicKey, content: node.content.slice(0, 320), tier: node.tier, tierLabel: node.tier === 'core' ? '核心记忆' : '按需记忆', status: node.status, owner: node.owner, revision: node.revision }; }
function toolError(code, message) { const error = new Error(message); error.code = code; return error; }
