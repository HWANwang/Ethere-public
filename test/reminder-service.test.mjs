import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReminderStore } from '../server/reminder-store.mjs';
import { ReminderService } from '../server/reminder-service.mjs';

test('a linked incomplete task sends a proactive reminder and schedules another check', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-reminder-service-test-'));
  const now = () => new Date('2026-10-29T04:00:00.000Z');
  const store = new ReminderStore({ dataRoot, now });
  let timerCallback = null;
  const events = [];
  const service = new ReminderService({
    reminderStore: store, now,
    didaService: { async getSupervisedTask() { return { id: 'task-1', title: '示例任务', status: 0, completedAt: null }; } },
    chatService: { isBusy: () => false, async sendMessage({ text }) { assert.match(text, /仍未完成/); return { text: '该开始啦。', status: 'completed' }; } },
    chatEventStore: { async append(event) { events.push(event); } },
    setTimer(callback) { timerCallback = callback; return { unref() {} }; }, clearTimer() {},
  });
  await service.start();
  const reminder = await service.create({ message: '问问我开始了没有', triggerAt: '2026-10-29T11:59:00+08:00', repeatMinutes: 30, relatedTaskId: 'task-1', relatedTaskTitle: '示例任务' });
  await timerCallback();
  await new Promise((resolve) => setImmediate(resolve));
  const current = await store.get(reminder.id);
  assert.equal(current.status, 'scheduled');
  assert.equal(current.triggerAt, '2026-10-29T04:30:00.000Z');
  assert.equal(events[0].source, 'reminder');
  service.stop();
});

test('a completed linked task cancels related reminders and allows silent model feedback', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-reminder-service-test-'));
  const now = () => new Date('2026-10-29T04:00:00.000Z');
  const store = new ReminderStore({ dataRoot, now });
  let timerCallback = null;
  const service = new ReminderService({
    reminderStore: store, now,
    didaService: { async getSupervisedTask() { return { id: 'task-1', title: '示例任务', status: 2, completedAt: '2026-10-29T11:50:00+08:00' }; } },
    chatService: { isBusy: () => false, async sendMessage({ text }) { assert.match(text, /已在滴答完成/); return { text: 'ETHERE_SILENT', status: 'completed' }; } },
    chatEventStore: { async append() {} }, setTimer(callback) { timerCallback = callback; return { unref() {} }; }, clearTimer() {},
  });
  await service.start();
  const reminder = await service.create({ message: '检查任务', triggerAt: '2026-10-29T11:59:00+08:00', repeatMinutes: 30, relatedTaskId: 'task-1' });
  await timerCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await store.get(reminder.id)).status, 'cancelled');
  service.stop();
});

test('a linked task completed in Dida is checked one minute before its reminder and cancelled', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-reminder-preflight-test-'));
  let clock = new Date('2026-10-29T03:00:00.000Z');
  const store = new ReminderStore({ dataRoot, now: () => clock });
  let timerCallback = null;
  let timerDelay = null;
  const events = [];
  let completed = false;
  const service = new ReminderService({
    reminderStore: store, now: () => clock,
    didaService: { async getSupervisedTask() { return { id: 'task-1', title: '示例任务', status: completed ? 2 : 0 }; } },
    chatService: { isBusy: () => false, async sendMessage({ text }) { assert.match(text, /已在滴答完成/); return { text: '做完啦！', status: 'completed' }; } },
    chatEventStore: { async append(event) { events.push(event); } },
    setTimer(callback, delay) { timerCallback = callback; timerDelay = delay; return { unref() {} }; }, clearTimer() {},
  });
  await service.start();
  const reminder = await service.create({ message: '检查任务', triggerAt: '2026-10-29T03:10:00.000Z', relatedTaskId: 'task-1' });
  assert.equal(timerDelay, 9 * 60_000);
  completed = true;
  clock = new Date('2026-10-29T03:09:00.000Z');
  await timerCallback();
  assert.equal((await store.get(reminder.id)).status, 'cancelled');
  assert.equal(events.length, 1);
  assert.equal(events[0].content, '做完啦！');
  service.stop();
});

test('model task completion cancels every linked reminder immediately without extra model call', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-reminder-complete-test-'));
  const store = new ReminderStore({ dataRoot });
  const service = new ReminderService({
    reminderStore: store,
    didaService: { async getSupervisedTask() { return { id: 'task-1', status: 0 }; } },
    chatService: { isBusy: () => false, async sendMessage() { throw new Error('Unexpected model call'); } },
    chatEventStore: { async append() {} },
  });
  await service.start();
  const first = await service.create({ message: '检查一', triggerAt: '2099-10-29T03:10:00.000Z', relatedTaskId: 'task-1' });
  const second = await service.create({ message: '检查二', triggerAt: '2099-10-29T03:20:00.000Z', relatedTaskId: 'task-1' });
  assert.equal(await service.cancelRelatedTask('task-1'), 2);
  assert.equal((await store.get(first.id)).status, 'cancelled');
  assert.equal((await store.get(second.id)).status, 'cancelled');
  service.stop();
});

