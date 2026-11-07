import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimelineStore } from '../server/timeline-store.mjs';
import { createTimelineMcpTools } from '../server/timeline-mcp-tools.mjs';

const CATEGORIES = [
  { id: 'work', name: '工作', color: '#6178C8', status: 'active', children: [{ id: 'ethere-development', name: 'Ethere 开发', status: 'active' }] },
];

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-mcp-tools-test-'));
  let sequence = 0;
  const store = new TimelineStore({ dataRoot, initialCategories: CATEGORIES, idFactory: () => `evt_mcp_${++sequence}` });
  await store.initialize();
  return { store, tools: createTimelineMcpTools({ timelineStore: store }) };
}

test('timeline MCP exposes a compact taxonomy and batch creates queryable events', async () => {
  const { tools } = await fixture();
  assert.deepEqual(tools.list().map((tool) => tool.name), [
    'ethere_timeline_category_propose',
    'ethere_timeline_categories_context',
    'ethere_timeline_events_query',
    'ethere_timeline_events_batch_create',
    'ethere_timeline_event_update',
    'ethere_timeline_event_archive',
    'ethere_timeline_review_set',
  ]);
  const context = await tools.call('ethere_timeline_categories_context');
  assert.deepEqual(context.categories[0], {
    id: 'work', name: '工作', children: [{ id: 'ethere-development', name: 'Ethere 开发' }],
  });
  const created = await tools.call('ethere_timeline_events_batch_create', {
    categoryRevision: context.categoryRevision,
    events: [{
      startedAt: '2026-10-29T09:00:00+08:00', endedAt: '2026-10-29T10:30:00+08:00',
      title: '实现时间线 MCP', categoryId: 'work', subcategoryId: 'ethere-development',
    }],
  });
  assert.equal(created.count, 1);
  const queried = await tools.call('ethere_timeline_events_query', { start: '2026-10-29', keyword: 'MCP' });
  assert.equal(queried.events[0].eventId, created.created[0].eventId);
  assert.equal(queried.events[0].category, '工作 / Ethere 开发');
});

test('timeline MCP category proposals require approval and never mutate taxonomy directly', async () => {
  const { store, tools } = await fixture();
  const before = await store.listCategories();
  const proposal = await tools.call('ethere_timeline_category_propose', {
    level: 'secondary', name: '代码复盘', parentCategoryId: 'work', reason: '这类活动会长期重复，并且与开发执行需要分开统计。',
  });
  const after = await store.listCategories();
  assert.equal(proposal.pendingApproval, true);
  assert.equal(proposal.proposal.name, '代码复盘');
  assert.deepEqual(after, before);
  await assert.rejects(
    () => tools.call('ethere_timeline_category_propose', { level: 'primary', name: '工作', reason: '重复分类' }),
    /已经存在/,
  );
});

test('timeline MCP directly writes and overwrites a Markdown daily review', async () => {
  const { store, tools } = await fixture();
  const saved = await tools.call('ethere_timeline_review_set', {
    date: '2026-10-29', text: '## 今天\n\n- [x] 完成 MCP',
  });
  assert.equal(saved.review.revision, 1);
  const overwritten = await tools.call('ethere_timeline_review_set', {
    date: '2026-10-29', text: '## 覆盖后的回顾',
  });
  assert.equal(overwritten.review.revision, 2);
  assert.equal((await store.getReview('2026-10-29')).text, '## 覆盖后的回顾');
});

test('timeline MCP updates by stable event id and archives by revision', async () => {
  const { tools } = await fixture();
  const context = await tools.call('ethere_timeline_categories_context');
  const created = await tools.call('ethere_timeline_events_batch_create', {
    categoryRevision: context.categoryRevision,
    events: [{
      startedAt: '2026-10-29T14:00:00+08:00', endedAt: '2026-10-29T15:00:00+08:00',
      title: '旧标题', categoryId: 'work', subcategoryId: 'ethere-development',
    }],
  });
  const first = created.created[0];
  const updated = await tools.call('ethere_timeline_event_update', {
    eventId: first.eventId, baseRevision: first.revision, patch: { title: '新标题' },
  });
  assert.equal(updated.updated.revision, 2);
  const archived = await tools.call('ethere_timeline_event_archive', {
    eventId: first.eventId, baseRevision: updated.updated.revision,
  });
  assert.equal(archived.archived.archived, true);
});
