const SERVER_NAME = 'dida365';
const CLEAR_TASK_DATE = '1970-01-01T00:00:00.000+0000';
const ALLOWED_TOOLS = new Set(['list_projects', 'filter_tasks', 'get_task_by_id', 'create_task', 'update_task', 'complete_task']);

export class DidaService {
  constructor({ client, configStore, workspaceRoot }) {
    if (!client) throw new Error('缺少 Codex app-server 客户端');
    if (!configStore) throw new Error('缺少配置存储');
    this.client = client;
    this.configStore = configStore;
    this.workspaceRoot = workspaceRoot;
    this.threadId = '';
    this.readyPromise = null;
  }

  async status() {
    await this.#ensureThread();
    const result = await this.client.request('mcpServerStatus/list', {
      detail: 'toolsAndAuthOnly',
      threadId: this.threadId,
    });
    const server = result?.data?.find((item) => item.name === SERVER_NAME);
    const settings = await this.configStore.getSettings();
    return {
      connected: server?.authStatus === 'oAuth' && server?.runtimeStatus !== 'authenticationRequired' && !server?.toolsError,
      authStatus: server?.authStatus || 'unknown',
      runtimeStatus: server?.runtimeStatus || null,
      error: server?.toolsError || null,
      supervisedProjects: selectedProjects(settings),
    };
  }

  async startOAuthLogin() {
    await this.#ensureThread();
    const result = await this.client.request('mcpServer/oauth/login', {
      name: SERVER_NAME,
      threadId: this.threadId,
    });
    return { authorizationUrl: String(result?.authorizationUrl || '') };
  }

  async listProjects() {
    const payload = await this.#call('list_projects', {});
    const projects = findArray(payload, ['projects', 'data', 'items'])
      .map(normalizeProject)
      .filter((item) => item.id && item.name);
    return { projects };
  }

