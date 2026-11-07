import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../server/memory-store.mjs';

test('memory store persists topic blocks, one previous version, archive and restore', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-'));
  let id = 0;
  const store = new MemoryStore({ dataRoot, idFactory: () => `memory-${++id}`, now: clock() });
  await store.initialize();
  const created = await store.create({ title: '启动与收尾支持', contentMarkdown: '- 开始前把任务切成很小的一步。' });
  const updated = await store.update(created.id, { title: created.title, contentMarkdown: '- 开始前把任务切成很小的一步。\n- 结束时明确告诉我已经完成。' }, { baseRevision: created.revision });
  assert.equal(updated.previousContent.contentMarkdown, '- 开始前把任务切成很小的一步。');
  const archived = await store.archive(created.id, { baseRevision: updated.revision });
  assert.equal((await store.context()).text, '# 长期记忆\n\n暂无长期记忆。\n');
  const restored = await store.restore(created.id, { baseRevision: archived.revision });
  assert.equal(restored.status, 'active');
  assert.match(await readFile(join(dataRoot, 'memory', 'MEMORY.md'), 'utf8'), /启动与收尾支持/);
  assert.equal((await new MemoryStore({ dataRoot }).list()).memories.length, 1);
});

test('memory store rejects duplicates and enforces revisions', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-'));
  const store = new MemoryStore({ dataRoot, idFactory: () => 'memory-one' });
  await store.initialize();
  const memory = await store.create({ title: '外出前检查习惯', contentMarkdown: '出门前需要检查钥匙和手机。' });
  await assert.rejects(() => store.create({ title: '外出前检查习惯', contentMarkdown: '重复' }), /重复/);
  await assert.rejects(() => store.update(memory.id, { title: memory.title, contentMarkdown: '新版' }, { baseRevision: 99 }), /已经更新/);
});

test('memory store can keep an explicitly approved similar topic separate', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-'));
  let id = 0;
  const store = new MemoryStore({ dataRoot, idFactory: () => `memory-${++id}` });
  await store.initialize();
  await store.create({ title: '外出前检查习惯', contentMarkdown: '出门前需要检查钥匙和手机。' });
  const separate = await store.create(
    { title: '外出前检查习惯', contentMarkdown: '出门前还需要检查耳机。' },
    { allowDuplicate: true },
  );
  assert.equal(separate.id, 'memory-2');
  assert.equal((await store.list()).activeCount, 2);
});

test('memory store detects reworded memories with moderately similar titles and content', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-'));
  const store = new MemoryStore({ dataRoot, idFactory: () => 'memory-long-text' });
  await store.initialize();
  await store.create({
    title: '长文本记忆展示测试',
    contentMarkdown: '用于检查较长内容的保存、展示和编辑是否稳定。',
  });
  const duplicate = await store.findDuplicate({
    title: '记忆长内容显示测试',
    contentMarkdown: '用于验证长内容保存以后能否稳定显示，并且可以继续编辑。',
  });
  assert.equal(duplicate.memory.id, 'memory-long-text');
  assert.ok(duplicate.score >= .36);
  const unrelated = await store.findDuplicate({
    title: '睡眠习惯',
    contentMarkdown: '晚上需要尽量提前休息。',
  });
  assert.equal(unrelated, null);
});

function clock() {
  let minute = 0;
  return () => new Date(`2026-10-29T00:${String(minute++).padStart(2, '0')}:00.000Z`);
}
