export const REMINDER_MCP_TOOL_NAMES = Object.freeze([
  'ethere_reminders_list',
  'ethere_reminder_create',
  'ethere_reminder_update',
  'ethere_reminder_cancel',
]);

export function createReminderMcpTools({ apiBase = process.env.ETHERE_API_BASE || 'http://127.0.0.1:4173', fetchImpl = fetch } = {}) {
  const tools = [
    {
      name: 'ethere_reminders_list',
      description: '读取 Ethere 的提醒任务及稳定 reminderId、revision。修改或取消既有提醒前调用；默认只读待触发提醒。',
      inputSchema: objectSchema({
        status: { type: 'string', enum: ['scheduled', 'completed', 'cancelled', 'all'], description: '默认 scheduled；all 返回全部状态。' },
      }, []), annotations: { readOnlyHint: true },
      call: (args) => request(fetchImpl, apiBase, `/api/ethere/v1/reminders?status=${encodeURIComponent(args.status || 'scheduled')}`),
    },
    {
      name: 'ethere_reminder_create',
      description: '创建一个会唤醒 Ethere 并主动联系用户的提醒。一次提醒或持续监督使用 triggerAt；每天按固定当地时间执行的日程使用 dailyAt。若提醒用于跟进滴答任务，先用 ethere_supervised_tasks_get 取得 taskId，再填写 relatedTaskId；repeatMinutes 表示任务仍未完成时的复查间隔，省略则只触发一次，关联任务完成后循环会自动停止。dailyAt 日程每次成功后仍保持启用。工具成功前不得声称已设置。',
      inputSchema: {
        ...objectSchema({
        title: { type: 'string', minLength: 1, maxLength: 120, description: '提醒任务的短标题。' },
        message: { type: 'string', minLength: 1, maxLength: 2000, description: '到点时需要提醒用户的事情。' },
        triggerAt: { type: 'string', description: '一次提醒或相对复查首次触发的含时区 ISO 8601 时间。' },
        dailyAt: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$', description: '每天固定触发的当地时间，格式 HH:mm。与 triggerAt 二选一。' },
        timezone: { type: 'string', description: 'dailyAt 的 IANA 时区；默认 Asia/Shanghai。' },
        relatedTaskId: { type: 'string', description: '可选，监督清单中稳定的滴答 taskId。' },
        relatedTaskTitle: { type: 'string', maxLength: 300, description: '可选，关联任务标题快照，仅用于界面显示。' },
        repeatMinutes: { type: 'integer', minimum: 5, maximum: 10080, description: '可选；未完成时隔多少分钟再次检查。没有持续监督需求就省略。' },
        }, ['title', 'message']),
        oneOf: [{ required: ['triggerAt'] }, { required: ['dailyAt'] }],
      }, annotations: { readOnlyHint: false, destructiveHint: false },
      call: (args) => request(fetchImpl, apiBase, '/api/ethere/v1/reminders', { method: 'POST', body: args }),
    },
    {
      name: 'ethere_reminder_update',
      description: '按 reminderId 和最新 baseRevision 修改待触发提醒。先用 reminders_list 获取当前版本；只传需要修改的字段。工具成功前不得声称已修改。',
      inputSchema: objectSchema({
        reminderId: { type: 'string', minLength: 1 },
        baseRevision: { type: 'integer', minimum: 1 },
        patch: objectSchema({
          title: { type: 'string', minLength: 1, maxLength: 120 }, message: { type: 'string', minLength: 1, maxLength: 2000 },
          triggerAt: { type: 'string' }, relatedTaskId: { type: 'string' }, relatedTaskTitle: { type: 'string', maxLength: 300 },
          dailyAt: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }, timezone: { type: 'string' },
          repeatMinutes: { type: 'integer', minimum: 0, maximum: 10080 },
        }, []),
      }, ['reminderId', 'baseRevision', 'patch']), annotations: { readOnlyHint: false, destructiveHint: false },
      call: (args) => request(fetchImpl, apiBase, `/api/ethere/v1/reminders/${encodeURIComponent(args.reminderId)}`, { method: 'PUT', body: { ...args.patch, baseRevision: args.baseRevision } }),
    },
    {
      name: 'ethere_reminder_cancel',
      description: '取消一个待触发提醒。先用 reminders_list 获取 reminderId 和最新 baseRevision；取消后不会再主动联系。',
      inputSchema: objectSchema({ reminderId: { type: 'string', minLength: 1 }, baseRevision: { type: 'integer', minimum: 1 } }, ['reminderId', 'baseRevision']),
      annotations: { readOnlyHint: false, destructiveHint: false },
      call: (args) => request(fetchImpl, apiBase, `/api/ethere/v1/reminders/${encodeURIComponent(args.reminderId)}/cancel`, { method: 'POST', body: { baseRevision: args.baseRevision } }),
    },
  ];
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
  if (!response.ok) throw toolError('REMINDER_REQUEST_FAILED', payload.error || '提醒任务操作失败');
  return payload;
}
function objectSchema(properties, required) { return { type: 'object', properties, required, additionalProperties: false }; }
function toolError(code, message) { const error = new Error(message); error.code = code; return error; }
