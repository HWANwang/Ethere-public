import assert from 'node:assert/strict';
import test from 'node:test';
import { CheckinService, pickDelayMs } from '../server/checkin-service.mjs';

test('check-in delay stays inside the configured random range', () => {
  assert.equal(pickDelayMs({ minMinutes: 10, maxMinutes: 20 }, () => 0), 600_000);
  assert.ok(pickDelayMs({ minMinutes: 10, maxMinutes: 20 }, () => 0.999) <= 1_200_000);
});

test('enabled check-in generates one proactive assistant event and reschedules', async () => {
  let callback;
  const stored = [];
  const service = new CheckinService({
    configStore: { getSettings: async () => ({ checkin: { enabled: true, minMinutes: 5, maxMinutes: 5 } }) },
    chatService: { isBusy: () => false, sendMessage: async ({ hidden, occurredAt }) => ({ text: hidden && occurredAt instanceof Date ? '主动来看看你。' : '', status: 'completed' }) },
    chatEventStore: { append: async (event) => { stored.push(event); } },
    random: () => 0,
    setTimer: (fn) => { callback = fn; return { unref() {} }; },
    clearTimer: () => {},
  });
  await service.start();
  assert.equal((await service.status()).enabled, true);
  await callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stored.length, 1);
  assert.equal(stored[0].source, 'checkin');
  assert.equal(stored[0].content, '主动来看看你。');
  const status = await service.status();
  assert.equal(status.lastOutcome, 'sent');
  assert.ok(status.lastSuccessAt);
  service.stop();
});

test('busy chat is recorded as a skipped check-in and gets rescheduled', async () => {
  let callback;
  const service = new CheckinService({
    configStore: { getSettings: async () => ({ checkin: { enabled: true, minMinutes: 5, maxMinutes: 10 } }) },
    chatService: { isBusy: () => true, sendMessage: async () => { throw new Error('不应发送'); } },
    chatEventStore: { append: async () => {} },
    random: () => 0,
    setTimer: (fn) => { callback = fn; return { unref() {} }; },
    clearTimer: () => {},
  });
  await service.start();
  await callback();
  await new Promise((resolve) => setImmediate(resolve));
  const status = await service.status();
  assert.equal(status.lastOutcome, 'skipped_busy');
  assert.ok(status.nextAt);
  service.stop();
});

test('check-in may stay silent without creating a chat event or stopping its schedule', async () => {
  let callback;
  const events = [];
  const service = new CheckinService({
    configStore: { getSettings: async () => ({ checkin: { enabled: true, minMinutes: 5, maxMinutes: 10 } }) },
    chatService: { isBusy: () => false, async sendMessage({ text }) {
      assert.match(text, /不是必须发消息/);
      assert.match(text, /ETHERE_SILENT/);
      return { text: 'ETHERE_SILENT', status: 'completed' };
    } },
    chatEventStore: { append: async (event) => { events.push(event); } },
    random: () => 0,
    setTimer: (fn) => { callback = fn; return { unref() {} }; },
    clearTimer: () => {},
  });
  await service.start();
  await callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 0);
  assert.equal((await service.status()).lastOutcome, 'silent');
  assert.ok((await service.status()).nextAt);
  service.stop();
});

test('silent check-in preserves multiple tool activities without adding a chat bubble', async () => {
  let callback;
  const events = [];
  const service = new CheckinService({
    configStore: { getSettings: async () => ({ checkin: { enabled: true, minMinutes: 5, maxMinutes: 10 } }) },
    chatService: { isBusy: () => false, async sendMessage(_input, emit) {
      emit({ type: 'activity', callId: 'lookup-1', tool: 'ethere_memory_nodes_search', content: '已搜索记忆', status: 'completed' });
      emit({ type: 'activity', callId: 'lookup-2', tool: 'ethere_reminders_list', content: '已查看提醒', status: 'completed' });
      emit({ type: 'activity', callId: 'write-1', tool: 'ethere_memory_node_revise', content: '已更新按需记忆', status: 'completed' });
      return { text: 'ETHERE_SILENT', status: 'completed' };
    } },
    chatEventStore: { append: async (event) => { events.push(event); } },
    setTimer: (fn) => { callback = fn; return { unref() {} }; }, clearTimer: () => {},
  });
  await service.start();
  await callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map((event) => [event.role, event.content]), [
    ['activity', '已搜索记忆'], ['activity', '已查看提醒'], ['activity', '已更新按需记忆'],
  ]);
  assert.equal((await service.status()).lastOutcome, 'silent');
  service.stop();
});

test('call or attention popup is counted as contact without a redundant message', async () => {
  let callback;
  const events = [];
  const service = new CheckinService({
    configStore: { getSettings: async () => ({ checkin: { enabled: true, minMinutes: 5, maxMinutes: 5 } }) },
    chatService: { isBusy: () => false, async sendMessage(_input, emit) {
      emit({ type: 'activity', callId: 'call-1', tool: 'ethere_incoming_call', content: '已发起来电', status: 'completed' });
      return { text: 'ETHERE_SILENT', status: 'completed' };
    } },
    chatEventStore: { append: async (event) => { events.push(event); } },
    setTimer: (fn) => { callback = fn; return { unref() {} }; }, clearTimer: () => {},
  });
  await service.start();
  await callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 0);
  assert.equal((await service.status()).lastOutcome, 'contacted');
  service.stop();
});

test('user chat interruption is not treated as a failed check-in', async () => {
  let callback;
  const service = new CheckinService({
    configStore: { getSettings: async () => ({ checkin: { enabled: true, minMinutes: 5, maxMinutes: 5 } }) },
    chatService: { isBusy: () => false, sendMessage: async () => ({ status: 'interrupted', text: '' }) },
    chatEventStore: { append: async () => assert.fail('interrupted check-in must not add a message') },
    setTimer: (fn) => { callback = fn; return { unref() {} }; }, clearTimer: () => {},
  });
  await service.start();
  await callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.status()).lastOutcome, 'interrupted');
  assert.equal((await service.status()).lastError, null);
  service.stop();
});