test('a daily reminder runs once and schedules the next fixed local occurrence', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-reminder-service-daily-test-'));
  let clock = new Date('2026-10-29T12:29:00.000Z');
  const store = new ReminderStore({ dataRoot, now: () => clock });
  let timerCallback = null;
  let sent = 0;
  const service = new ReminderService({
    reminderStore: store, now: () => clock, didaService: null,
    chatService: { isBusy: () => false, async sendMessage() { sent += 1; return { text: '来整理时间线吧。', status: 'completed' }; } },
    chatEventStore: { async append() {} }, setTimer(callback) { timerCallback = callback; return { unref() {} }; }, clearTimer() {},
  });
  await service.start();
  const reminder = await service.create({ message: '整理今天的时间线', dailyAt: '20:30', timezone: 'Asia/Shanghai' });
  clock = new Date('2026-10-29T12:30:00.000Z');
  await timerCallback();
  await new Promise((resolve) => setImmediate(resolve));
  const current = await store.get(reminder.id);
  assert.equal(sent, 1);
  assert.equal(current.status, 'scheduled');
  assert.equal(current.lastSuccessDate, '2026-10-29');
  assert.equal(current.triggerAt, '2026-10-30T12:30:00.000Z');
  service.stop();
});

test('a silent one-time reminder completes without a chat event', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-reminder-silent-test-'));
  const now = () => new Date('2026-10-29T04:00:00.000Z');
  const store = new ReminderStore({ dataRoot, now });
  let timerCallback;
  const events = [];
  const service = new ReminderService({
    reminderStore: store, now,
    chatService: { isBusy: () => false, async sendMessage({ text }) {
      assert.match(text, /ETHERE_SILENT/);
      return { text: 'ETHERE_SILENT', status: 'completed' };
    } },
    chatEventStore: { async append(event) { events.push(event); } },
    setTimer(callback) { timerCallback = callback; return { unref() {} }; }, clearTimer() {},
  });
  await service.start();
  const reminder = await service.create({ message: '看看是否需要联系', triggerAt: now().toISOString() });
  await timerCallback();
  assert.equal((await store.get(reminder.id)).status, 'completed');
  assert.equal(events.length, 0);
  service.stop();
});

test('a silent repeated reminder keeps its next check unless the model changes it', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-reminder-silent-repeat-test-'));
  const now = () => new Date('2026-10-29T04:00:00.000Z');
  const store = new ReminderStore({ dataRoot, now });
  let timerCallback;
  const service = new ReminderService({
    reminderStore: store, now,
    chatService: { isBusy: () => false, async sendMessage() { return { text: 'ETHERE_SILENT', status: 'completed' }; } },
    chatEventStore: { async append() { throw new Error('静默不应写入聊天'); } },
    setTimer(callback) { timerCallback = callback; return { unref() {} }; }, clearTimer() {},
  });
  await service.start();
  const reminder = await service.create({ message: '回访进度', triggerAt: now().toISOString(), repeatMinutes: 30 });
  await timerCallback();
  const current = await store.get(reminder.id);
  assert.equal(current.status, 'scheduled');
  assert.equal(current.triggerAt, '2026-10-29T04:30:00.000Z');
  service.stop();
});

test('a silent daily reminder remains scheduled for the next local day', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-reminder-silent-daily-test-'));
  let clock = new Date('2026-10-29T12:29:00.000Z');
  const store = new ReminderStore({ dataRoot, now: () => clock });
  let timerCallback;
  const service = new ReminderService({
    reminderStore: store, now: () => clock,
    chatService: { isBusy: () => false, async sendMessage() { return { text: 'ETHERE_SILENT', status: 'completed' }; } },
    chatEventStore: { async append() { throw new Error('静默不应写入聊天'); } },
    setTimer(callback) { timerCallback = callback; return { unref() {} }; }, clearTimer() {},
  });
  await service.start();
  const reminder = await service.create({ message: '整理时间线', dailyAt: '20:30', timezone: 'Asia/Shanghai' });
  clock = new Date('2026-10-29T12:30:00.000Z');
  await timerCallback();
  const current = await store.get(reminder.id);
  assert.equal(current.status, 'scheduled');
  assert.equal(current.lastSuccessDate, '2026-10-29');
  assert.equal(current.triggerAt, '2026-10-30T12:30:00.000Z');
  service.stop();
});

test('model changes to a due reminder are not overwritten by the old schedule', async () => {
  for (const operation of ['update', 'cancel']) {
    const dataRoot = await mkdtemp(join(tmpdir(), `ethere-reminder-model-${operation}-test-`));
    const now = () => new Date('2026-10-29T04:00:00.000Z');
    const store = new ReminderStore({ dataRoot, now });
    let timerCallback;
    let reminder;
    const service = new ReminderService({
      reminderStore: store, now,
      chatService: { isBusy: () => false, async sendMessage() {
        if (operation === 'update') await service.update(reminder.id, { triggerAt: '2026-10-29T05:00:00.000Z', repeatMinutes: 60 }, { baseRevision: reminder.revision });
        else await service.cancel(reminder.id, { baseRevision: reminder.revision });
        return { text: 'ETHERE_SILENT', status: 'completed' };
      } },
      chatEventStore: { async append() { throw new Error('静默不应写入聊天'); } },
      setTimer(callback) { timerCallback = callback; return { unref() {} }; }, clearTimer() {},
    });
    await service.start();
    reminder = await service.create({ message: '回访进度', triggerAt: now().toISOString(), repeatMinutes: 30 });
    await timerCallback();
    const current = await store.get(reminder.id);
    assert.equal(current.status, operation === 'update' ? 'scheduled' : 'cancelled');
    if (operation === 'update') {
      assert.equal(current.triggerAt, '2026-10-29T05:00:00.000Z');
      assert.equal(current.repeatMinutes, 60);
    }
    service.stop();
  }
});
