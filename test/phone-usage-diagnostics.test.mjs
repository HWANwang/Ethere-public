import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneUsageDiagnostics } from '../server/phone-usage-diagnostics.mjs';
import { PhoneUsageRefresh } from '../server/phone-usage-refresh.mjs';

test('phone usage diagnostic log records stages without storing usage details', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-usage-log-'));
  const diagnostics = new PhoneUsageDiagnostics({ dataRoot, now: () => new Date('2026-11-01T13:12:00.000Z') });
  const refresh = new PhoneUsageRefresh({ timeoutMs: 100, onDiagnostic: (stage, details) => diagnostics.record(stage, details) });
  await assert.rejects(refresh.request(30), (error) => error.statusCode === 503);
  let command;
  refresh.subscribe((request) => { command = request; });
  const pending = refresh.request(60);
  refresh.fail(command.id, '授权已撤回');
  await assert.rejects(pending, /授权已撤回/);
  await diagnostics.pending;
  const entries = (await readFile(join(dataRoot, 'logs', 'phone-usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries.map((item) => item.stage), ['channel-unavailable', 'request-sent', 'phone-failed']);
  assert.equal(entries[2].requestId, command.id);
  assert.equal(entries[2].error, '授权已撤回');
  assert.equal(entries[2].at, '2026-11-01T13:12:00.000Z');
  assert.equal('apps' in entries[2], false);
});
