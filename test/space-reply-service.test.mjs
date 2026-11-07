import assert from 'node:assert/strict';
import test from 'node:test';
import { SpaceReplyService } from '../server/space-reply-service.mjs';

test('a user space post becomes one model-visible comment without duplicating on retry', async () => {
  const events = [];
  const prompts = [];
  const chatEventStore = {
    async getById(id) { return events.find((event) => event.id === id) || null; },
    async append(event) { events.push(event); return event; },
  };
  const service = new SpaceReplyService({
    chatEventStore,
    spaceStore: { async previewAttachments() { return [{ type: 'image', path: 'preview.jpg' }]; } },
    chatService: {
      isBusy() { return false; },
      async sendMessage(message) { prompts.push(message); return { text: '我看到了。', status: 'completed' }; },
    },
  });
  const post = { id: 'post-1', revision: 1, author: 'user', occurredAt: '2026-10-30T12:00:00.000Z', contentMarkdown: '今天重新开始。' };

  service.enqueue(post);
  await waitFor(() => events.length === 1);
  service.enqueue(post);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'space');
  assert.equal(events[0].content, '我看到了。');
  assert.match(prompts[0].text, /对方本人刚刚写在空间里的内容/);
  assert.equal(prompts[0].attachments.length, 1);
});

async function waitFor(predicate) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('timed out waiting for space reply');
}
