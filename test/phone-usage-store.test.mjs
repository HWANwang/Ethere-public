import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PhoneUsageStore } from '../server/phone-usage-store.mjs';

test('legacy bucket totals are ignored and event intervals are bounded to the window', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-phone-'));
  const now = () => new Date('2026-10-29T13:00:00.000Z');
  const store = new PhoneUsageStore({ dataRoot, now });
  await store.ingest({ id: 'legacy', collectedAt: '2026-10-29T12:56:00Z', intervalStart: '2026-10-29T10:56:00Z', intervalEnd: '2026-10-29T12:56:00Z', apps: [{ packageName: 'old', foregroundMs: 999999999 }] });
  assert.equal((await store.status()).available, false);
  assert.deepEqual((await store.recent()).apps, []);
  const snapshot = { id: 'sample-1', schemaVersion: 2, collectedAt: '2026-10-29T12:58:00Z', intervalStart: '2026-10-29T10:58:00Z', intervalEnd: '2026-10-29T12:58:00Z', screen: { interactive: true, interactiveMs: 900000, unlockCount: 2 }, apps: [{ packageName: 'video', appName: '短视频', foregroundMs: 9999999 }], timeline: [
    { type: 'app', packageName: 'video', startAt: '2026-10-29T11:58:00Z', endAt: '2026-10-29T12:28:00Z' },
    { type: 'app', packageName: 'video', startAt: '2026-10-29T12:20:00Z', endAt: '2026-10-29T12:58:00Z' },
  ] };
  await store.ingest(snapshot);
  await store.ingest(snapshot);
  assert.equal((await store.status()).snapshotCount, 2);
  const recent = await store.recent({ lookbackMinutes: 60 });
  assert.equal(recent.apps[0].foregroundMs, 3_600_000);
  assert.equal(recent.screen.interactive, true);
  assert.equal(recent.stale, false);
  assert.equal(recent.dataQuality, 'usage-events');
  assert.equal(recent.timeline.length, 2);
});

test('overlapping snapshots are never added together', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-phone-'));
  const store = new PhoneUsageStore({ dataRoot, now: () => new Date('2026-10-29T13:00:00Z') });
  for (const [id, start, end] of [
    ['first', '2026-10-29T10:55:00Z', '2026-10-29T12:55:00Z'],
    ['second', '2026-10-29T10:58:00Z', '2026-10-29T12:58:00Z'],
  ]) await store.ingest({ id, schemaVersion: 2, collectedAt: end, intervalStart: start, intervalEnd: end,
    apps: [{ packageName: 'app', appName: '应用', foregroundMs: 7_200_000 }],
    timeline: [{ type: 'app', packageName: 'app', startAt: start, endAt: end }],
  });
  const recent = await store.recent({ lookbackMinutes: 120 });
  assert.equal(recent.apps[0].foregroundMs, 7_200_000);
  assert.equal(recent.dataUpdatedAt, '2026-10-29T12:58:00.000Z');
});