  async selectProjects({ projectIds = [] }) {
    const ids = [...new Set((Array.isArray(projectIds) ? projectIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) throw httpError(400, '请至少选择一个滴答清单');
    if (ids.length > 20) throw httpError(400, '监督清单最多选择 20 个');
    const { projects } = await this.listProjects();
    const byId = new Map(projects.map((project) => [project.id, project]));
    const selected = ids.map((id) => byId.get(id));
    if (selected.some((project) => !project)) throw httpError(404, '部分清单不存在，请重新加载');
    const settings = await this.configStore.updateSettings({
      dida: { projects: selected.map((project) => ({ id: project.id, name: project.name })) },
    });
    return { supervisedProjects: selectedProjects(settings) };
  }

  async listSupervisedTasks({ scope = 'all', keyword = '', limit = 50 } = {}) {
    const settings = await this.configStore.getSettings();
    const projects = selectedProjects(settings);
    const projectIds = projects.map((project) => project.id);
    if (!projectIds.length) throw httpError(409, '请先在设置中选择监督清单');
    const selectedIds = new Set(projectIds);
    const payload = await this.#call('filter_tasks', { filter: { projectIds, status: [0] } });
    const tasks = findArray(payload, ['tasks', 'data', 'items'])
      .map(normalizeTask)
      .filter((task) => task.id && selectedIds.has(task.projectId));
    const query = String(keyword || '').trim().toLocaleLowerCase('zh-CN');
    const today = beijingDate(new Date());
    const week = weekRange(today);
    const filtered = tasks.filter((task) => {
      if (query && !task.title.toLocaleLowerCase('zh-CN').includes(query)) return false;
      const dates = [task.startAt, task.dueAt].filter(Boolean).map(datePart);
      if (scope === 'today') return dates.includes(today) || dates.some((date) => date < today);
      if (scope === 'week') return dates.some((date) => date >= week.start && date <= week.end);
      if (scope === 'undated') return dates.length === 0;
      return true;
    });
    const safeLimit = Number.isInteger(Number(limit)) ? Math.max(1, Math.min(100, Number(limit))) : 50;
    return {
      projects,
      scope,
      keyword: query,
      count: filtered.length,
      truncated: filtered.length > safeLimit,
      tasks: filtered.slice(0, safeLimit),
    };
  }

  async getSupervisedTask(taskId) {
    const settings = await this.configStore.getSettings();
    const projects = selectedProjects(settings);
    const projectIds = new Set(projects.map((project) => project.id));
    if (!projectIds.size) throw httpError(409, '请先在设置中选择监督清单');
    const id = String(taskId || '').trim();
    if (!id) throw httpError(400, '缺少滴答任务 ID');
    const payload = await this.#call('get_task_by_id', { task_id: id });
    const raw = findTaskObject(payload, id);
    const task = normalizeTask(raw || {});
    if (!task.id) throw httpError(404, '滴答任务不存在');
    if (!projectIds.has(task.projectId)) throw httpError(403, '该任务不属于当前监督清单');
    return task;
  }

  async validateTaskChange(input = {}) {
    const operation = input.operation === 'create' ? 'create' : input.operation === 'update' ? 'update' : '';
    if (!operation) throw httpError(400, '任务操作无效');
    const reason = String(input.reason || '').trim().slice(0, 240);
    if (!reason) throw httpError(400, '请说明新建或修改任务的原因');
    if (operation === 'create') {
      const project = await this.#selectedProject(input.projectId);
      const task = normalizeTaskDraft(input, { requireTitle: true });
      if (task.repeatFlag && !task.startAt && !task.dueAt) throw httpError(400, '重复任务需要设置开始或截止日期');
      return { operation, projectId: project.id, projectName: project.name, ...task, reason };
    }
    const current = await this.getSupervisedTask(input.taskId);
    const patch = normalizeTaskDraft(input);
    if (!Object.keys(patch).length) throw httpError(400, '没有需要修改的任务字段');
    if ((patch.repeatFlag !== undefined || patch.startAt !== undefined || patch.dueAt !== undefined)
      && (patch.repeatFlag === undefined ? current.repeat : patch.repeatFlag)
      && !(patch.startAt === undefined ? current.startAt : patch.startAt)
      && !(patch.dueAt === undefined ? current.dueAt : patch.dueAt)) throw httpError(400, '重复任务需要保留开始或截止日期');
    return {
      operation, taskId: current.id, taskTitle: current.title, projectId: current.projectId,
      projectName: (await this.#selectedProject(current.projectId)).name, ...patch, reason,
    };
  }

  async createTask(input = {}) {
    const proposal = await this.validateTaskChange({ ...input, operation: 'create', reason: input.reason || '已审批' });
    const payload = await this.#call('create_task', {
      task: didaTaskPayload(proposal), client_timezone: 'Asia/Shanghai',
    });
    return normalizeTask(findFirstTask(payload) || {});
  }

  async updateTask(taskId, input = {}) {
    const proposal = await this.validateTaskChange({ ...input, operation: 'update', taskId, reason: input.reason || '已审批' });
    const payload = await this.#call('update_task', {
      task_id: proposal.taskId,
      task: { id: proposal.taskId, projectId: proposal.projectId, title: proposal.title || proposal.taskTitle, ...didaTaskPayload(proposal, { includeProject: false }) },
      client_timezone: 'Asia/Shanghai',
    });
    return normalizeTask(findFirstTask(payload) || { id: proposal.taskId, projectId: proposal.projectId, ...didaTaskPayload(proposal, { includeProject: false }) });
  }

  async completeTask(taskId) {
    const task = await this.getSupervisedTask(taskId);
    if (task.status === 2) return { ...task, alreadyCompleted: true };
    await this.#call('complete_task', { project_id: task.projectId, task_id: task.id });
    return { ...task, status: 2, completedAt: new Date().toISOString() };
  }

  async #selectedProject(projectId) {
    const id = String(projectId || '').trim();
    const settings = await this.configStore.getSettings();
    const project = selectedProjects(settings).find((item) => item.id === id);
    if (!project) throw httpError(403, '只能写入当前选中的监督清单');
    return project;
  }

  async #call(tool, args) {
    if (!ALLOWED_TOOLS.has(tool)) throw new Error(`滴答工具未获准：${tool}`);
    await this.#ensureThread();
    const result = await this.client.request('mcpServer/tool/call', {
      threadId: this.threadId,
      server: SERVER_NAME,
      tool,
      arguments: args,
    });
    if (result?.isError) throw httpError(502, toolErrorText(result) || '滴答清单查询失败');
    return extractPayload(result);
  }

  async #ensureThread() {
    if (this.threadId) return this.threadId;
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        await this.client.initialize();
        const result = await this.client.request('thread/start', {
          cwd: this.workspaceRoot,
          ephemeral: true,
          sandbox: 'read-only',
          baseInstructions: 'This thread exists only for direct bounded Dida MCP calls. Do not run model turns.',
        });
        this.threadId = result?.thread?.id || result?.threadId || '';
        if (!this.threadId) throw new Error('无法初始化滴答连接线程');
        return this.threadId;
      })().finally(() => { this.readyPromise = null; });
    }
    return this.readyPromise;
  }
}

