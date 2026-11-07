import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimelineStore } from '../server/timeline-store.mjs';

const TEST_CATEGORIES = [
  { id: 'work', name: '工作', color: '#6178C8', status: 'active', children: [
    { id: 'ethere-development', name: '项目开发', status: 'active' },
    { id: 'community-project', name: '社区项目', status: 'active' },
  ] },
  { id: 'rest', name: '休息', color: '#7A83D8', status: 'active', children: [
    { id: 'sleep', name: '睡眠', status: 'active' },
  ] },
  { id: 'uncategorized', name: '未分类', color: '#9398A5', status: 'active', children: [
    { id: 'to-organize', name: '待整理', status: 'active' },
  ] },
];

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-timeline-test-'));
  let tick = 0;
  let eventSequence = 0;
  const store = new TimelineStore({
    dataRoot,
    now: () => new Date(Date.UTC(2026, 9, 29, 5, 0, tick++)),
    idFactory: () => `evt_test_${++eventSequence}`,
    initialCategories: TEST_CATEGORIES,
  });
  return { dataRoot, store };
}

test('initializes a supplied taxonomy under the private data root', async () => {
  const { dataRoot, store } = await fixture();
  const result = await store.initialize();
  assert.deepEqual(result.categories.find((item) => item.id === 'work').children.map((item) => item.name), ['项目开发', '社区项目']);
  assert.equal(result.categories.find((item) => item.id === 'uncategorized').children[0].name, '待整理');
  const persisted = JSON.parse(await readFile(join(dataRoot, 'timeline', 'categories.json'), 'utf8'));
  assert.equal(persisted.schemaVersion, 1);
});

test('creates, persists, queries, and deduplicates a timeline event', async () => {
  const { dataRoot, store } = await fixture();
  const input = {
    mutationId: 'create-1',
    startedAt: '2026-10-29T09:20:00+08:00',
    endedAt: '2026-10-29T11:30:00+08:00',
    title: '开发时间轴存储',
    note: '先完成真实存储，不接页面。',
    categoryId: 'work',
    subcategoryId: 'ethere-development',
    author: 'user',
    source: { type: 'manual' },
  };
  const first = await store.createEvent(input);
  const duplicate = await store.createEvent(input);
  assert.deepEqual(duplicate, first);
  assert.equal(first.startedAt, '2026-10-29T09:20:00+08:00');
  assert.equal((await store.query({ start: '2026-10-29' })).length, 1);
  const day = JSON.parse(await readFile(join(dataRoot, 'timeline', '2026', '10', '2026-10-29.json'), 'utf8'));
  assert.equal(day.events.length, 1);
  assert.equal(day.mutations.length, 1);
});

test('cross-midnight events appear on both overlapping dates', async () => {
  const { store } = await fixture();
  await store.createEvent({
    mutationId: 'sleep-1',
    startedAt: '2026-10-28T23:30:00+08:00',
    endedAt: '2026-10-29T07:30:00+08:00',
    title: '睡觉',
    categoryId: 'rest',
    subcategoryId: 'sleep',
  });
  assert.equal((await store.query({ start: '2026-10-28' })).length, 1);
  assert.equal((await store.query({ start: '2026-10-29' })).length, 1);
  assert.equal((await store.query({ start: '2026-10-30' })).length, 0);
  const stats = await store.stats({ start: '2026-10-29' });
  assert.equal(stats.totalMinutes, 450);
  assert.equal(stats.groups[0].categoryId, 'rest');
  assert.equal(stats.groups[0].children[0].subcategoryId, 'sleep');
});

test('updates use revisions and archive remains recoverable', async () => {
  const { store } = await fixture();
  const created = await store.createEvent({
    mutationId: 'event-create', startedAt: '2026-10-29T14:00:00+08:00', endedAt: '2026-10-29T15:00:00+08:00',
    title: '写代码', categoryId: 'work', subcategoryId: 'ethere-development',
  });
  const updated = await store.updateEvent(created.id, { title: '写时间轴代码' }, { baseRevision: 1, mutationId: 'event-update' });
  assert.equal(updated.revision, 2);
  assert.equal(updated.history.length, 1);
  await assert.rejects(() => store.updateEvent(created.id, { title: '过期修改' }, { baseRevision: 1, mutationId: 'stale-update' }), /已经更新/);
  const archived = await store.archiveEvent(created.id, { baseRevision: 2, mutationId: 'event-archive' });
  assert.ok(archived.deletedAt);
  assert.equal((await store.query({ start: '2026-10-29' })).length, 0);
  assert.equal((await store.query({ start: '2026-10-29', includeDeleted: true })).length, 1);
  const restored = await store.restoreEvent(created.id, { baseRevision: 3, mutationId: 'event-restore' });
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.revision, 4);
});

