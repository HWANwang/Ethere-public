import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhoneUsageMcpTools } from '../server/phone-usage-mcp-tools.mjs';

test('phone usage MCP is read-only and forwards the requested window', async () => {
  let requested = '';
  const tools = createPhoneUsageMcpTools({ fetchImpl: async (url) => { requested = String(url); return { ok: true, json: async () => ({ dataUpdatedAt: null, apps: [] }) }; } });
  const definition = tools.list()[0];
  assert.equal(definition.name, 'ethere_phone_usage_recent_get');
  assert.equal(definition.annotations.readOnlyHint, true);
  await tools.call(definition.name, { lookbackMinutes: 45, includeTimeline: true });
  assert.match(requested, /lookbackMinutes=45/);
  assert.match(requested, /includeTimeline=true/);
  assert.match(requested, /fresh=true/);
});
