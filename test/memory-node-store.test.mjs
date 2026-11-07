import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryNodeStore } from '../server/memory-node-store.mjs';

test('a retrievable memory node stays short, indexed by topic, and links multiple sources', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-node-test-'));
  const store = new MemoryNodeStore({ dataRoot });
  const node = await store.create({ topicKey: '学陶艺·反馈与成果', content: '目前观察到成果感会影响继续练习的动力。', owner: 'user' });
  assert.equal(node.tier, 'retrievable');
  assert.equal(node.status, 'active');
  await store.addSource(node.id, { type: 'chat', id: 'chat-1' });
  await store.addSource(node.id, { type: 'space', id: 'space-1', relation: 'corrects' });
  await store.setAliases(node.id, ['陶艺', '陶艺练习']);
  assert.equal((await store.get(node.id)).sources.length, 2);
  assert.equal((await store.list({ query: '陶艺' })).total, 1);
  assert.equal((await store.matchText('今天又想陶艺练习了'))[0].id, node.id);
  await assert.rejects(store.create({ topicKey: '学陶艺·反馈与成果', content: '重复' }), /已有记忆节点/);
  await assert.rejects(store.create({ topicKey: '核心', content: '未经批准', tier: 'core' }), /需要用户审批/);
  const revised = await store.update(node.id, { content: '这仍是待验证观察。' }, { baseRevision: 1 });
  assert.equal(revised.revision, 2);
  assert.equal((await store.revisions(node.id)).length, 2);
  await assert.rejects(store.update(node.id, { content: '旧修订' }, { baseRevision: 1 }), /已更新/);
});

test('review cursor only advances after success and handoff is consumed once', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-node-cursor-test-'));
  const store = new MemoryNodeStore({ dataRoot, now: () => new Date('2026-10-31T17:10:00.000Z') });
  assert.equal((await store.reviewCursor()).lastUserSeq, 0);
  await store.advanceReviewCursor('chat', 50);
  await store.advanceReviewCursor('chat', 20);
  assert.equal((await store.reviewCursor()).lastUserSeq, 50);
  await store.advanceReviewCursor('chat', 50, { dailyCheck: true });
  assert.equal((await store.reviewCursor()).lastDailyCheck, '2026-11-01');
  const handoff = await store.saveHandoff('最近在整理记忆库。');
  assert.equal((await store.consumeHandoff()).id, handoff.id);
  assert.equal(await store.consumeHandoff(), null);
});

test('node search covers both tiers and ranks title matches above aliases and content', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-node-search-test-'));
  const store = new MemoryNodeStore({ dataRoot });
  const core = await store.create({ topicKey: '音乐学习经历与重新学陶艺的愿望', content: '小时候学陶艺，现在仍想重新接触陶艺。', tier: 'core', status: 'active', approved: true });
  const retrievable = await store.create({ topicKey: '音乐练习的反馈', content: '练习时喜欢有反馈。', aliases: ['学陶艺'] });
  await store.create({ topicKey: '其他', content: '偶尔听音乐。', status: 'archived' });
  const result = await store.search({ query: '学陶艺' });
  assert.equal(result[0].id, core.id);
  assert.equal(result[0].tier, 'core');
  assert.equal(result[1].id, retrievable.id);
  assert.equal(result[1].status, 'active');
  assert.equal(result.some((node) => node.status === 'archived'), false);
  assert.equal((await store.search({ query: '音乐学习经历' }))[0].id, core.id);
});

test('archiving a retrievable node moves it between active and archived lists', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-node-archive-test-'));
  const store = new MemoryNodeStore({ dataRoot });
  const node = await store.create({ topicKey: '陶艺', content: '想重新练习陶艺。' });
  assert.deepEqual((await store.list({ tier: 'retrievable', status: 'active' })).nodes.map((item) => item.id), [node.id]);
  const archived = await store.update(node.id, { status: 'archived' }, { baseRevision: node.revision });
  assert.equal((await store.list({ tier: 'retrievable', status: 'active' })).total, 0);
  assert.deepEqual((await store.list({ tier: 'retrievable', status: 'archived' })).nodes.map((item) => item.id), [node.id]);
  const restored = await store.update(node.id, { status: 'active' }, { baseRevision: archived.revision });
  assert.equal(restored.status, 'active');
  assert.equal((await store.list({ tier: 'retrievable', status: 'archived' })).total, 0);
});

