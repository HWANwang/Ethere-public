import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { decodeImageDataUrl } from './attachments.mjs';

const IMAGE_EXTENSIONS = new Map([['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp']]);

export class SpaceStore {
  constructor({ dataRoot, idFactory = randomUUID } = {}) {
    if (!dataRoot) throw new Error('缺少空间数据目录');
    this.dataRoot = dataRoot;
    this.file = join(dataRoot, 'state', 'space', 'posts.json');
    this.imageRoot = join(dataRoot, 'attachments', 'space');
    this.idFactory = idFactory;
    this.posts = [];
    this.ready = false;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    if (this.ready) return;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      this.posts = Array.isArray(saved.posts) ? saved.posts.map(normalizeSavedPost).filter(Boolean) : [];
    } catch {
      this.posts = [];
    }
    this.ready = true;
  }

  async list({ author = 'all', start = '', end = '', limit = 100, includeArchived = false } = {}) {
    await this.initialize();
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const selected = this.posts
      .filter((post) => includeArchived || post.status === 'active')
      .filter((post) => author === 'all' || post.author === author)
      .filter((post) => !start || datePart(post.occurredAt) >= start)
      .filter((post) => !end || datePart(post.occurredAt) <= end)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    return { count: selected.length, posts: selected.slice(0, safeLimit).map(publicPost) };
  }

  async listAll({ offset = 0, limit = 200 } = {}) {
    await this.initialize();
    const ordered = [...this.posts].sort((a, b) => a.id.localeCompare(b.id));
    const start = Math.max(0, Number(offset) || 0);
    const pageSize = Math.max(1, Math.min(200, Number(limit) || 200));
    return { posts: ordered.slice(start, start + pageSize).map(publicPost), total: ordered.length,
      hasMore: start + pageSize < ordered.length };
  }

  async get(id, { includeArchived = false } = {}) {
    await this.initialize();
    const post = this.posts.find((item) => item.id === String(id || ''));
    return post && (includeArchived || post.status === 'active') ? publicPost(post) : null;
  }

  async create(input = {}, { author = 'user', source = 'manual' } = {}) {
    return this.#mutate(async () => {
      const contentMarkdown = normalizeContent(input.contentMarkdown ?? input.text);
      const images = Array.isArray(input.images) ? input.images : [];
      if (!contentMarkdown && !images.length) throw httpError(400, '动态内容不能为空');
      if (images.length > 9) throw httpError(400, '每条动态最多 9 张图片');
      const occurredAt = normalizeDate(input.occurredAt || new Date().toISOString());
      const now = new Date().toISOString();
      const post = {
        id: String(this.idFactory()), author: normalizeAuthor(author), contentMarkdown,
        occurredAt, status: 'active', revision: 1, source: String(source || 'manual'),
        images: [], createdAt: now, updatedAt: now,
      };
      post.images = await this.#saveImages(post, images);
      this.posts.push(post);
      await this.#save();
      return publicPost(post);
    });
  }

  async update(id, patch = {}, { baseRevision, author = '' } = {}) {
    return this.#mutate(async () => {
      const post = this.#requiredPost(id);
      if (author && post.author !== author) throw httpError(403, '不能修改其他作者的动态');
      assertRevision(post, baseRevision);
      const contentMarkdown = patch.contentMarkdown === undefined && patch.text === undefined
        ? post.contentMarkdown : normalizeContent(patch.contentMarkdown ?? patch.text);
      const occurredAt = patch.occurredAt === undefined ? post.occurredAt : normalizeDate(patch.occurredAt);
      let images = post.images;
      let addedImages = [];
      if (patch.images !== undefined) {
        if (!Array.isArray(patch.images) || patch.images.length > 9) throw httpError(400, '每条动态最多 9 张图片');
        const previous = new Map(post.images.map((image) => [image.id, image]));
        const used = new Set();
        const additions = [];
        const order = patch.images.map((item) => {
          if (!item?.id) { additions.push(item); return { addedIndex: additions.length - 1 }; }
          const existing = previous.get(String(item.id));
          if (!existing || used.has(existing.id)) throw httpError(400, '图片不属于这条动态或重复选择');
          used.add(existing.id);
          return { existing };
        });
        if (!contentMarkdown && !order.length) throw httpError(400, '动态内容不能为空');
        addedImages = await this.#saveImages({ ...post, occurredAt }, additions);
        images = order.map((entry) => entry.existing || addedImages[entry.addedIndex]);
      }
      if (!contentMarkdown && !images.length) throw httpError(400, '动态内容不能为空');
      const next = { ...post, contentMarkdown, occurredAt, images, revision: post.revision + 1, updatedAt: new Date().toISOString() };
      const index = this.posts.indexOf(post);
      this.posts[index] = next;
      try { await this.#save(); }
      catch (error) { this.posts[index] = post; await this.#removeImages(addedImages); throw error; }
      await this.#removeImages(post.images.filter((image) => !images.some((kept) => kept.id === image.id)));
      return publicPost(next);
    });
  }

  async archive(id, { baseRevision, author = '' } = {}) {
    return this.#mutate(async () => {
      const post = this.#requiredPost(id);
      if (author && post.author !== author) throw httpError(403, '不能删除其他作者的动态');
      assertRevision(post, baseRevision);
      post.status = 'archived';
      post.revision += 1;
      post.updatedAt = new Date().toISOString();
      await this.#save();
      return publicPost(post);
    });
  }

  async readImage(postId, imageId, variant = 'preview') {
    await this.initialize();
    const post = this.posts.find((item) => item.id === postId && item.status === 'active');
    const image = post?.images.find((item) => item.id === imageId);
    if (!image) throw httpError(404, '图片不存在');
    const relativePath = variant === 'original' ? image.originalPath : image.previewPath;
    const absolutePath = resolve(this.dataRoot, relativePath);
    const root = `${resolve(this.imageRoot)}${sep}`;
    if (!absolutePath.startsWith(root)) throw httpError(403, '图片路径无效');
    return { buffer: await readFile(absolutePath), mimeType: variant === 'original' ? image.mimeType : 'image/jpeg' };
  }

  async previewAttachments(postId) {
    await this.initialize();
    const post = this.posts.find((item) => item.id === String(postId || '') && item.status === 'active');
    if (!post) return [];
    const root = `${resolve(this.imageRoot)}${sep}`;
    return post.images.flatMap((image) => {
      const absolutePath = resolve(this.dataRoot, image.previewPath);
      if (!absolutePath.startsWith(root)) return [];
      return [{ type: 'image', absolutePath }];
    });
  }

  async #saveImages(post, images) {
    const directory = join(this.imageRoot, post.occurredAt.slice(0, 4), post.occurredAt.slice(5, 7), post.id);
    const saved = [];
    const written = [];
    try {
      for (const item of images) {
        const original = decodeImageDataUrl(item?.originalDataUrl, 12 * 1024 * 1024);
        const preview = decodeImageDataUrl(item?.previewDataUrl, 6 * 1024 * 1024);
        if (preview.mimeType !== 'image/jpeg') throw httpError(415, '预览图必须是 JPEG');
        await mkdir(directory, { recursive: true });
        const id = String(this.idFactory());
        const originalPath = join(directory, `${id}${IMAGE_EXTENSIONS.get(original.mimeType)}`);
        const previewPath = join(directory, `${id}.preview.jpg`);
        await writeFile(originalPath, original.buffer, { flag: 'wx' });
        written.push(originalPath);
        await writeFile(previewPath, preview.buffer, { flag: 'wx' });
        written.push(previewPath);
        saved.push({
          id, mimeType: original.mimeType, size: original.buffer.length, previewSize: preview.buffer.length,
          originalPath: relative(this.dataRoot, originalPath), previewPath: relative(this.dataRoot, previewPath),
        });
      }
    } catch (error) {
      await Promise.all(written.map((path) => unlink(path).catch(() => {})));
      throw error;
    }
    return saved;
  }

  async #removeImages(images) {
    const root = `${resolve(this.imageRoot)}${sep}`;
    for (const image of images) {
      for (const relativePath of [image.originalPath, image.previewPath]) {
        const absolutePath = resolve(this.dataRoot, relativePath);
        if (!absolutePath.startsWith(root)) continue;
        try { await unlink(absolutePath); }
        catch (error) { if (error.code !== 'ENOENT') console.warn('空间旧图清理失败', error); }
      }
    }
  }

  #requiredPost(id) {
    const post = this.posts.find((item) => item.id === String(id || '') && item.status === 'active');
    if (!post) throw httpError(404, '动态不存在');
    return post;
  }

  async #mutate(action) {
    await this.initialize();
    const run = this.writeQueue.then(action, action);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  async #save() {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, posts: this.posts }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, this.file);
  }
}

