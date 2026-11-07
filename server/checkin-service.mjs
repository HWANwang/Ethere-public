import { randomUUID } from 'node:crypto';
import { proactiveVisibleText, SILENT_REPLY } from './proactive-response.mjs';

const CHECKIN_PROMPT = `这是一次 Ethere 主动联系的机会，不是必须发消息。结合当前对话和已生效的人设，自主决定是否先查看近况；可以连续调用几个现有的读取工具，也可以维护按需记忆或提醒，再判断要不要联系用户。工具调用会正常显示在聊天里，即使最后选择不发消息。不要为了填满时间而调用工具，尽量在几分钟内结束；用户来聊天时要让位。核心记忆、人设和滴答任务仍按原有审批流程，不要在静默维护中修改；不要自行派发开发任务。可以借这次机会发起来电或监督弹窗，但它们本身已经是联系，不要再发一条重复的聊天气泡。若决定不发聊天消息，最终只输出 ${SILENT_REPLY}，不要解释；若决定发聊天消息，最终只输出要发给用户的内容。不要提及轮询、系统任务或这段指令；不要虚构你看到了用户正在做什么。`;

export class CheckinService {
  constructor({ configStore, chatService, chatEventStore, random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.configStore = configStore;
    this.chatService = chatService;
    this.chatEventStore = chatEventStore;
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.running = false;
    this.nextAt = null;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastOutcome = null;
    this.lastError = null;
  }

  async start() {
    this.running = true;
    await this.reschedule();
  }

  stop() {
    this.running = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.nextAt = null;
  }

  async reschedule() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.nextAt = null;
    if (!this.running) return this.status();
    const settings = await this.configStore.getSettings();
    if (!settings.checkin.enabled) return this.status(settings);
    const delayMs = pickDelayMs(settings.checkin, this.random);
    this.nextAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = this.setTimer(() => { void this.#run(); }, delayMs);
    this.timer?.unref?.();
    return this.status(settings);
  }

  async status(settings = null) {
    const current = settings || await this.configStore.getSettings();
    return {
      enabled: current.checkin.enabled,
      nextAt: this.nextAt,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastOutcome: this.lastOutcome,
      lastError: this.lastError,
    };
  }

  async #run() {
    this.timer = null;
    this.nextAt = null;
    const occurredAt = new Date();
    this.lastRunAt = occurredAt.toISOString();
    this.lastError = null;
    try {
      if (this.chatService.isBusy()) {
        this.lastOutcome = 'skipped_busy';
        return;
      }
      const runId = randomUUID();
      let activityWrites = Promise.resolve();
      let contactedByDeviceAction = false;
      const result = await this.chatService.sendMessage({ text: CHECKIN_PROMPT, hidden: true, occurredAt, source: 'checkin' }, (event) => {
        if (event?.type !== 'activity') return;
        if (event.status === 'completed' && ['ethere_incoming_call', 'show_attention_popup'].includes(event.tool)) {
          contactedByDeviceAction = true;
          return; // 设备动作服务会写可见的来电／弹窗记录，避免重复两张卡。
        }
        activityWrites = activityWrites.then(() => this.chatEventStore.append({
          id: `checkin-activity-${runId}-${event.callId || randomUUID()}`,
          role: 'activity', source: 'checkin', content: event.content, status: event.status,
          ...(event.approval ? { approval: event.approval } : {}),
          ...(event.card ? { card: event.card } : {}),
        }));
      });
      await activityWrites;
      if (result.status === 'interrupted') {
        this.lastOutcome = 'interrupted';
        return;
      }
      if (result.status !== 'completed') throw new Error('主动联系未完成');
      const message = proactiveVisibleText(result);
      if (message) {
        await this.chatEventStore.append({
          id: `checkin_${randomUUID()}`,
          role: 'assistant',
          content: message,
          status: result.status,
          source: 'checkin',
          createdAt: occurredAt.toISOString(),
        });
        this.lastSuccessAt = new Date().toISOString();
        this.lastOutcome = 'sent';
      } else {
        this.lastOutcome = contactedByDeviceAction ? 'contacted' : 'silent';
      }
    } catch (error) {
      this.lastOutcome = 'failed';
      this.lastError = error instanceof Error ? error.message : String(error || '主动联系失败');
    } finally {
      if (this.running) await this.reschedule();
    }
  }
}
export function pickDelayMs({ minMinutes, maxMinutes }, random = Math.random) {
  const min = Math.max(1, Number(minMinutes) || 1) * 60_000;
  const max = Math.max(min, (Number(maxMinutes) || Number(minMinutes) || 1) * 60_000);
  return min + Math.floor(Math.max(0, Math.min(0.999999999, random())) * (max - min + 1));
}
