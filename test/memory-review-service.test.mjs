import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatEventStore } from '../server/chat-event-store.mjs';
import { MemoryNodeStore } from '../server/memory-node-store.mjs';
import { CodexMemoryReviewer, MemoryReviewService } from '../server/memory-review-service.mjs';

test('checkpoint review retries failures without advancing and deduplicates by topic', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-review-test-'));
  const chatEventStore = new ChatEventStore({ dataRoot });
  const memoryNodeStore = new MemoryNodeStore({ dataRoot });
  await memoryNodeStore.advanceReviewCursor('chat', 0, { dailyCheck: true });
  await chatEventStore.append({ id: 'user-1', role: 'user', content: '我想重新学陶艺。' });
  await chatEventStore.append({ id: 'assistant-1', role: 'assistant', content: '听起来很重要。' });
  await chatEventStore.append({ id: 'user-2', role: 'user', content: '陶艺练习有成果我会更有动力。' });
  let fail = true;
  const reviewer = { async review() { if (fail) throw new Error('模型暂时不可用'); return [{ topicKey: '学陶艺·动力', content: '成果感可能有帮助，待验证。', owner: 'user', sourceIds: ['user-1', 'user-2'], aliases: ['陶艺练习'] }]; } };
  const service = new MemoryReviewService({ chatEventStore, memoryNodeStore, reviewer, userThreshold: 2 });
  await assert.rejects(service.tick(), /模型暂时不可用/);
  assert.equal((await memoryNodeStore.reviewCursor()).lastUserSeq, 0);
  fail = false;
  assert.equal((await service.tick()).created, 1);
  assert.equal((await memoryNodeStore.reviewCursor()).lastUserSeq, 3);
  const result = await memoryNodeStore.list({ query: '学陶艺' });
  assert.equal(result.total, 1);
  assert.equal(result.nodes[0].status, 'active');
  assert.equal((await memoryNodeStore.get(result.nodes[0].id)).sources.length, 2);
  assert.equal((await memoryNodeStore.matchText('今天还想陶艺练习'))[0].id, result.nodes[0].id);
  assert.equal((await service.tick()).skipped, 'empty');
});

test('a new deployment baselines old user history without creating nodes', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-baseline-test-'));
  const chatEventStore = new ChatEventStore({ dataRoot });
  const memoryNodeStore = new MemoryNodeStore({ dataRoot });
  await chatEventStore.append({ id: 'old-user', role: 'user', content: '很久以前的原话' });
  const service = new MemoryReviewService({ chatEventStore, memoryNodeStore, reviewer: { async review() { throw new Error('不应回查'); } } });
  await service.start();
  service.stop();
  assert.equal((await memoryNodeStore.reviewCursor()).lastUserSeq, 1);
});

test('a later checkpoint revises an old node and attaches the new chat source instead of creating a duplicate', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-followup-test-'));
  const chatEventStore = new ChatEventStore({ dataRoot });
  const memoryNodeStore = new MemoryNodeStore({ dataRoot });
  const original = await memoryNodeStore.create({ topicKey: '陶艺', content: '小时候学过陶艺。', aliases: ['陶艺练习'], sources: [{ type: 'chat', id: 'first-day' }] });
  for (let index = 0; index < 51; index += 1) await memoryNodeStore.create({ topicKey: `其他主题${index}`, content: '无关内容。' });
  await memoryNodeStore.advanceReviewCursor('chat', 0, { dailyCheck: true });
  await chatEventStore.append({ id: 'second-day', role: 'user', content: '我陶艺练习时得到明确反馈会更想继续。' });
  const reviewer = { async review({ existing }) {
    assert.equal(existing.some((node) => node.id === original.id), true);
    return [{ targetNodeId: original.id, topicKey: '陶艺', content: '小时候学过陶艺；陶艺练习时得到明确反馈会更想继续。', sourceIds: ['second-day'], sourceRelations: { 'second-day': 'corrects' }, aliases: ['反馈'] }];
  } };
  const service = new MemoryReviewService({ chatEventStore, memoryNodeStore, reviewer, userThreshold: 1 });
  const result = await service.tick();
  assert.equal(result.created, 0);
  assert.equal(result.revised, 1);
  const node = await memoryNodeStore.get(original.id);
  assert.equal(node.revision, 2);
  assert.equal(node.sources.length, 2);
  assert.equal(node.sources[0].id, 'second-day');
  assert.equal(node.sources[0].relation, 'corrects');
  assert.match(node.content, /明确反馈/);
  assert.deepEqual(node.aliases, ['反馈', '陶艺练习']);
  assert.equal((await memoryNodeStore.findByTopicKey('陶艺')).id, original.id);
});

test('an interrupted reviewer turn cannot advance memory extraction as if completed', async () => {
  const listeners = new Set();
  const archived = [];
  const client = {
    async initialize() {},
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'review-thread' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          for (const listener of listeners) listener({ method: 'item/agentMessage/delta', params: { threadId: 'review-thread', delta: '[]' } });
          for (const listener of listeners) listener({ method: 'turn/completed', params: { threadId: 'review-thread', turn: { status: 'interrupted' } } });
        });
        return { turn: { id: 'review-turn' } };
      }
      if (method === 'thread/archive') archived.push('review-thread');
      return {};
    },
    async close() {},
  };
  const reviewer = new CodexMemoryReviewer({
    dataRoot: 'unused', configStore: { getSettings: async () => ({ model: 'default' }) }, clientFactory: () => client,
  });
  await assert.rejects(reviewer.review({ events: [{ id: 'user-1', role: 'user', content: '请记住这件事。' }], existing: [] }), /记忆检查未完成：interrupted/);
  assert.deepEqual(archived, ['review-thread']);
});

test('a completed memory review archives only its own Codex thread', async () => {
  const listeners = new Set();
  const requests = [];
  const client = {
    async initialize() {},
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'memory-review-thread' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          for (const listener of listeners) listener({ method: 'item/agentMessage/delta', params: { threadId: 'memory-review-thread', delta: '[]' } });
          for (const listener of listeners) listener({ method: 'turn/completed', params: { threadId: 'memory-review-thread', turn: { status: 'completed' } } });
        });
        return { turn: { id: 'memory-review-turn' } };
      }
      return {};
    },
    async close() {},
  };
  const reviewer = new CodexMemoryReviewer({
    dataRoot: 'unused', configStore: { getSettings: async () => ({ model: 'default' }) }, clientFactory: () => client,
  });
  assert.deepEqual(await reviewer.review({ events: [{ id: 'user-1', role: 'user', content: '我今天陶艺练习了。' }], existing: [] }), []);
  assert.deepEqual(requests.filter((item) => item.method === 'thread/archive').map((item) => item.params), [{ threadId: 'memory-review-thread' }]);
});