function publicPost(post) {
  return {
    id: post.id, author: post.author, contentMarkdown: post.contentMarkdown, occurredAt: post.occurredAt,
    status: post.status, revision: post.revision, source: post.source,
    images: post.images.map((image) => ({ id: image.id, mimeType: image.mimeType, size: image.size })),
    createdAt: post.createdAt, updatedAt: post.updatedAt,
  };
}

function normalizeSavedPost(value) {
  try {
    return {
      id: String(value.id), author: normalizeAuthor(value.author), contentMarkdown: normalizeContent(value.contentMarkdown),
      occurredAt: normalizeDate(value.occurredAt), status: value.status === 'archived' ? 'archived' : 'active',
      revision: Math.max(1, Number(value.revision) || 1), source: String(value.source || 'manual'),
      images: Array.isArray(value.images) ? value.images.map((image) => ({
        id: String(image.id), mimeType: String(image.mimeType), size: Number(image.size) || 0,
        previewSize: Number(image.previewSize) || 0, originalPath: String(image.originalPath), previewPath: String(image.previewPath),
      })).filter((image) => image.id && image.originalPath && image.previewPath) : [],
      createdAt: normalizeDate(value.createdAt || value.occurredAt), updatedAt: normalizeDate(value.updatedAt || value.createdAt || value.occurredAt),
    };
  } catch { return null; }
}

function normalizeAuthor(value) {
  if (value === 'user' || value === 'assistant') return value;
  throw httpError(400, '动态作者无效');
}
function normalizeContent(value) { return String(value || '').trim().slice(0, 20_000); }
function normalizeDate(value) { const date = new Date(value); if (Number.isNaN(date.getTime())) throw httpError(400, '动态时间无效'); return date.toISOString(); }
function datePart(value) { return String(value || '').slice(0, 10); }
function assertRevision(post, baseRevision) { if (Number(baseRevision) !== post.revision) { const error = httpError(409, '动态已发生变化，请刷新后重试'); error.currentRevision = post.revision; throw error; } }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
