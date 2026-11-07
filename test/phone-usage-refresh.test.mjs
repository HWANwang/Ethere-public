import assert from 'node:assert/strict';
import test from 'node:test';
import { PhoneUsageRefresh } from '../server/phone-usage-refresh.mjs';

test('a phone request resolves only from its matching fresh snapshot', async () => {
  const refresh = new PhoneUsageRefresh({ timeoutMs: 100 });
  await assert.rejects(refresh.request(), (error) => error.statusCode === 503);
  let command;
  const unsubscribe = refresh.subscribe((value) => { command = value; });
  const pending = refresh.request(45);
  assert.equal(command.lookbackMinutes, 45);
  assert.equal(refresh.complete('wrong', { id: 'wrong' }), false);
  assert.equal(refresh.complete(command.id, { id: 'fresh' }), true);
  assert.deepEqual(await pending, { id: 'fresh' });
  unsubscribe();
});

test('a phone request times out rather than returning an old snapshot', async () => {
  const refresh = new PhoneUsageRefresh({ timeoutMs: 10 });
  refresh.subscribe(() => {});
  await assert.rejects(refresh.request(), (error) => error.statusCode === 504);
});

test('phone long polling receives a fresh request and keeps a short reconnect gap', async () => {
  const refresh = new PhoneUsageRefresh({ timeoutMs: 100 });
  const poll = refresh.poll(50);
  const result = refresh.request(30);
  const command = await poll;
  assert.equal(command.lookbackMinutes, 30);
  assert.equal(refresh.complete(command.id, { id: 'new-snapshot' }), true);
  assert.deepEqual(await result, { id: 'new-snapshot' });

  assert.equal(await refresh.poll(1), null);
  const waiting = refresh.request(40);
  const queued = await refresh.poll(10);
  assert.equal(queued.lookbackMinutes, 40);
  refresh.complete(queued.id, { id: 'after-reconnect' });
  assert.deepEqual(await waiting, { id: 'after-reconnect' });
});
