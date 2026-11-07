import test from 'node:test';
import assert from 'node:assert/strict';
import { ethereApi } from '../web/companion-api.js';

test('chat stream rejects a clean network close before the done marker', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response('{"type":"start","messageId":"reply-1"}\n{"type":"delta","delta":"半段"}\n', {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
  await assert.rejects(ethereApi.streamChat({ message: '你好', messageId: 'message-1' }, () => {}), /回复流提前断开/);
});

test('chat stream accepts the authoritative done marker', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response('{"type":"delta","delta":"完整回复"}\n{"type":"done","cursor":5}\n', {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
  const events = [];
  await ethereApi.streamChat({ message: '你好', messageId: 'message-1' }, (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.type), ['delta', 'done']);
});
