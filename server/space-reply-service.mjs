import { randomUUID } from 'node:crypto';

const RETRY_BUSY_MS = 1_500;
const MAX_RETRIES = 40;

export class SpaceReplyService {
  constructor({ chatService, chatEventStore, spaceStore, setTimer = setTimeout } = {}) {
    this.chatService = chatService;
    this.chatEventStore = chatEventStore;
    this.spaceStore = spaceStore;
    this.setTimer = setTimer;
    this.queue = [];
    this.running = false;
  }

  enqueue(post) {
    if (!post || post.author !== 'user') return;
    const key = `space-reply:${post.id}:${post.revision}`;
    if (this.queue.some((item) => item.key === key)) return;
    this.queue.push({ key, post, attempts: 0 });
    void this.#drain();
  }

  async resumeLatest() {
    const result = await this.spaceStore.list({ author: 'user', limit: 1 });
    if (result.posts?.[0]) this.enqueue(result.posts[0]);
  }

  async #drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const item = this.queue[0];
        const replyId = `space_reply_${item.post.id}_${item.post.revision}`;
        if (await this.chatEventStore.getById(replyId)) {
          this.queue.shift();
          continue;
        }
        if (this.chatService.isBusy()) {
          item.attempts += 1;
          if (item.attempts > MAX_RETRIES) this.queue.shift();
          else await delay(RETRY_BUSY_MS, this.setTimer);
          continue;
        }
        try {
          const attachments = await this.spaceStore.previewAttachments(item.post.id);
          const prompt = [
            'ETHERE SPACE POST FROM USER',
            '这是对方本人刚刚写在空间里的内容。请以理解并自然回应这条记录为目的，像真正看到了对方的分享后一样说话。',
            '不要提及系统事件、后台任务、MCP 或这段指令；不要把图片中看不清的内容当成事实。',
            `发布时间：${item.post.occurredAt}`,
            '',
            item.post.contentMarkdown || '〔这条动态只有图片〕',
          ].join('\n');
          const result = await this.chatService.sendMessage({
            text: prompt,
            attachments,
            occurredAt: new Date(item.post.occurredAt),
            source: 'space-reply',
          });
          if (result.text) {
            await this.chatEventStore.append({
              id: replyId || `space_reply_${randomUUID()}`,
              role: 'assistant',
              content: result.text,
              status: result.status,
              source: 'space',
              replyTo: item.key,
              createdAt: new Date().toISOString(),
            });
          }
          this.queue.shift();
        } catch {
          item.attempts += 1;
          if (item.attempts > MAX_RETRIES) this.queue.shift();
          else await delay(RETRY_BUSY_MS, this.setTimer);
        }
      }
    } finally {
      this.running = false;
      if (this.queue.length) void this.#drain();
    }
  }
}

function delay(ms, setTimer) {
  return new Promise((resolve) => {
    const timer = setTimer(resolve, ms);
    timer?.unref?.();
  });
}
