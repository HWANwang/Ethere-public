import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryNodeStore } from '../server/memory-node-store.mjs';
import { UnifiedMemoryStore } from '../server/unified-memory-store.mjs';

test('legacy core memories move into the node database once, preserving IDs and content', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-unified-memory-'));
  await mkdir(join(dataRoot, 'memory'));
  await writeFile(join(dataRoot, 'memory', 'memories.json'), JSON.stringify({ memories: [
    { id: 'memory-old', title: '相处方式', contentMarkdown: '喜欢自然的陪伴。', status: 'active', revision: 3, previousContent: { title: '相处方式', contentMarkdown: '喜欢陪伴。', revision: 2 }, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' },
  ] }));
  const nodes = new MemoryNodeStore({ dataRoot });
  const memory = new UnifiedMemoryStore({ dataRoot, memoryNodeStore: nodes });
  await memory.initialize();
  assert.equal((await nodes.get('memory-old')).tier, 'core');
  assert.equal((await memory.get('memory-old')).contentMarkdown, '喜欢自然的陪伴。');
  assert.match((await memory.context()).text, /喜欢自然的陪伴/);
  await memory.update('memory-old', { title: '相处方式', contentMarkdown: '喜欢自然、持续的陪伴。' }, { baseRevision: 3 });
  await memory.initialize();
  assert.equal((await memory.get('memory-old')).contentMarkdown, '喜欢自然、持续的陪伴。');
  assert.equal((await nodes.list({ tier: 'core' })).total, 1);
  const revisions = await nodes.revisions('memory-old');
  assert.deepEqual(revisions.map((item) => item.revision), [4, 3, 2]);
  assert.equal(revisions.at(-1).snapshot.content, '喜欢陪伴。');
});

test('approved promotion changes the same retrievable node to core and preserves sources', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-unified-promotion-'));
  const nodes = new MemoryNodeStore({ dataRoot, idFactory: () => 'node-original' });
  const memory = new UnifiedMemoryStore({ dataRoot, memoryNodeStore: nodes });
  await memory.initialize();
  const candidate = await nodes.create({ topicKey: '学习偏好', content: '喜欢慢慢探索。', status: 'active' });
  await nodes.addSource(candidate.id, { type: 'chat', id: 'chat-source' });
  const promoted = await memory.promote(candidate.id, { title: '学习偏好', contentMarkdown: '喜欢慢慢探索，而非催促。' }, { baseRevision: candidate.revision });
  assert.equal(promoted.id, candidate.id);
  assert.equal((await nodes.get(candidate.id)).sources[0].id, 'chat-source');
  assert.equal((await nodes.list({ tier: 'retrievable' })).total, 0);
  assert.match((await memory.context()).text, /喜欢慢慢探索/);
  await assert.rejects(memory.promote(candidate.id, { title: '学习偏好', contentMarkdown: '重复。' }, { baseRevision: candidate.revision }), /不存在/);
});