test('daily reviews and category lifecycle enforce optimistic revisions', async () => {
  const { store } = await fixture();
  await store.initialize();
  const review = await store.setReview('2026-10-29', { text: '今天把存储层搭起来了。', mutationId: 'review-1' });
  assert.equal(review.revision, 1);
  assert.equal((await store.getReview('2026-10-29')).text, '今天把存储层搭起来了。');
  const categories = await store.listCategories({ includeInactive: true });
  const extended = await store.addSubcategory({ categoryId: 'work', id: 'planning', name: '规划', baseRevision: categories.revision });
  assert.equal(extended.categories.find((item) => item.id === 'work').children.at(-1).name, '规划');
  const renamed = await store.renameCategory({ categoryId: 'work', subcategoryId: 'community-project', name: '社区活动', baseRevision: extended.revision });
  assert.equal(renamed.categories.find((item) => item.id === 'work').children[1].name, '社区活动');
  const disabled = await store.setCategoryStatus({ categoryId: 'work', subcategoryId: 'community-project', status: 'inactive', baseRevision: renamed.revision });
  assert.equal(disabled.categories.find((item) => item.id === 'work').children[1].status, 'inactive');
  await assert.rejects(() => store.createEvent({
    mutationId: 'inactive-category', startedAt: '2026-10-29T16:00:00+08:00', endedAt: '2026-10-29T17:00:00+08:00',
    title: '社区工作', categoryId: 'work', subcategoryId: 'community-project',
  }), /已停用/);
});

test('invalid time and category data are rejected before persistence', async () => {
  const { store } = await fixture();
  await assert.rejects(() => store.createEvent({
    mutationId: 'bad-time', startedAt: '2026-10-29T11:00:00+08:00', endedAt: '2026-10-29T10:00:00+08:00',
    title: '倒流', categoryId: 'work', subcategoryId: 'ethere-development',
  }), /结束时间/);
  await assert.rejects(() => store.createEvent({
    mutationId: 'bad-category', startedAt: '2026-10-29T10:00:00+08:00', endedAt: '2026-10-29T11:00:00+08:00',
    title: '未知活动', categoryId: 'missing', subcategoryId: 'missing',
  }), /分类不存在/);
});

test('a mutation id cannot silently change the requested operation', async () => {
  const { store } = await fixture();
  const created = await store.createEvent({
    mutationId: 'shared-id', startedAt: '2026-10-29T10:00:00+08:00', endedAt: '2026-10-29T11:00:00+08:00',
    title: '测试幂等键', categoryId: 'work', subcategoryId: 'ethere-development',
  });
  await assert.rejects(() => store.updateEvent(created.id, { title: '不应生效' }, { baseRevision: 1, mutationId: 'shared-id' }), /其他操作/);
});

test('batch creation validates the category revision before writing any event', async () => {
  const { store } = await fixture();
  await store.initialize();
  const taxonomy = await store.listCategories();
  const inputs = [
    {
      mutationId: 'batch-1', startedAt: '2026-10-29T09:00:00+08:00', endedAt: '2026-10-29T10:00:00+08:00',
      title: '开发 Ethere', categoryId: 'work', subcategoryId: 'ethere-development',
    },
    {
      mutationId: 'batch-2', startedAt: '2026-10-29T12:00:00+08:00', endedAt: '2026-10-29T12:30:00+08:00',
      title: '午休', categoryId: 'rest', subcategoryId: 'sleep',
    },
  ];
  const created = await store.createEvents(inputs, { categoryRevision: taxonomy.revision });
  assert.equal(created.length, 2);
  assert.equal((await store.query({ start: '2026-10-29' })).length, 2);

  await store.renameCategory({ categoryId: 'work', name: '专注工作', baseRevision: taxonomy.revision });
  await assert.rejects(
    () => store.createEvents([{ ...inputs[0], mutationId: 'batch-stale' }], { categoryRevision: taxonomy.revision }),
    (error) => error.code === 'CATEGORY_REVISION_CHANGED' && error.currentRevision === taxonomy.revision + 1,
  );
  assert.equal((await store.query({ start: '2026-10-29' })).length, 2);
});

test('renaming a primary category can update its color', async () => {
  const { store } = await fixture();
  const taxonomy = await store.listCategories();
  const updated = await store.renameCategory({
    categoryId: 'work', name: '工作', color: '#D77D62', baseRevision: taxonomy.revision,
  });
  assert.equal(updated.categories.find((item) => item.id === 'work').color, '#D77D62');
});

test('category-changing updates require a current taxonomy revision', async () => {
  const { store } = await fixture();
  await store.initialize();
  const taxonomy = await store.listCategories();
  const created = await store.createEvent({
    mutationId: 'category-update-create', startedAt: '2026-10-29T14:00:00+08:00', endedAt: '2026-10-29T15:00:00+08:00',
    title: '整理项目', categoryId: 'work', subcategoryId: 'community-project',
  });
  const updated = await store.updateEventWithCategoryRevision(created.id, {
    categoryId: 'work', subcategoryId: 'ethere-development',
  }, {
    baseRevision: created.revision, categoryRevision: taxonomy.revision, mutationId: 'category-update',
  });
  assert.equal(updated.subcategoryId, 'ethere-development');
});