test('legacy pending nodes become active on startup without losing their sources or revision history', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-node-legacy-pending-'));
  const store = new MemoryNodeStore({ dataRoot });
  const node = await store.create({ topicKey: '陶艺练习经历', content: '小时候练过琴。', sources: [{ type: 'chat', id: 'old-message' }] });
  store.database.prepare("UPDATE memory_nodes SET status = 'candidate' WHERE id = ?").run(node.id);
  const restarted = new MemoryNodeStore({ dataRoot });
  const activated = await restarted.get(node.id);
  assert.equal(activated.status, 'active');
  assert.equal(activated.revision, 2);
  assert.equal(activated.sources[0].id, 'old-message');
  assert.equal((await restarted.revisions(node.id)).length, 2);
  assert.equal((await restarted.matchText('我还记得陶艺练习经历'))[0].id, node.id);
});

test('node creation stores aliases and multiple sources together', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-node-create-test-'));
  const store = new MemoryNodeStore({ dataRoot });
  const node = await store.create({ topicKey: '学陶艺', content: '想重新练习。', aliases: ['陶艺'], sources: [{ type: 'chat', id: 'chat-1' }, { type: 'space', id: 'space-1' }] });
  assert.deepEqual(node.aliases, ['陶艺']);
  assert.equal(node.sources.length, 2);
  await assert.rejects(store.create({ topicKey: '坏来源', content: '内容', sources: [{ type: 'unknown', id: 'x' }] }), /来源类型或 ID 无效/);
  assert.equal((await store.list()).total, 1);
});

test('revising one retrievable node keeps old sources and versions, deduplicates retries, and rejects stale writes', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-node-revise-test-'));
  const store = new MemoryNodeStore({ dataRoot });
  const first = await store.create({ topicKey: '陶艺', content: '小时候学过陶艺。', aliases: ['学陶艺'], sources: [{ type: 'chat', id: 'day-one' }] });
  const second = await store.reviseRetrievable(first.id, {
    content: '小时候学过陶艺；现在发现，练习时有明确反馈更愿意继续。',
    sources: [{ type: 'chat', id: 'day-two' }], aliases: ['陶艺练习'],
  }, { baseRevision: first.revision });
  assert.equal(second.id, first.id);
  assert.equal(second.revision, 2);
  assert.deepEqual(second.sources.map((source) => source.id), ['day-two', 'day-one']);
  assert.deepEqual(second.aliases, ['学陶艺', '陶艺练习']);
  const revisions = await store.revisions(first.id);
  assert.equal(revisions[0].snapshot.sources.length, 2);
  assert.equal(revisions[1].snapshot.sources.length, 1);
  assert.equal(revisions[1].snapshot.content, first.content);
  const retry = await store.reviseRetrievable(first.id, { content: second.content, sources: [{ type: 'chat', id: 'day-two' }] }, { baseRevision: 2 });
  assert.equal(retry.revision, 2);
  const corrected = await store.reviseRetrievable(first.id, { sources: [{ type: 'chat', id: 'day-two', relation: 'corrects' }] }, { baseRevision: 2 });
  assert.equal(corrected.revision, 3);
  assert.equal(corrected.sources.length, 2);
  assert.equal(corrected.sources[0].relation, 'corrects');
  await assert.rejects(store.reviseRetrievable(first.id, { content: '旧理解', sources: [{ type: 'chat', id: 'day-three' }] }, { baseRevision: 1 }), /重新打开/);
  assert.equal((await store.get(first.id)).sources.length, 2);
  assert.equal((await store.revisions(first.id)).length, 3);
  const core = await store.create({ topicKey: '核心主题', content: '不能直接修订。', tier: 'core', approved: true });
  await assert.rejects(store.reviseRetrievable(core.id, { content: '绕过审批', sources: [{ type: 'chat', id: 'day-two' }] }, { baseRevision: 1 }), /可修订的按需记忆/);
});
