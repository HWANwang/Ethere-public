export function createDeviceActionMcpTools({ apiBase = process.env.ETHERE_API_BASE || 'http://127.0.0.1:4173', fetchImpl = fetch } = {}) {
  const tools = [
    {
      name: 'show_attention_popup',
      description: '在用户手机的其他 App 上方显示一张轻量监督弹窗。仅在需要即时、可操作的提醒时调用；正文和 1～4 个按钮文字由你填写。工具只确认投递请求，用户稍后点击按钮或关闭会作为独立内部事件返回；不要假装用户已经选择。已有弹窗时会明确拒绝。没有悬浮窗权限或手机离线时可能失败。',
      inputSchema: objectSchema({
        message: { type: 'string', minLength: 1, maxLength: 500 },
        actions: { type: 'array', minItems: 1, maxItems: 4, items: objectSchema({ id: { type: 'string', minLength: 1, maxLength: 40 }, label: { type: 'string', minLength: 1, maxLength: 20 } }, ['id', 'label']) },
      }, ['message', 'actions']),
      annotations: { readOnlyHint: false, destructiveHint: false },
      path: '/device-actions/attention-popup',
    },
    {
      name: 'ethere_incoming_call',
      description: '向用户手机发起来电式提醒。来电姓名自动使用设置中的助手名称，不需要填写标题。调用时一并写好接通后你要亲口说的第一段话 openingText，手机接听后直接合成播放、允许用户插话打断，不再等待第二次模型回复。你可立即发起（省略 triggerAt）或预约未来时间；可选关联已有 reminderId。不要把普通提醒一律变成来电。snoozeMinutes 默认 10。工具成功仅表示已提交给手机，不能据此声称已响铃或接听。',
      inputSchema: objectSchema({
        openingText: { type: 'string', minLength: 1, maxLength: 1600, description: '用户接通后你要说的第一段话，按当时上下文自然表达；写成可直接朗读的正文，不写操作说明。' },
        triggerAt: { type: 'string', description: '可选，含时区 ISO 8601；省略为立即来电。' },
        snoozeMinutes: { type: 'integer', minimum: 1, maximum: 1440, description: '可选；用户点稍后提醒后的延后分钟数，默认 10。' },
        reminderId: { type: 'string', description: '可选，已存在提醒的稳定 ID。' },
      }, ['openingText']),
      annotations: { readOnlyHint: false, destructiveHint: false },
      path: '/device-actions/incoming-call',
    },
  ];
  return {
    list: () => tools.map(({ path, ...schema }) => schema),
    async call(name, args = {}) {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw Object.assign(new Error(`未知工具：${name}`), { code: 'UNKNOWN_TOOL' });
      const response = await fetchImpl(`${apiBase}/api/ethere/v1${tool.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(payload.error || '手机动作请求失败'), { code: response.status === 409 ? 'CONFLICT' : 'DEVICE_ACTION_FAILED' });
      return { taskId: payload.action.id, status: payload.action.state, type: payload.action.type, triggerAt: payload.action.triggerAt || null };
    },
  };
}

function objectSchema(properties, required) { return { type: 'object', properties, required, additionalProperties: false }; }
