export const DEVELOPER_TASK_MCP_TOOL_NAMES = Object.freeze([
  'developer_task_create', 'developer_task_get', 'developer_task_list', 'developer_task_send', 'developer_task_cancel',
]);

export function createDeveloperTaskMcpTools({ bridge }) {
  if (!bridge) throw new Error('缺少开发代理桥客户端');
  const tools = [{
    name: 'developer_task_create',
    description: '把用户明确交给工程代理的开发工作创建为异步任务；独立 Codex thread 执行，不占用当前 Ethere 对话。默认仅可在专用 developer-workspace 内写项目，不能修改 Ethere 自身；若不知道工作目录，先用 developer_task_list 查看 allowedRoots，cwd 必须在白名单内。迭代 Ethere 自身需要用户另行授权并显式配置白名单。权限只可设 readOnly 或 workspaceWrite，默认后者；需要额外权限时任务会停下，不可自行批准。返回稳定 taskId。不要把普通聊天自动变成开发任务。',
    inputSchema: schema({ title: { type: 'string' }, cwd: { type: 'string' }, instruction: { type: 'string' }, model: { type: 'string' }, permission: { type: 'string', enum: ['readOnly', 'workspaceWrite'] } }, ['title', 'cwd', 'instruction']),
    async call(args) { return { task: await bridge.create(args) }; },
  }, {
    name: 'developer_task_get',
    description: '按稳定 taskId 读取异步开发任务的真实状态、结果摘要、修改文件、测试和阻塞原因。只有 completed 才代表 app-server 完成了本轮；模型自述不能代替状态。',
    inputSchema: schema({ taskId: { type: 'string' } }, ['taskId']),
    annotations: { readOnlyHint: true },
    async call(args) { return { task: await bridge.get(args.taskId) }; },
  }, {
    name: 'developer_task_list',
    description: '查看正在运行、等待输入或审批、以及近期结束的开发任务及稳定 taskId。',
    inputSchema: schema({}, []), annotations: { readOnlyHint: true },
    async call() { return bridge.list(); },
  }, {
    name: 'developer_task_send',
    description: '将用户在对话中确定的追加要求送回原开发任务，复用原 Codex thread 和上下文；不创建新任务。任务运行中不可追加；等待审批时只能发送不越权的新要求，审批不会自动通过。',
    inputSchema: schema({ taskId: { type: 'string' }, instruction: { type: 'string' } }, ['taskId', 'instruction']),
    async call(args) { return { task: await bridge.send(args.taskId, args.instruction) }; },
  }, {
    name: 'developer_task_cancel',
    description: '取消异步开发任务；运行中的 Codex turn 会被中断。仅当用户要求停止或任务已经不需要时使用。',
    inputSchema: schema({ taskId: { type: 'string' } }, ['taskId']),
    async call(args) { return { task: await bridge.cancel(args.taskId) }; },
  }];
  return {
    list: () => tools.map(({ call, ...tool }) => tool),
    async call(name, args = {}) {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw new Error(`未知开发任务工具：${name}`);
      return tool.call(args);
    },
  };
}

function schema(properties, required) { return { type: 'object', properties, required, additionalProperties: false }; }
