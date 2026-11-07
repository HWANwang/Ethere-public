const NAMES = new Set(['persona', 'operations']);

export function createDocumentMcpTools({ configStore }) {
  if (!configStore) throw new Error('缺少文档存储');
  const tools = [{
    name: 'ethere_document_read',
    description: '仅在用户与你讨论人设或工具使用规则、或明确要求修订时，读取相应当前文档及修订号。不要把这当作日常聊天的例行步骤。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', enum: ['persona', 'operations'] } }, required: ['name'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    async call(args) { return configStore.readDocument(requireName(args.name)); },
  }, {
    name: 'ethere_document_propose',
    description: '仅当用户明确同意修改人设或工具使用规则时，提交完整替换文本供用户审批；不会直接写入。先读取当前文档，基于当前修订编辑，不得静默改动关系边界或工具权限。',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', enum: ['persona', 'operations'] },
      baseRevision: { type: 'string', description: 'ethere_document_read 返回的当前修订号' },
      previousText: { type: 'string', description: '读取到的原文，用于审批时展示改前改后' },
      text: { type: 'string', minLength: 1, maxLength: 40000, description: '审批通过后将成为该文档的完整正文' },
      reason: { type: 'string', minLength: 1, maxLength: 240, description: '简要说明修改理由' },
    }, required: ['name', 'baseRevision', 'previousText', 'text', 'reason'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    async call(args) {
      const name = requireName(args.name);
      const current = await configStore.readDocument(name);
      if (String(args.baseRevision || '') !== current.revision) throw Object.assign(new Error('文档已变化，请重新读取再提交'), { statusCode: 409 });
      if (String(args.previousText || '') !== current.text) throw Object.assign(new Error('原文与当前版本不一致，请重新读取'), { statusCode: 409 });
      const text = String(args.text || '').trim();
      const reason = String(args.reason || '').trim();
      if (!text || !reason || text.length > 40_000 || reason.length > 240) throw Object.assign(new Error('提案正文或理由无效'), { statusCode: 400 });
      return { pendingApproval: true, proposal: { name, baseRevision: current.revision, previousText: current.text, text, reason } };
    },
  }];
  return {
    list: () => tools.map(({ call, ...tool }) => tool),
    async call(name, args = {}) {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw Object.assign(new Error(`未知工具：${name}`), { statusCode: 404 });
      return tool.call(args);
    },
  };
}

function requireName(name) {
  if (!NAMES.has(name)) throw Object.assign(new Error('文档名称无效'), { statusCode: 400 });
  return name;
}
