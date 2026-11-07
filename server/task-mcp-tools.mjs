export const TASK_MCP_TOOL_NAMES = Object.freeze([
  'ethere_supervised_tasks_get',
  'ethere_task_change_propose',
  'ethere_task_with_reminder_propose',
  'ethere_task_complete',
]);

export function createTaskMcpTools({ apiBase = process.env.ETHERE_API_BASE || 'http://127.0.0.1:4173', fetchImpl = fetch } = {}) {
  const tools = [{
    name: 'ethere_supervised_tasks_get',
    description: '读取用户在 Ethere 设置中指定的一个或多个滴答监督清单。用于了解今天、逾期、本周、未安排或全部待办；服务器会强制限制在用户选择的清单内。keyword 可选，可在同一次读取中按任务标题过滤，不需要另行调用搜索工具。结果中的 repeat 是滴答任务自身的重复周期，不是 Ethere 的提醒复查间隔。isAllDay 为 true 时，startAt/dueAt 是日期的底层时间戳，不要把 23:59 等钟点说成用户设置的具体截止时间。不要用它读取其他清单。',
    inputSchema: objectSchema({
      scope: { type: 'string', enum: ['today', 'week', 'undated', 'all'], description: 'today 包含今天和已逾期；week 为本周；undated 为未安排日期；all 为监督清单内全部未完成。' },
      keyword: { type: 'string', maxLength: 100, description: '可选，按任务标题包含匹配。' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回多少条，默认 30。' },
    }, ['scope']),
    annotations: { readOnlyHint: true },
    async call(args) {
      const query = new URLSearchParams({ scope: args.scope, limit: String(args.limit || 30) });
      if (args.keyword) query.set('keyword', String(args.keyword));
      const response = await fetchImpl(`${apiBase}/api/ethere/v1/tasks/supervised?${query}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw toolError('TASK_QUERY_FAILED', payload.error || '无法读取监督任务');
      return payload;
    },
  }, {
    name: 'ethere_task_change_propose',
    description: '提交滴答任务的新建或修改建议。新建只能写入用户选中的监督清单；修改前先用 ethere_supervised_tasks_get 定位稳定 taskId，候选不唯一时不要猜。只填写需要新建或修改的字段。任务本身的重复周期用 repeatFlag，不能拿 Ethere 提醒的 repeatMinutes 代替；审批卡会展示重复规则。',
    inputSchema: objectSchema({
      operation: { type: 'string', enum: ['create', 'update'], description: '新建使用 create，修改既有任务使用 update。' },
      projectId: { type: 'string', description: 'create 时必填，必须来自 supervised_tasks_get 返回的监督清单。' },
      projectName: { type: 'string', maxLength: 120, description: '清单名称快照，用于审批卡片展示；从 supervised_tasks_get 的 projects 中取得。' },
      taskId: { type: 'string', description: 'update 时必填，必须来自 supervised_tasks_get。' },
      taskTitle: { type: 'string', maxLength: 300, description: '修改既有任务时填写原任务标题快照，用于审批卡片展示。' },
      title: { type: 'string', minLength: 1, maxLength: 300, description: '新建时必填；修改标题时填写新标题。' },
      content: { type: 'string', maxLength: 8000, description: '可选，任务详情正文。' },
      startAt: { anyOf: [{ type: 'string' }, { type: 'null' }], description: '可选，含时区的 ISO 8601 开始时间；修改时用 null 清除开始日期，不要填写 1970 年占位日期。' },
      dueAt: { anyOf: [{ type: 'string' }, { type: 'null' }], description: '可选，含时区的 ISO 8601 截止时间；修改时用 null 清除截止日期，不要填写 1970 年占位日期。' },
      isAllDay: { type: 'boolean', description: '可选，是否为全天任务。' },
      priority: { type: 'integer', enum: [0, 1, 3, 5], description: '可选，0 无、1 低、3 中、5 高。' },
      repeatFlag: { anyOf: [{ type: 'string', maxLength: 160 }, { type: 'null' }], description: '可选，滴答任务自身的重复周期，使用受支持的 RRULE：每天 RRULE:FREQ=DAILY;INTERVAL=1；每周一 RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO；每月 15 日 RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15。可调 INTERVAL；周几用 MO..SU，多天用逗号。设置重复时任务须有开始或截止日期，首个日期应与周期相符；修改时传 null 清除重复。不要与提醒复查间隔混淆。' },
      reason: { type: 'string', minLength: 1, maxLength: 240, description: '用一句话说明为什么建议这次新建或修改。' },
    }, ['operation', 'reason']),
    annotations: { readOnlyHint: true },
    call: (args) => request(fetchImpl, apiBase, '/api/ethere/v1/tasks/change-proposal', { method: 'POST', body: args }),
  }, {
    name: 'ethere_task_with_reminder_propose',
    description: '一次提出“新建滴答任务并关联提醒”，生成一张组合审批卡。任务只能建在用户选中的监督清单；审批后服务器先创建真实任务，再用其 taskId 创建提醒。不要另外提交单独的任务建议或先创建提醒，避免重复。task.repeatFlag 是滴答任务周期；reminder.repeatMinutes 是 Ethere 未完成时的复查间隔，两者独立。关联提醒只绑定本次返回的 taskId，不承诺跨滴答后续周期自动续接。一次提醒或持续监督填写 triggerAt；关联任务完成后提醒自动取消。',
    inputSchema: objectSchema({
      task: objectSchema({
        projectId: { type: 'string', minLength: 1, description: '来自 ethere_supervised_tasks_get 的监督清单 ID。' },
        projectName: { type: 'string', maxLength: 120, description: '清单名称快照，用于审批展示。' },
        title: { type: 'string', minLength: 1, maxLength: 300 },
        content: { type: 'string', maxLength: 8000 },
        startAt: { type: 'string', description: '可选，含时区的 ISO 8601 开始时间。' },
        dueAt: { type: 'string', description: '可选，含时区的 ISO 8601 截止时间。' },
        isAllDay: { type: 'boolean' },
        priority: { type: 'integer', enum: [0, 1, 3, 5] },
        repeatFlag: { type: 'string', maxLength: 160, description: '可选，滴答任务重复周期，格式同 ethere_task_change_propose.repeatFlag；必须同时给任务设置开始或截止日期。' },
      }, ['projectId', 'title']),
      reminder: objectSchema({
        message: { type: 'string', minLength: 1, maxLength: 2000, description: '到点时交给模型的提醒内容；审批卡只显示创建理由，不展示这段内部提示。' },
        triggerAt: { type: 'string', description: '首次触发的含时区 ISO 8601 时间；审批时若已过期，整张卡不会执行。' },
        repeatMinutes: { type: 'integer', minimum: 5, maximum: 10080, description: '可选，任务未完成时的复查间隔。' },
      }, ['message', 'triggerAt']),
      reason: { type: 'string', minLength: 1, maxLength: 240 },
    }, ['task', 'reminder', 'reason']),
    annotations: { readOnlyHint: true },
    call: (args) => request(fetchImpl, apiBase, '/api/ethere/v1/tasks/with-reminder-proposal', { method: 'POST', body: args }),
  }, {
    name: 'ethere_task_complete',
    description: '将监督清单中的滴答任务标记为已完成，不需要审批。仅当用户明确表示该任务已经完成时调用；不能因为用户准备做、正在做、可能做完或模型自行推测而调用。先用 ethere_supervised_tasks_get 取得唯一稳定 taskId。',
    inputSchema: objectSchema({
      taskId: { type: 'string', minLength: 1, description: '要完成的稳定滴答 taskId。' },
      taskTitle: { type: 'string', maxLength: 300, description: '任务标题快照，用于聊天活动提示。' },
    }, ['taskId']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    call: (args) => request(fetchImpl, apiBase, `/api/ethere/v1/tasks/${encodeURIComponent(args.taskId)}/complete`, { method: 'POST', body: {} }),
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

function objectSchema(properties, required) { return { type: 'object', properties, required, additionalProperties: false }; }
function toolError(code, message) { const error = new Error(message); error.code = code; return error; }

async function request(fetchImpl, apiBase, path, options = {}) {
  const response = await fetchImpl(`${apiBase}${path}`, {
    method: options.method || 'GET', headers: { 'Content-Type': 'application/json' },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw toolError('TASK_WRITE_FAILED', payload.error || '滴答任务操作失败');
  return payload;
}