function extractPayload(result) {
  if (result?.structuredContent != null) return result.structuredContent;
  const texts = Array.isArray(result?.content)
    ? result.content.filter((item) => item?.type === 'text').map((item) => item.text)
    : [];
  for (const text of texts) {
    try { return JSON.parse(text); } catch { /* try the next text block */ }
  }
  return texts.length === 1 ? texts[0] : texts;
}

function findArray(value, preferredKeys) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of preferredKeys) if (Array.isArray(value[key])) return value[key];
  for (const child of Object.values(value)) {
    const found = findArray(child, preferredKeys);
    if (found.length) return found;
  }
  return [];
}

function findTaskObject(value, expectedId) {
  if (!value || typeof value !== 'object') return null;
  if (!Array.isArray(value)) {
    const id = String(value.id || value.taskId || '');
    if (id === expectedId && (value.projectId || value.title !== undefined)) return value;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findTaskObject(child, expectedId);
    if (found) return found;
  }
  return null;
}

function findFirstTask(value) {
  if (!value || typeof value !== 'object') return null;
  if (!Array.isArray(value) && (value.id || value.taskId) && (value.projectId || value.title !== undefined)) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findFirstTask(child);
    if (found) return found;
  }
  return null;
}

function normalizeProject(value = {}) {
  return {
    id: String(value.id || value.projectId || ''),
    name: String(value.name || value.title || ''),
    kind: String(value.kind || value.type || ''),
  };
}

function selectedProjects(settings) {
  return Array.isArray(settings?.dida?.projects)
    ? settings.dida.projects.map((project) => ({ id: String(project?.id || ''), name: String(project?.name || '') })).filter((project) => project.id)
    : [];
}

function normalizeTask(value = {}) {
  return {
    id: String(value.id || value.taskId || ''),
    title: String(value.title || '').trim(),
    projectId: String(value.projectId || ''),
    priority: Number(value.priority || 0),
    status: Number(value.status || 0),
    startAt: normalizeTaskDate(value.startDate ?? value.startAt),
    dueAt: normalizeTaskDate(value.dueDate ?? value.dueAt),
    isAllDay: value.isAllDay === true,
    completedAt: value.completedTime || value.completedAt || null,
    repeat: value.repeatFlag || null,
    tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
  };
}

