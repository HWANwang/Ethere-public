import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLabStore } from '../src/store.mjs';
import { MemoryMaintenanceService } from '../src/maintenance-service.mjs';

function fixture({ staleScreenOnce = false, staleScreenAlways = false, concatenatedScreenOnce = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ethere-maintenance-'));
  const store = new MemoryLabStore(join(dir, 'memory.sqlite'));
  const calls = [];
  const backend = {
    async createThread(role) { calls.push(['start', role]); return `thread-${role}`; },
    async turn(threadId, prompt) {
      calls.push(['turn', threadId, prompt]);
      if (threadId === 'thread-screen') {
        const input = JSON.parse(prompt);
        if (concatenatedScreenOnce && calls.filter(([kind, thread]) => kind === 'turn' && thread === 'thread-screen').length === 1)
          return JSON.stringify({ remember: [], watch: [], discard_summary: '上一轮答复' }) +
            JSON.stringify({ remember: [{ id: 'r1', statement: '用户在学习陶艺。', evidence_refs: [input.source_records[0].ref], reason: '长期学习经历' }], watch: [], discard_summary: '' });
        if (staleScreenOnce && calls.filter(([kind, thread]) => kind === 'turn' && thread === 'thread-screen').length === 1)
          return JSON.stringify({ remember: [{ id: 'old', statement: '用户在学习陶艺。', evidence_refs: ['src_from_previous_batch'], reason: '旧线程污染' }], watch: [], discard_summary: '' });
        if (staleScreenAlways) return JSON.stringify({ remember: [
          { id: 'old', statement: '用户在学习陶艺。', evidence_refs: ['src_from_previous_batch'], reason: '旧线程污染' },
          { id: 'valid', statement: '用户在学习陶艺。', evidence_refs: [input.source_records[0].ref], reason: '当前来源' },
        ], watch: [], discard_summary: '' });
        return JSON.stringify({ remember: [{ id: 'r1', statement: '用户在学习陶艺。', evidence_refs: [input.source_records[0].ref], reason: '长期学习经历' }], watch: [], discard_summary: '' });
      }
      const input = JSON.parse(prompt);
      return JSON.stringify({ memories: [{ temp_id: 'm1', memory_type: 'fact', memory_state: 'remember', record_status: 'available',
        content: '用户在学习陶艺。', valid_from: null, valid_to: null,
        evidence_refs: input.remember_candidates[0].evidence_refs, merge_reason: '有原话来源' }], links: [], resolved_issue_ids: [], discarded_candidates: [] });
    },
    async compact(threadId) { calls.push(['compact', threadId]); },
  };
  const now = () => new Date('2026-11-07T04:00:00.000Z');
  const service = new MemoryMaintenanceService({ store, backend, dataRoot: dir, sourceInstance: 'production', now,
    recall: { async recall() { return { results: [] }; } },
    policy: { userMessages: 1, maxSources: 120, maxInputCharacters: 120_000, elapsedHours: 6,
      issueDelayMinutes: 10, dailyHour: 3, dailyMinute: 30, contextBudgetTokens: 120_000,
      checkpointRatio: .65, compactRatio: .75 } });
  return { dir, store, service, calls, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('自动维护只处理匹配来源，复用两个独立线程且批次幂等', async () => {
  const f = fixture();
  try {
    await f.service.initialize();
    f.store.importSources([{ sourceType: 'chat', externalId: 'wrong', role: 'user', content: '无关来源', sourceInstance: 'other', occurredAt: '2026-11-07T03:00:00.000Z' },
      { sourceType: 'chat', externalId: 'pottery', role: 'user', content: '我在学陶艺', sourceInstance: 'production', occurredAt: '2026-11-07T03:00:00.000Z' }]);
    const status = await f.service.tick();
    assert.equal(status.pendingSources, 0);
    assert.equal(f.store.stats().memories, 1);
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'start'), [['start', 'screen'], ['start', 'curate']]);
    assert.equal(f.calls.filter(([kind, thread]) => kind === 'turn' && thread === 'thread-screen').length, 3);
    assert.equal(f.store.listMaintenance()[0].status, 'completed');
    await f.service.tick();
    assert.equal(f.store.stats().memories, 1);
  } finally { f.close(); }
});

test('压缩后连续返回两个完整 JSON 时只采用后一个并继续验证来源', async () => {
  const f = fixture({ concatenatedScreenOnce: true });
  try {
    await f.service.initialize();
    f.store.importSources([{ sourceType: 'chat', externalId: 'pottery', role: 'user', content: '我在学陶艺',
      sourceInstance: 'production', occurredAt: '2026-11-07T03:00:00.000Z' }]);
    const status = await f.service.tick();
    assert.equal(status.lastError, '');
    assert.equal(f.store.stats().memories, 1);
    assert.equal(f.store.getEvidence(f.store.listMemories()[0].id)[0].source_id, 'pottery');
  } finally { f.close(); }
});

test('固定筛选线程误用上一批来源 ID 时限次纠正且不写入脏证据', async () => {
  const f = fixture({ staleScreenOnce: true });
  try {
    await f.service.initialize();
    f.store.importSources([{ sourceType: 'chat', externalId: 'pottery', role: 'user', content: '我在学陶艺',
      sourceInstance: 'production', occurredAt: '2026-11-07T03:00:00.000Z' }]);
    const status=await f.service.tick();
    assert.equal(status.lastError,'');
    assert.equal(f.calls.filter(([kind,thread])=>kind==='turn'&&thread==='thread-screen').length,4);
    assert.equal(f.store.stats().memories,1);
    assert.equal(f.store.getEvidence(f.store.listMemories()[0].id)[0].source_id,'pottery');
  } finally { f.close(); }
});

test('纠正后仍误引旧来源时丢弃坏候选而不阻塞整批', async () => {
  const f = fixture({ staleScreenAlways: true });
  try {
    await f.service.initialize();
    f.store.importSources([{ sourceType: 'chat', externalId: 'pottery', role: 'user', content: '我在学陶艺',
      sourceInstance: 'production', occurredAt: '2026-11-07T03:00:00.000Z' }]);
    const status = await f.service.tick();
    assert.equal(status.lastError, '');
    assert.equal(f.store.stats().memories, 1);
    assert.equal(f.store.getEvidence(f.store.listMemories()[0].id)[0].source_id, 'pottery');
  } finally { f.close(); }
});

test('过时问题单复查时带入同一来源实例的近期原话，即使来源已处理', async () => {
  const f = fixture();
  try {
    await f.service.initialize();
    f.store.importSources([
      { sourceType: 'chat', externalId: 'pottery', role: 'user', content: '我在学陶艺', sourceInstance: 'production', occurredAt: '2026-11-07T03:29:00.000Z' },
      ...Array.from({ length: 40 }, (_, i) => ({ sourceType: 'chat', externalId: `noise-${i}`, role: 'assistant', content: `无关回应 ${i}`,
        sourceInstance: 'production', occurredAt: new Date(Date.parse('2026-11-07T03:40:00.000Z') + i * 25_000).toISOString() })),
      { sourceType: 'chat', externalId: 'latest', role: 'user', content: '陶艺有新进展', sourceInstance: 'production', occurredAt: '2026-11-07T03:59:00.000Z' },
      { sourceType: 'chat', externalId: 'unrelated', role: 'user', content: '别人的陶艺', sourceInstance: 'other', occurredAt: '2026-11-07T03:29:00.000Z' },
    ]);
    const processed=f.store.db.prepare('INSERT INTO maintenance_processed_sources(source_id,content_hash,processed_at) VALUES(?,?,?)');
    for(const source of f.store.db.prepare("SELECT id,content_hash FROM source_records WHERE source_instance='production'").all())
      processed.run(source.id,source.content_hash,'2026-11-07T03:59:30.000Z');
    const issue=f.store.reportIssue({ issue_type:'outdated', note:'陶艺学习进展需要更新' });
    f.store.db.prepare('UPDATE memory_issues SET created_at=? WHERE id=?').run('2026-11-07T03:30:00.000Z',issue.id);
    await f.service.tick();
    const screen=JSON.parse(f.calls.find(([kind,thread])=>kind==='turn'&&thread==='thread-screen')[2]);
    const curator=JSON.parse(f.calls.find(([kind,thread])=>kind==='turn'&&thread==='thread-curate')[2]);
    const ids=screen.source_records.map((row)=>row.source_id);
    assert.ok(ids.includes('pottery'));
    assert.ok(ids.includes('latest'));
    assert.ok(!ids.includes('unrelated'));
    assert.ok(curator.issue_context_sources.some((row)=>row.source_id==='pottery'));
    assert.ok(curator.issue_context_sources.some((row)=>row.source_id==='latest'));
  } finally { f.close(); }
});

test('人工遗忘的内容不能通过后台重新创建或恢复', () => {
  const f = fixture();
  try {
    const candidate = { temp_id: 'old', memory_type: 'fact', memory_state: 'remember', record_status: 'available',
      content: '用户在学习陶艺。', evidence_refs: [{ source_type: 'chat', source_id: 'pottery' }] };
    const id = f.store.applyCuratedOutput({ memories: [candidate], links: [] }).created[0];
    f.store.reviseMemory(id, { record_status: 'forgotten' });
    assert.throws(() => f.store.applyCuratedOutput({ memories: [{ ...candidate, temp_id: 'new' }], links: [] }), /已遗忘内容/);
    assert.throws(() => f.store.applyCuratedOutput({ memories: [{ ...candidate, memory_id: id }], links: [] }), /已遗忘节点/);
    assert.equal(f.store.stats().memories, 1);
  } finally { f.close(); }
});

test('北京时间来源与 UTC 基线按实际时刻比较', async () => {
  const f = fixture();
  try {
    await f.service.initialize();
    f.service.state.baselineAt = '2026-11-06T15:22:52.606Z';
    f.store.importSources([
      { sourceType: 'timeline', externalId: 'earlier', content: '较早的事件', sourceInstance: 'production', occurredAt: '2026-11-06T16:58:00+08:00' },
      { sourceType: 'timeline', externalId: 'later', content: '之后的事件', sourceInstance: 'production', occurredAt: '2026-11-07T02:00:00+08:00' },
    ]);
    assert.equal(f.service.status().pendingSources, 1);
  } finally { f.close(); }
});
