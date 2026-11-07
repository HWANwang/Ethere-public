import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceActionService } from '../server/device-action-service.mjs';

test('popup is singular, survives restart, and resolves exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ethere-device-action-'));
  try {
    const service = new DeviceActionService({ dataRoot: root });
    const created = await service.createPopup({ message: '回来歇一下？', actions: [{ id: 'rest', label: '休息' }] });
    await assert.rejects(service.createPopup({ message: '重复', actions: [{ id: 'ok', label: '知道了' }] }), /已有监督弹窗/);
    const resumed = new DeviceActionService({ dataRoot: root });
    assert.equal((await resumed.poll(1)).id, created.id);
    assert.equal((await resumed.acknowledge(created.id, 'displaying')).state, 'displaying');
    assert.equal((await resumed.resolve(created.id, 'rest')).duplicate, false);
    assert.equal((await resumed.resolve(created.id, 'rest')).duplicate, true);
    assert.equal((await resumed.pendingResults()).length, 1);
    await resumed.markEventDelivered(created.id);
    assert.equal((await resumed.pendingResults()).length, 0);
    assert.equal((await resumed.createPopup({ message: '新弹窗', actions: [{ id: 'ok', label: '好' }] })).state, 'queued');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('incoming call may be immediate or scheduled and defaults to ten-minute snooze', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ethere-device-call-'));
  try {
    const now = Date.parse('2026-11-03T10:00:00+08:00');
    const service = new DeviceActionService({ dataRoot: root, now: () => now });
    const immediate = await service.createCall({});
    assert.equal(immediate.snoozeMinutes, 10);
    assert.equal(immediate.triggerAt, new Date(now).toISOString());
    const scheduled = await service.createCall({ openingText: '早上好，用户。今天想先聊什么？', triggerAt: '2026-11-03T10:30:00+08:00', snoozeMinutes: 15 });
    assert.equal(scheduled.snoozeMinutes, 15);
    assert.equal(scheduled.openingText, '早上好，用户。今天想先聊什么？');
    await service.acknowledge(scheduled.id, 'scheduled');
    const snoozedAt = '2026-11-03T10:45:00+08:00';
    const snoozed = await service.resolve(scheduled.id, 'snoozed', '', snoozedAt);
    assert.equal(snoozed.action.state, 'scheduled');
    assert.equal(snoozed.action.triggerAt, new Date(snoozedAt).toISOString());
    const cancel = await service.cancelCall(scheduled.id);
    assert.equal(cancel.targetId, scheduled.id);
    assert.equal((await service.poll(1)).type, 'incoming_call');
    await service.acknowledge(immediate.id, 'displaying');
    assert.equal((await service.poll(1)).type, 'incoming_call_cancel');
    await service.resolve(cancel.id, 'cancelled');
    const file = join(root, 'state', 'device-actions.json');
    const legacy = JSON.parse(await readFile(file, 'utf8'));
    const staleOriginal = legacy.find((item) => item.id === scheduled.id);
    staleOriginal.state = 'scheduled';
    staleOriginal.outcome = '';
    await writeFile(file, JSON.stringify(legacy));
    const reloaded = new DeviceActionService({ dataRoot: root, now: () => now });
    assert.equal((await reloaded.cancelCall(scheduled.id)).state, 'cancelled');
    assert.equal(await reloaded.poll(1), null);
    assert.equal((await service.pendingResults()).some((item) => item.id === cancel.id), false);
    await assert.rejects(service.createCall({ openingText: '' }), /开场语/);
    await assert.rejects(service.createCall({ triggerAt: 'invalid' }), /时间无效/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