function normalizeTaskDraft(value = {}, { requireTitle = false } = {}) {
  const result = {};
  if (value.title !== undefined) {
    const title = String(value.title || '').trim().slice(0, 300);
    if (!title) throw httpError(400, '任务标题不能为空');
    result.title = title;
  } else if (requireTitle) throw httpError(400, '任务标题不能为空');
  if (value.content !== undefined) result.content = String(value.content || '').trim().slice(0, 8_000);
  for (const [source, target] of [['startAt', 'startAt'], ['dueAt', 'dueAt']]) {
    if (value[source] === undefined) continue;
    if (isClearTaskDate(value[source])) { result[target] = null; continue; }
    const date = new Date(value[source]);
    if (Number.isNaN(date.getTime())) throw httpError(400, `${source === 'startAt' ? '开始' : '截止'}时间无效`);
    result[target] = date.toISOString();
  }
  if (value.isAllDay !== undefined) result.isAllDay = value.isAllDay === true;
  if (value.priority !== undefined) {
    const priority = Number(value.priority);
    if (![0, 1, 3, 5].includes(priority)) throw httpError(400, '任务优先级无效');
    result.priority = priority;
  }
  if (value.repeatFlag !== undefined) result.repeatFlag = normalizeRepeatFlag(value.repeatFlag);
  return result;
}

function didaTaskPayload(value, { includeProject = true } = {}) {
  return {
    ...(includeProject ? { projectId: value.projectId } : {}),
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.content !== undefined ? { content: value.content } : {}),
    ...(value.startAt !== undefined ? { startDate: value.startAt === null ? CLEAR_TASK_DATE : value.startAt } : {}),
    ...(value.dueAt !== undefined ? { dueDate: value.dueAt === null ? CLEAR_TASK_DATE : value.dueAt } : {}),
    ...(value.isAllDay !== undefined ? { isAllDay: value.isAllDay } : {}),
    ...(value.priority !== undefined ? { priority: value.priority } : {}),
    ...(value.repeatFlag !== undefined ? { repeatFlag: value.repeatFlag === null ? '' : value.repeatFlag } : {}),
    timeZone: 'Asia/Shanghai',
    kind: 'TEXT',
  };
}

function normalizeRepeatFlag(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 160) throw httpError(400, '任务重复周期格式无效');
  const flag = value.trim();
  const daily = /^RRULE:FREQ=DAILY;INTERVAL=([1-9]\d{0,2})$/u.exec(flag);
  const weekly = /^RRULE:FREQ=WEEKLY;INTERVAL=([1-9]\d{0,2});BYDAY=(MO|TU|WE|TH|FR|SA|SU)(?:,(?:MO|TU|WE|TH|FR|SA|SU))*$/u.exec(flag);
  const monthly = /^RRULE:FREQ=MONTHLY;INTERVAL=([1-9]\d{0,2});BYMONTHDAY=(-1|[1-9]|[12]\d|3[01])$/u.exec(flag);
  const yearly = /^RRULE:FREQ=YEARLY;INTERVAL=([1-9]\d{0,2});BYMONTH=([1-9]|1[0-2]);BYMONTHDAY=([1-9]|[12]\d|3[01])$/u.exec(flag);
  const match = daily || weekly || monthly || yearly;
  const interval = Number(match?.[1]);
  const max = daily ? 365 : weekly ? 52 : monthly ? 24 : 10;
  if (!match || interval > max || weekly && new Set(flag.split('BYDAY=')[1].split(',')).size !== flag.split('BYDAY=')[1].split(',').length) {
    throw httpError(400, '任务重复周期仅支持每天、指定星期、每月指定日期或每年指定日期；请检查 RRULE');
  }
  return flag;
}

function normalizeTaskDate(value) {
  return !value || isClearTaskDate(value) ? null : value;
}

function isClearTaskDate(value) {
  return value === null || (typeof value === 'string' && /^1970-01-01T/.test(value) && Date.parse(value) === 0);
}

function toolErrorText(result) {
  return Array.isArray(result?.content) ? result.content.map((item) => item?.text || '').filter(Boolean).join('\n') : '';
}

function datePart(value) {
  const match = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] || '';
}

function beijingDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function weekRange(isoDate) {
  const [year, month, dayOfMonth] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, dayOfMonth));
  const day = (date.getUTCDay() + 6) % 7;
  const start = new Date(date.getTime() - day * 86_400_000);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
