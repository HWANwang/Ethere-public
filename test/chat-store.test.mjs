import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatStore, createMemoryStorage } from '../web/chat-store.js';

test('starts with a safe demo message', () => {
  const store = createChatStore(createMemoryStorage());
  const messages = store.read();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
});

test('migrates the obsolete offline welcome after the backend is connected', () => {
  const storage = createMemoryStorage({
    'ethere.chat.v1': JSON.stringify([{ id: 'welcome', role: 'assistant', content: '这是一个离线演示壳', createdAt: '20:24' }]),
  });
  const messages = createChatStore(storage).read();
  assert.equal(messages[0].content, '晚上好。想聊什么？');
});

test('persists appended messages across store instances', () => {
  const storage = createMemoryStorage();
  const first = createChatStore(storage);
  first.append({ id: 'user-1', role: 'user', content: '你好', createdAt: '20:30' });

  const restored = createChatStore(storage).read();
  assert.equal(restored.length, 2);
  assert.equal(restored[1].content, '你好');
});

test('appending a tool activity preserves the currently visible streaming text', () => {
  const store = createChatStore(createMemoryStorage());
  const messages = store.append({ id: 'reply-1', role: 'assistant', content: '', createdAt: '20:30' });
  messages[1].content = '先说的一段话';
  const next = store.append({ id: 'tool-1', role: 'activity', content: '已调用工具', createdAt: '20:31' }, messages);
  assert.equal(next[1].content, '先说的一段话');
  assert.equal(store.read()[1].content, '先说的一段话');
});

test('falls back when saved data is invalid', () => {
  const storage = createMemoryStorage({ 'ethere.chat.v1': '{broken' });
  const messages = createChatStore(storage).read();
  assert.equal(messages[0].id, 'welcome');
});

test('persists a local image attachment with its message', () => {
  const storage = createMemoryStorage();
  const store = createChatStore(storage);
  store.append({
    id: 'image-1',
    role: 'user',
    content: '看看这张图',
    createdAt: '20:31',
    attachment: { type: 'image', name: 'demo.png', dataUrl: 'data:image/png;base64,AAAA' },
  });

  const restored = createChatStore(storage).read();
  assert.equal(restored.at(-1).attachment.name, 'demo.png');
  assert.match(restored.at(-1).attachment.dataUrl, /^data:image\//);
});

test('a full phone cache cannot turn a received reply into a failed send', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    removeItem: (key) => values.delete(key),
    setItem(key, value) { if (value.length > 220) throw new Error('QuotaExceededError'); values.set(key, value); },
  };
  const store = createChatStore(storage);
  const messages = [
    { id: 'old-1', role: 'assistant', content: '旧内容'.repeat(100) },
    { id: 'new-1', role: 'assistant', content: '新内容' },
  ];
  assert.doesNotThrow(() => store.write(messages));
  assert.deepEqual(store.read().map((item) => item.id), ['new-1']);
  assert.equal(messages.length, 2);
});
