import { proactiveVisibleText } from './proactive-response.mjs';

export class DeviceActionEventService {
  constructor({ deviceActionService, chatService, chatEventStore, intervalMs = 5000 }) {
    this.actions = deviceActionService;
    this.chatService = chatService;
    this.chatEventStore = chatEventStore;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
    void this.tick().catch(() => {});
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.running || this.chatService.isBusy()) return { skipped: 'busy' };
    this.running = true;
    try {
      let delivered = 0;
      for (const event of await this.actions.pendingResults()) {
        if (this.chatService.isBusy()) break;
        const receiptId = `device-action-result-${event.id}`;
        if (await this.chatEventStore.getById(receiptId)) {
          await this.actions.markEventDelivered(event.id);
          delivered += 1;
          continue;
        }
        const prompt = [
          'ETHERE DEVICE ACTION RESULT（内部事件，不是用户的新消息）',
          '你此前向手机提交的动作现在有结果。结合当前对话决定是否自然回应；可以保持沉默，沉默时最终只输出 ETHERE_SILENT。不要重复播报已经展示过的弹窗正文，也不要把内部 ID 告诉用户。失败时可以简短说明操作没送达。',
          JSON.stringify({ type: event.type, message: event.message || event.title, outcome: event.outcome, error: event.error || '', actions: event.actions || [] }),
        ].join('\n');
        const result = await this.chatService.sendMessage({ text: prompt, hidden: true, source: 'device-action' });
        if (result.status !== 'completed') throw new Error('设备动作结果未完成处理');
        const visible = proactiveVisibleText(result);
        await this.chatEventStore.append({
          id: receiptId, role: visible ? 'assistant' : 'notice', source: 'device-action',
          content: visible || '', status: 'completed', turnComplete: Boolean(visible),
        });
        await this.actions.markEventDelivered(event.id);
        delivered += 1;
      }
      return { delivered };
    } finally { this.running = false; }
  }
}
