import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SpaceStore } from '../server/space-store.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const JPEG = 'data:image/jpeg;base64,/9j/2Q==';

test('space store persists stable authors without storing a configurable display name', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-space-'));
  const ids = ['post-1'];
  const store = new SpaceStore({ dataRoot, idFactory: () => ids.shift() });
  const post = await store.create({ contentMarkdown: '**今天**完成了一点。', occurredAt: '2026-10-29T12:00:00+08:00' }, { author: 'assistant', source: 'mcp' });
  assert.equal(post.author, 'assistant');
  assert.equal(post.contentMarkdown, '**今天**完成了一点。');
  assert.equal('bossName' in post, false);
  const reloaded = new SpaceStore({ dataRoot });
  assert.equal((await reloaded.list()).posts[0].author, 'assistant');
});

test('space images preserve original bytes and keep a separate preview', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-space-'));
  const ids = ['post-image', 'image-1'];
  const store = new SpaceStore({ dataRoot, idFactory: () => ids.shift() });
  const post = await store.create({ contentMarkdown: '有图', images: [{ originalDataUrl: PNG, previewDataUrl: JPEG }] }, { author: 'user' });
  const original = await store.readImage(post.id, post.images[0].id, 'original');
  const preview = await store.readImage(post.id, post.images[0].id, 'preview');
  assert.deepEqual(original.buffer, Buffer.from(PNG.split(',')[1], 'base64'));
  assert.deepEqual(preview.buffer, Buffer.from(JPEG.split(',')[1], 'base64'));
  assert.notDeepEqual(original.buffer, preview.buffer);
});

test('space image edits can append, retain, reorder, and remove images after saving', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-space-'));
  const ids = ['post-edit', 'image-1', 'image-2', 'image-3'];
  const store = new SpaceStore({ dataRoot, idFactory: () => ids.shift() });
  const created = await store.create({ contentMarkdown: '', images: [{ originalDataUrl: PNG, previewDataUrl: JPEG }] }, { author: 'user' });
  const firstId = created.images[0].id;
  const appended = await store.update(created.id, {
    images: [{ id: firstId }, { originalDataUrl: PNG, previewDataUrl: JPEG }],
  }, { baseRevision: created.revision });
  assert.deepEqual(appended.images.map((image) => image.id), ['image-1', 'image-2']);
  assert.deepEqual((await store.readImage(created.id, 'image-2', 'original')).buffer, Buffer.from(PNG.split(',')[1], 'base64'));

  const oldPath = JSON.parse(await readFile(join(dataRoot, 'state', 'space', 'posts.json'), 'utf8')).posts[0].images[0].originalPath;
  const replaced = await store.update(created.id, {
    images: [{ originalDataUrl: PNG, previewDataUrl: JPEG }, { id: 'image-2' }],
  }, { baseRevision: appended.revision });
  assert.deepEqual(replaced.images.map((image) => image.id), ['image-3', 'image-2']);
  await assert.rejects(() => store.readImage(created.id, firstId, 'original'), /图片不存在/);
  await assert.rejects(() => readFile(join(dataRoot, oldPath)), { code: 'ENOENT' });
  assert.equal((await store.list()).posts[0].images.length, 2);

  await assert.rejects(() => store.update(created.id, { images: [{ id: firstId }] }, { baseRevision: replaced.revision }), /图片不属于这条动态/);
  await assert.rejects(() => store.update(created.id, { images: [{ id: 'image-2' }, { id: 'image-2' }] }, { baseRevision: replaced.revision }), /重复选择/);
  await assert.rejects(() => store.update(created.id, { images: [] }, { baseRevision: replaced.revision }), /动态内容不能为空/);
});

test('space updates use revisions, assistant writes cannot edit user posts, and deletion is soft', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-space-'));
  const ids = ['post-user'];
  const store = new SpaceStore({ dataRoot, idFactory: () => ids.shift() });
  const post = await store.create({ contentMarkdown: '原文' }, { author: 'user' });
  await assert.rejects(() => store.update(post.id, { contentMarkdown: '冒充修改' }, { baseRevision: 1, author: 'assistant' }), /不能修改其他作者/);
  const updated = await store.update(post.id, { contentMarkdown: '新内容' }, { baseRevision: 1 });
  assert.equal(updated.revision, 2);
  await assert.rejects(() => store.update(post.id, { contentMarkdown: '过期' }, { baseRevision: 1 }), /已发生变化/);
  await store.archive(post.id, { baseRevision: 2 });
  assert.equal((await store.list()).count, 0);
  assert.equal((await store.list({ includeArchived: true })).posts[0].status, 'archived');
  const saved = JSON.parse(await readFile(join(dataRoot, 'state', 'space', 'posts.json'), 'utf8'));
  assert.equal(saved.posts[0].status, 'archived');
});
