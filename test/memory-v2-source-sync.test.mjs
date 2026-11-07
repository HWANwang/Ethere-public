import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryV2SourceSync } from '../server/memory-v2-source-sync.mjs';
import { sourceInstanceForDataRoot } from '../server/memory-v2-client.mjs';

test('升级来源协议时从零重扫聊天并同步时间线、空间墓碑', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'ethere-source-sync-'));
  mkdirSync(join(dataRoot, 'runtime'));
  writeFileSync(join(dataRoot, 'runtime', 'memory-v2-sync.json'), JSON.stringify({
    chatCursor: 999, sourceInstance: sourceInstanceForDataRoot(dataRoot), structuredBackfillDone: true,
  }));
  const imported = [];
  const sync = new MemoryV2SourceSync({ dataRoot, intervalMs: 60_000,
    client: { async importSources(rows) { imported.push(...rows); } },
    chatEventStore: { async listAfter(cursor) { assert.equal(cursor, 0); return { cursor: 3, events: [
      { id: 'u1', seq: 1, role: 'user', content: '陶艺', createdAt: '2026-11-01T00:00:00.000Z' },
      { id: 'a1', seq: 2, role: 'assistant', content: '继续聊', createdAt: '2026-11-01T00:01:00.000Z' },
      { id: 'tool', seq: 3, role: 'activity', content: '工具调用' },
    ] }; } },
    timelineStore: { async listAll() { return { events: [{ id: 't1', title: '陶艺练习', startedAt: '2026-11-01T00:00:00.000Z', deletedAt: '2026-11-02T00:00:00.000Z' }], hasMore: false }; } },
    spaceStore: { async listAll() { return { posts: [{ id: 's1', contentMarkdown: '旧动态', status: 'archived', occurredAt: '2026-11-01T00:00:00.000Z' }], hasMore: false }; } },
  });
  try {
    await sync.start();
    assert.deepEqual(imported.map((row) => row.externalId), ['u1', 'a1', 't1', 's1']);
    assert.ok(imported.every((row) => row.sourceInstance === sync.sourceInstance));
    assert.deepEqual(imported.filter((row) => row.deleted).map((row) => row.externalId), ['t1', 's1']);
  } finally { sync.stop(); rmSync(dataRoot, { recursive: true, force: true }); }
});
