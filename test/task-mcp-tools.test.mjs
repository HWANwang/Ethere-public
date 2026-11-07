import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskMcpTools } from '../server/task-mcp-tools.mjs';

test('task MCP reads supervised tasks, proposes writes, and completes explicit finished work', async () => {
  const requests = [];
  const tools = createTaskMcpTools({
    apiBase: 'http://ethere.test',
    async fetchImpl(url, options = {}) {
      requests.push({ url: String(url), options });
      return { ok: true, async json() { return { count: 1, tasks: [{ id: 't1', title: '示例任务' }] }; } };
    },
  });
  assert.deepEqual(tools.list().map((item) => item.name), ['ethere_supervised_tasks_get', 'ethere_task_change_propose', 'ethere_task_with_reminder_propose', 'ethere_task_complete']);
  const result = await tools.call('ethere_supervised_tasks_get', { scope: 'today', keyword: '示例', limit: 10 });
  assert.equal(result.count, 1);
  await tools.call('ethere_task_change_propose', { operation: 'create', projectId: 'p1', title: '写测试', reason: '用户请求加入待办' });
  await tools.call('ethere_task_with_reminder_propose', { task: { projectId: 'p1', title: '写测试' }, reminder: { message: '问问进度', triggerAt: '2099-10-29T12:00:00+08:00' }, reason: '同步监督' });
  await tools.call('ethere_task_complete', { taskId: 't1', taskTitle: '示例任务' });
  assert.match(requests[0].url, /scope=today/);
  assert.match(requests[0].url, /keyword=%E7%A4%BA%E4%BE%8B/);
  assert.match(requests[1].url, /tasks\/change-proposal$/);
  assert.equal(requests[1].options.method, 'POST');
  assert.match(requests[2].url, /tasks\/with-reminder-proposal$/);
  const comboSchema = tools.list()[2].inputSchema.properties.reminder;
  assert.deepEqual(comboSchema.required, ['message', 'triggerAt']);
  assert.equal(Object.hasOwn(comboSchema.properties, 'title'), false);
  assert.match(requests[3].url, /tasks\/t1\/complete$/);
  assert.match(tools.list()[3].description, /仅当用户明确表示该任务已经完成/);
  assert.ok(Object.hasOwn(tools.list()[1].inputSchema.properties, 'repeatFlag'));
  assert.ok(Object.hasOwn(tools.list()[2].inputSchema.properties.task.properties, 'repeatFlag'));
});
