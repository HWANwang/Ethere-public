import assert from 'node:assert/strict';
import test from 'node:test';
import { createReminderMcpTools } from '../server/reminder-mcp-tools.mjs';

test('reminder MCP exposes list, create, update, and cancel through bounded Ethere endpoints', async () => {
  const requests = [];
  const tools = createReminderMcpTools({ apiBase: 'http://ethere.test', async fetchImpl(url, options) {
    requests.push({ url: String(url), options });
    return { ok: true, async json() { return { reminder: { id: 'r1', revision: 1 } }; } };
  } });
  assert.deepEqual(tools.list().map((item) => item.name), ['ethere_reminders_list', 'ethere_reminder_create', 'ethere_reminder_update', 'ethere_reminder_cancel']);
  const createDescription = tools.list().find((item) => item.name === 'ethere_reminder_create').description;
  assert.match(createDescription, /dailyAt/);
  assert.doesNotMatch(createDescription, /repeatMinutes=1440/);
  assert.doesNotMatch(createDescription, /Operation 行为偏好/);
  await tools.call('ethere_reminder_create', { title: '示例', message: '测试', triggerAt: '2026-10-29T12:00:00+08:00' });
  await tools.call('ethere_reminder_update', { reminderId: 'r1', baseRevision: 1, patch: { repeatMinutes: 30 } });
  await tools.call('ethere_reminder_cancel', { reminderId: 'r1', baseRevision: 2 });
  assert.equal(requests[0].options.method, 'POST');
  assert.match(requests[1].url, /reminders\/r1$/);
  assert.match(requests[2].url, /reminders\/r1\/cancel$/);
});

test('reminder MCP accepts a fixed daily calendar schedule', async () => {
  let body = null;
  const tools = createReminderMcpTools({ apiBase: 'http://ethere.test', async fetchImpl(_url, options) {
    body = JSON.parse(options.body);
    return { ok: true, async json() { return { reminder: { id: 'daily-1' } }; } };
  } });
  const schema = tools.list().find((item) => item.name === 'ethere_reminder_create').inputSchema;
  assert.deepEqual(schema.oneOf, [{ required: ['triggerAt'] }, { required: ['dailyAt'] }]);
  await tools.call('ethere_reminder_create', { title: '整理时间线', message: '整理今天的时间线', dailyAt: '20:30', timezone: 'Asia/Shanghai' });
  assert.equal(body.dailyAt, '20:30');
});
