const DEFAULT_MESSAGES = [
  {
    id: 'welcome',
    role: 'assistant',
    content: '晚上好。想聊什么？',
    createdAt: '20:24',
  },
];

function cloneMessages(messages) {
  return messages.map((message) => ({ ...message }));
}

export function createChatStore(storage, key = 'ethere.chat.v1') {
  function read() {
    try {
      const parsed = JSON.parse(storage.getItem(key));
      if (Array.isArray(parsed) && parsed.every((item) => item && item.id && item.role)) {
        return cloneMessages(parsed.map((item) => item.id === 'welcome' && /离线演示壳/.test(item.content || '')
          ? { ...item, content: DEFAULT_MESSAGES[0].content }
          : item));
      }
    } catch {
      // Invalid local data falls back to the safe demo conversation.
    }
    return cloneMessages(DEFAULT_MESSAGES);
  }

  function write(messages) {
    // 电脑端事件库保存原始聊天；手机本地只缓存近期页面，不能让配额耗尽打断回复流。
    let recent = messages.slice(-300);
    while (recent.length) {
      const serialized = JSON.stringify(recent);
      if (serialized.length <= 2_000_000 || recent.length === 1) {
        try { storage.setItem(key, serialized); break; }
        catch { /* 存储配额不足时继续缩小近期缓存。 */ }
      }
      if (recent.length === 1) break;
      recent = recent.slice(Math.max(1, Math.ceil(recent.length / 3)));
    }
    return cloneMessages(messages);
  }

  function append(message, currentMessages = read()) {
    return write([...currentMessages, message]);
  }

  function reset() {
    storage.removeItem(key);
    return read();
  }

  return { append, read, reset, write };
}

export function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}
