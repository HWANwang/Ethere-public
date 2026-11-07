import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEthereServer } from '../server/server.mjs';
import { DeviceActionService } from '../server/device-action-service.mjs';

test('device actions deliver to phone, reject duplicate popups, and resolve a choice', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ethere-device-api-'));
  const webRoot = join(root, 'web');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(webRoot));
  await writeFile(join(webRoot, 'index.html'), '<title>Ethere</title>');
  const actions = new DeviceActionService({ dataRoot: root });
  const notices = [];
  let assistantName = '助手';
  const configStore = { getSettings: async () => ({ bossName: assistantName }) };
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore: { append: async (event) => { notices.push(event); return event; } }, deviceActionService: actions, configStore });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1/device-actions`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const create = await post('/attention-popup', { message: '回来歇一下？', actions: [{ id: 'rest', label: '休息' }] });
  assert.equal(create.status, 201);
  const id = (await create.json()).action.id;
  assert.equal((await post('/attention-popup', { message: '叠加', actions: [{ id: 'ok', label: '好' }] })).status, 409);
  assert.equal((await (await fetch(`${base}/poll`)).json()).action.id, id);
  assert.equal((await post(`/${id}/ack`, { state: 'displaying' })).status, 200);
  assert.equal((await post(`/${id}/result`, { outcome: 'rest' })).status, 200);
  assert.equal((await actions.pendingResults())[0].outcome, 'rest');
  assert.equal(notices.filter((event) => event.id === `device-action-visible-${id}`).length, 1);
  assert.equal(notices.find((event) => event.id === `device-action-visible-${id}`).content, '助手 弹出了一条提示');
  const scheduledCall = await (await post('/incoming-call', { title: '旧标题', openingText: '早上好', triggerAt: new Date(Date.now() + 120_000).toISOString() })).json();
  assert.equal(scheduledCall.action.title, '助手');
  assert.equal(notices.find((event) => event.id === `device-action-created-${scheduledCall.action.id}`).content, '助手 预约了一通来电');
  const callId = '15a42df0-f59e-470c-98db-7531814ce001';
  const callEvent = (event, durationSeconds = 0) => fetch(`http://127.0.0.1:${server.address().port}/api/ethere/v1/chat/call-events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId, event, durationSeconds, text: '喂，用户，我在。' }),
  });
  assert.equal((await callEvent('started')).status, 201);
  assert.equal((await callEvent('opening')).status, 201);
  assert.equal((await callEvent('ended', 125)).status, 201);
  assert.deepEqual(notices.filter((event) => event.source === 'voice-call').map((event) => [event.role, event.content]),
    [['notice', '你给 助手 打了电话'], ['assistant', '喂，用户，我在。'], ['notice', '通话已挂断 · 02:05']]);
  assistantName = '少年';
  const renamedCall = await (await post('/incoming-call', { openingText: '我在。' })).json();
  assert.equal(renamedCall.action.title, '少年');
  assert.equal(notices.find((event) => event.id === `device-action-created-${renamedCall.action.id}`).content, '少年 正在给你打电话');
});

test('a linked call cancels the ordinary reminder only after the phone accepts it', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ethere-linked-call-api-'));
  const webRoot = join(root, 'web');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(webRoot));
  await writeFile(join(webRoot, 'index.html'), '<title>Ethere</title>');
  const actions = new DeviceActionService({ dataRoot: root });
  let reminder = { id: 'rem-1', status: 'scheduled' };
  const reminderService = { get: async (id) => id === reminder.id ? reminder : null, cancel: async () => { reminder = { ...reminder, status: 'cancelled' }; } };
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore: {}, deviceActionService: actions, reminderService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1/device-actions`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/incoming-call', { reminderId: 'missing' })).status, 404);
  const created = await (await post('/incoming-call', { reminderId: 'rem-1' })).json();
  assert.equal(reminder.status, 'scheduled');
  assert.equal((await post(`/${created.action.id}/ack`, { state: 'displaying' })).status, 200);
  assert.equal(reminder.status, 'cancelled');
  assert.equal((await post(`/${created.action.id}/cancel`, {})).status, 200);
  assert.equal((await (await fetch(`${base}/poll`)).json()).action.type, 'incoming_call_cancel');
});
