import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyPlanStore } from '../server/study-plan-store.mjs';
import { createStudyMcpTools } from '../server/study-mcp-tools.mjs';

const created = [];
afterEach(async () => {
  const entries = created.splice(0);
  for (const { store } of entries) store.close();
  for (const root of new Set(entries.map((entry) => entry.root))) await rm(root, { recursive: true, force: true });
});

async function freshStore() {
  const root = await mkdtemp(join(tmpdir(), 'ethere-study-'));
  const store = new StudyPlanStore({ dataRoot: root });
  created.push({ store, root });
  await store.initialize();
  return { store, root };
}

test('learning checkpoint survives restart and only explicit completion advances', async () => {
  const { store, root } = await freshStore();
  const plan = await store.create({ title: '语用学', lessons: ['语言与语境', '会话含义'] });
  const checkpoint = await store.update(plan.id, { baseRevision: 1, action: 'checkpoint', note: '讲完指示语，下一步举例' });
  assert.equal(checkpoint.currentLessonId, plan.lessons[0].id);
  assert.equal(checkpoint.lessons[0].status, 'pending');
  store.close();
  const reopened = new StudyPlanStore({ dataRoot: root });
  created.push({ store: reopened, root });
  assert.equal((await reopened.get(plan.id)).checkpoint, '讲完指示语，下一步举例');
  const next = await reopened.update(plan.id, { baseRevision: 2, action: 'complete_lesson', summary: '已理解指示语' });
  assert.equal(next.currentLessonId, plan.lessons[1].id);
  assert.equal(next.lessons[0].summary, '已理解指示语');
  assert.equal((await reopened.list())[0].completedCount, 1);
});

test('learning plans reject duplicate titles, stale revisions and removing completed lessons', async () => {
  const { store } = await freshStore();
  const plan = await store.create({ title: '前端', lessons: ['HTML', 'CSS'] });
  await assert.rejects(store.create({ title: '前端', lessons: ['重复'] }), { statusCode: 409 });
  const next = await store.update(plan.id, { baseRevision: 1, action: 'complete_lesson', summary: '学过标签' });
  await assert.rejects(store.update(plan.id, { baseRevision: 1, action: 'checkpoint', note: '旧版本' }), { statusCode: 409 });
  await assert.rejects(store.update(plan.id, { baseRevision: 2, action: 'revise_outline', lessons: [{ id: next.lessons[1].id, title: 'CSS' }] }), { statusCode: 409 });
  assert.equal((await store.get(plan.id)).revision, 2);
});

test('learning plan cannot skip a lesson or complete an already completed lesson', async () => {
  const { store } = await freshStore();
  const plan = await store.create({ title: '大模型基础', lessons: ['概览', '训练', '评测'] });
  await assert.rejects(store.update(plan.id, {
    baseRevision: 1, action: 'complete_lesson', lessonId: plan.lessons[2].id, summary: '误选了后面的课节',
  }), { statusCode: 409 });
  const next = await store.update(plan.id, { baseRevision: 1, action: 'complete_lesson', summary: '概览已学完' });
  assert.equal(next.currentLessonId, plan.lessons[1].id);
  await assert.rejects(store.update(plan.id, {
    baseRevision: 2, action: 'complete_lesson', lessonId: plan.lessons[0].id, summary: '重复完成',
  }), { statusCode: 409 });
  assert.equal((await store.get(plan.id)).revision, 2);
});

test('study MCP exposes list/get/create/update and preserves edit boundary', async () => {
  const { store } = await freshStore();
  const tools = createStudyMcpTools({ studyPlanStore: store });
  assert.deepEqual(tools.list().map((item) => item.name), [
    'ethere_study_plans_list', 'ethere_study_plan_get', 'ethere_study_plan_create', 'ethere_study_plan_update',
  ]);
  const { plan } = await tools.call('ethere_study_plan_create', { title: '统计学导论', lessons: ['概览', '八种类型'] });
  assert.equal((await tools.call('ethere_study_plans_list')).plans.length, 1);
  assert.equal((await tools.call('ethere_study_plan_get', { planId: plan.id })).plan.title, '统计学导论');
  const updated = await tools.call('ethere_study_plan_update', { planId: plan.id, baseRevision: 1, action: 'checkpoint', note: '还在概览' });
  assert.equal(updated.plan.lessons[0].status, 'pending');
});
