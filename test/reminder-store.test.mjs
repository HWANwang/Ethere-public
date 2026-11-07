import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReminderStore } from '../server/reminder-store.mjs';

test('reminder subscribers receive current scheduled counts after writes', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-reminder-count-test-'));
  const store = new ReminderStore({ dataRoot, now: () => new Date('2026-10-29T04:00:00.000Z') });
  const counts = [];
  const unsubscribe = store.subscribe(({ scheduledCount }) => counts.push(scheduledCount));
  const created = await store.create({ message: '第一条', triggerAt: '2026-10-29T05:00:00.000Z' });
  const updated = await store.update(created.id, { message: '修改后的第一条' }, { baseRevision: created.revision });
  await store.cancel(created.id, { baseRevision: updated.revision });
  unsubscribe();
  await store.create({ message: '第二条', triggerAt: '2026-10-29T06:00:00.000Z' });
  assert.deepEqual(counts, [1, 1, 0]);
});

test('reminders persist, update by revision, repeat, and cancel without deletion', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-reminder-test-'));
  const now = () => new Date('2026-10-29T04:00:00.000Z');
  const store = new ReminderStore({ dataRoot, now });
  const created = await store.create({ title: '开始工作', message: '问我开始了没有', triggerAt: '2026-10-29T12:10:00+08:00', repeatMinutes: 30, relatedTaskId: 'task-1' });
  assert.equal(created.status, 'scheduled');
  const updated = await store.update(created.id, { triggerAt: '2026-10-29T12:20:00+08:00' }, { baseRevision: created.revision });
  assert.equal(updated.revision, 2);
  await assert.rejects(store.cancel(created.id, { baseRevision: 1 }), /提醒已变化/);
  const cancelled = await store.cancel(created.id, { baseRevision: 2 });
  assert.equal(cancelled.status, 'cancelled');
  const reloaded = new ReminderStore({ dataRoot, now });
  assert.equal((await reloaded.get(created.id)).status, 'cancelled');
});

test('due reminders are ordered and repeating reminders are rescheduled', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-reminder-test-'));
  const now = () => new Date('2026-10-29T04:00:00.000Z');
  const store = new ReminderStore({ dataRoot, now });
  const item = await store.create({ message: '测试提醒', triggerAt: '2026-10-29T11:59:00+08:00', repeatMinutes: 10 });
  assert.equal((await store.due()).length, 1);
  const next = await store.rescheduleAfterFire(item.id, '2026-10-29T12:10:00+08:00');
  assert.equal(next.status, 'scheduled');
  assert.equal((await store.due()).length, 0);
});

test('daily reminders use a fixed local time and remain scheduled after success', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-reminder-daily-test-'));
  let clock = new Date('2026-10-29T11:00:00.000Z');
  const store = new ReminderStore({ dataRoot, now: () => clock });
  const item = await store.create({ message: '整理今天的时间线', dailyAt: '20:30', timezone: 'Asia/Shanghai' });
  assert.equal(item.triggerAt, '2026-10-29T12:30:00.000Z');
  assert.equal(item.dailyAt, '20:30');
  clock = new Date('2026-10-29T12:35:00.000Z');
  const next = await store.rescheduleDailyAfterFire(item.id, { firedAt: clock.toISOString() });
  assert.equal(next.status, 'scheduled');
  assert.equal(next.lastSuccessDate, '2026-10-29');
  assert.equal(next.triggerAt, '2026-10-30T12:30:00.000Z');
  const reloaded = new ReminderStore({ dataRoot, now: () => clock });
  assert.equal((await reloaded.get(item.id)).dailyAt, '20:30');
});

test('daily reminders reject interval repetition and task linkage', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-reminder-daily-test-'));
  const store = new ReminderStore({ dataRoot, now: () => new Date('2026-10-29T04:00:00.000Z') });
  await assert.rejects(store.create({ message: '每日任务', dailyAt: '20:30', repeatMinutes: 1440 }), /不能同时设置复查间隔/);
  await assert.rejects(store.create({ message: '每日任务', dailyAt: '20:30', relatedTaskId: 'task-1' }), /不能关联监督任务/);
});

test('a fired reminder cannot overwrite a model update with an old revision', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-reminder-revision-test-'));
  const store = new ReminderStore({ dataRoot, now: () => new Date('2026-10-29T04:00:00.000Z') });
  const created = await store.create({ message: '回访进度', triggerAt: '2026-10-29T04:00:00.000Z', repeatMinutes: 30 });
  await store.update(created.id, { triggerAt: '2026-10-29T05:00:00.000Z' }, { baseRevision: created.revision });
  await assert.rejects(store.rescheduleAfterFire(created.id, '2026-10-29T04:30:00.000Z', { baseRevision: created.revision }), /提醒已变化/);
  await assert.rejects(store.retry(created.id, '2026-10-29T04:05:00.000Z', '失败', { baseRevision: created.revision }), /提醒已变化/);
  assert.equal((await store.get(created.id)).triggerAt, '2026-10-29T05:00:00.000Z');
});
