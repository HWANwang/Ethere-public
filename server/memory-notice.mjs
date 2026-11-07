import { randomUUID } from 'node:crypto';

export async function appendMemoryNotice(chatEventStore, action) {
  if (!chatEventStore) return null;
  const verb = action === 'revised' ? '已更新记忆' : action === 'promoted' ? '已升级为核心记忆' : '已创建记忆';
  return chatEventStore.append({
    id: randomUUID(),
    role: 'notice',
    source: 'memory',
    content: verb,
    status: 'completed',
  });
}
