import assert from 'node:assert/strict';
import test from 'node:test';
import { DidaService } from '../server/dida-service.mjs';

function createFixture() {
  let settings = { dida: { projects: [] } };
  const calls = [];
  const client = {
    async initialize() {},
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'thread/start') return { thread: { id: 'dida-thread' } };
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'dida365', authStatus: 'oAuth', runtimeStatus: 'connected', toolsError: null }] };
      if (method === 'mcpServer/oauth/login') return { authorizationUrl: 'https://example.test/oauth' };
      if (params.tool === 'list_projects') return { content: [{ type: 'text', text: JSON.stringify({ projects: [{ id: 'p1', name: '⏰监督清单' }, { id: 'p2', name: '其他' }] }) }] };
      if (params.tool === 'filter_tasks') return { structuredContent: { tasks: [
        { id: 't1', title: '今日示例任务', projectId: 'p1', startDate: '2026-10-29T23:59:00+0800', dueDate: '2026-10-29T23:59:00+0800', isAllDay: true, status: 0 },
        { id: 't2', title: '长期示例任务', projectId: 'p1', status: 0 },
        { id: 'wrong', title: '不应出现', projectId: 'p2', status: 0 },
      ] } };
      if (params.tool === 'get_task_by_id') return { structuredContent: { task: { id: params.arguments.task_id, title: '示例任务', projectId: 'p1', status: params.arguments.task_id === 'done' ? 2 : 0, completedTime: params.arguments.task_id === 'done' ? '2026-10-29T12:00:00+08:00' : null } } };
      if (params.tool === 'create_task') return { structuredContent: { task: { id: 'created', ...params.arguments.task, status: 0 } } };
      if (params.tool === 'update_task') return { structuredContent: { task: { id: params.arguments.task_id, projectId: 'p1', ...params.arguments.task, status: 0 } } };
      if (params.tool === 'complete_task') return { structuredContent: { success: true } };
      throw new Error(`unexpected request ${method}`);
    },
  };
  const configStore = {
    async getSettings() { return structuredClone(settings); },
    async updateSettings(patch) { settings = { ...settings, ...patch, dida: { ...settings.dida, ...patch.dida } }; return structuredClone(settings); },
  };
  return { service: new DidaService({ client, configStore, workspaceRoot: 'C:\\EthereData' }), calls };
}

test('dida settings list and persist multiple stable project ids', async () => {
  const { service } = createFixture();
  assert.deepEqual((await service.listProjects()).projects.map((item) => item.name), ['⏰监督清单', '其他']);
  const result = await service.selectProjects({ projectIds: ['p1', 'p2'] });
  assert.deepEqual(result.supervisedProjects, [{ id: 'p1', name: '⏰监督清单' }, { id: 'p2', name: '其他' }]);
  assert.deepEqual((await service.status()).supervisedProjects.map((item) => item.name), ['⏰监督清单', '其他']);
});

test('supervised task queries enforce all configured projects and support keyword in one tool', async () => {
  const { service, calls } = createFixture();
  await service.selectProjects({ projectIds: ['p1', 'p2'] });
  const all = await service.listSupervisedTasks({ scope: 'all' });
  assert.equal(all.count, 3);
  assert.deepEqual(all.tasks.map((task) => task.projectId).sort(), ['p1', 'p1', 'p2']);
  const matched = await service.listSupervisedTasks({ scope: 'all', keyword: '长期' });
  assert.deepEqual(matched.tasks.map((task) => task.id), ['t2']);
  const filterCall = calls.find(([method, params]) => method === 'mcpServer/tool/call' && params.tool === 'filter_tasks');
  assert.deepEqual(filterCall[1].arguments.filter.projectIds, ['p1', 'p2']);
});

test('dida OAuth login is delegated to app-server without exposing credentials', async () => {
  const { service } = createFixture();
  assert.deepEqual(await service.startOAuthLogin(), { authorizationUrl: 'https://example.test/oauth' });
});

test('linked reminder checks can only read a task from the selected project', async () => {
  const { service } = createFixture();
  await service.selectProjects({ projectIds: ['p1'] });
  const task = await service.getSupervisedTask('t1');
  assert.equal(task.status, 0);
  assert.equal(task.completedAt, null);
});

test('all-day flag survives supervised task normalization', async () => {
  const { service } = createFixture();
  await service.selectProjects({ projectIds: ['p1'] });
  const result = await service.listSupervisedTasks({ scope: 'all' });
  const task = result.tasks.find((item) => item.id === 't1');
  assert.equal(task.isAllDay, true);
  assert.match(task.dueAt, /23:59/);
});

test('date clearing is accepted and forwarded with Dida MCP sentinel', async () => {
  const { service, calls } = createFixture();
  await service.selectProjects({ projectIds: ['p1'] });
  const proposal = await service.validateTaskChange({ operation: 'update', taskId: 't1', startAt: null, dueAt: null, reason: '取消安排日期' });
  assert.equal(proposal.startAt, null);
  assert.equal(proposal.dueAt, null);
  const updated = await service.updateTask('t1', proposal);
  assert.equal(updated.startAt, null);
  assert.equal(updated.dueAt, null);
  const call = calls.find(([, params]) => params.tool === 'update_task');
  assert.equal(call[1].arguments.task.startDate, '1970-01-01T00:00:00.000+0000');
  assert.equal(call[1].arguments.task.dueDate, '1970-01-01T00:00:00.000+0000');
});

test('a model-provided 1970 sentinel is treated as clearing before approval', async () => {
  const { service } = createFixture();
  await service.selectProjects({ projectIds: ['p1'] });
  const proposal = await service.validateTaskChange({
    operation: 'update', taskId: 't1', startAt: '1970-01-01T00:00:00.000+0000',
    dueAt: '1970-01-01T00:00:00.000Z', reason: '取消安排日期',
  });
  assert.equal(proposal.startAt, null);
  assert.equal(proposal.dueAt, null);
});

test('Dida writes stay inside selected projects and create or update only after validation', async () => {
  const { service, calls } = createFixture();
  await service.selectProjects({ projectIds: ['p1'] });
  const proposal = await service.validateTaskChange({ operation: 'create', projectId: 'p1', title: '写测试', dueAt: '2026-10-30T18:00:00+08:00', reason: '用户请求' });
  assert.equal(proposal.projectName, '⏰监督清单');
  const created = await service.createTask(proposal);
  assert.equal(created.id, 'created');
  const updated = await service.updateTask('t1', { title: '写完测试', reason: '收紧任务' });
  assert.equal(updated.title, '写完测试');
  await assert.rejects(() => service.validateTaskChange({ operation: 'create', projectId: 'p2', title: '越界', reason: '测试' }), /只能写入当前选中/);
  assert.ok(calls.some(([, params]) => params.tool === 'create_task'));
  assert.ok(calls.some(([, params]) => params.tool === 'update_task'));
});

test('Dida recurring task rules survive proposal validation and approved writes', async () => {
  const { service, calls } = createFixture();
  await service.selectProjects({ projectIds: ['p1'] });
  const weekly = 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TH';
  const proposal = await service.validateTaskChange({ operation: 'create', projectId: 'p1', title: '陶艺练习', dueAt: '2026-11-02T20:00:00+08:00', repeatFlag: weekly, reason: '每周练习' });
  assert.equal(proposal.repeatFlag, weekly);
  assert.equal((await service.createTask(proposal)).repeat, weekly);
  const created = calls.find(([, params]) => params.tool === 'create_task');
  assert.equal(created[1].arguments.task.repeatFlag, weekly);

  const monthly = 'RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15';
  const changed = await service.validateTaskChange({ operation: 'update', taskId: 't1', dueAt: '2026-11-15T20:00:00+08:00', repeatFlag: monthly, reason: '每月检查' });
  await service.updateTask('t1', changed);
  const updated = calls.find(([, params]) => params.tool === 'update_task');
  assert.equal(updated[1].arguments.task.repeatFlag, monthly);
  await service.updateTask('t1', { repeatFlag: null, reason: '不再重复' });
  assert.equal(calls.filter(([, params]) => params.tool === 'update_task').at(-1)[1].arguments.task.repeatFlag, '');
});

test('Dida rejects unsupported or dateless recurrence before approval', async () => {
  const { service } = createFixture();
  await service.selectProjects({ projectIds: ['p1'] });
  await assert.rejects(() => service.validateTaskChange({ operation: 'create', projectId: 'p1', title: '陶艺练习', repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1', reason: '每天练习' }), /需要设置开始或截止日期/);
  await assert.rejects(() => service.validateTaskChange({ operation: 'create', projectId: 'p1', title: '陶艺练习', dueAt: '2026-11-02T20:00:00+08:00', repeatFlag: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,MO', reason: '每周练习' }), /重复周期仅支持/);
  await assert.rejects(() => service.validateTaskChange({ operation: 'create', projectId: 'p1', title: '陶艺练习', dueAt: '2026-11-02T20:00:00+08:00', repeatFlag: 'RRULE:FREQ=HOURLY;INTERVAL=1', reason: '每小时练习' }), /重复周期仅支持/);
});

test('completing a supervised task is direct and idempotent for an already completed task', async () => {
  const { service, calls } = createFixture();
  await service.selectProjects({ projectIds: ['p1'] });
  assert.equal((await service.completeTask('t1')).status, 2);
  assert.equal((await service.completeTask('done')).alreadyCompleted, true);
  assert.equal(calls.filter(([, params]) => params.tool === 'complete_task').length, 1);
});
