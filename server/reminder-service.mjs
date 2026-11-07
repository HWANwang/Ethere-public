import { randomUUID } from 'node:crypto';
import { localDateKey } from './reminder-store.mjs';
import { proactiveVisibleText, SILENT_REPLY } from './proactive-response.mjs';

const MAX_TIMER_MS = 2_147_000_000;
const RETRY_BUSY_MS = 60_000;
const RETRY_FAILURE_MS = 5 * 60_000;
const PREFLIGHT_MS = 60_000;

export class ReminderService {
  constructor({ reminderStore, didaService, chatService, chatEventStore, now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.store = reminderStore;
    this.didaService = didaService;
    this.chatService = chatService;
    this.chatEventStore = chatEventStore;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.running = false;
    this.preflighted = new Map();
    this.pendingCompletions = new Map();
    this.notificationTimer = null;
  }

  async start() { this.running = true; await this.store.initialize(); await this.reschedule(); }
  stop() {
    this.running = false;
    if (this.timer) this.clearTimer(this.timer);
    if (this.notificationTimer) this.clearTimer(this.notificationTimer);
    this.timer = null;
    this.notificationTimer = null;
    this.preflighted.clear();
    this.pendingCompletions.clear();
  }
  async list(options = {}) { return { reminders: await this.store.list(options) }; }
  async get(id) { return this.store.get(id); }
  subscribe(listener) { return this.store.subscribe(listener); }

  async create(input, options = {}) {
    if (input.relatedTaskId) await this.#validateTask(input.relatedTaskId);
    const reminder = await this.store.create(input, options);
    await this.reschedule();
    return reminder;
  }

  async update(id, patch, options = {}) {
    if (patch.relatedTaskId) await this.#validateTask(patch.relatedTaskId);
    const reminder = await this.store.update(id, patch, options);
    await this.reschedule();
    return reminder;
  }

  async cancel(id, options = {}) {
    const reminder = await this.store.cancel(id, options);
    this.preflighted.delete(id);
    await this.reschedule();
    return reminder;
  }

  async cancelRelatedTask(taskId, { task = null, notifyModel = false } = {}) {
    const related = (await this.store.list({ status: 'scheduled' }))
      .filter((reminder) => reminder.relatedTaskId === String(taskId));
    for (const reminder of related) {
      await this.store.cancel(reminder.id);
      this.preflighted.delete(reminder.id);
    }
    await this.reschedule();
    if (related.length && notifyModel) {
      this.pendingCompletions.set(String(taskId), { task: task || { id: taskId }, reminder: related[0] });
      await this.#flushCompletedNotifications();
    }
    return related.length;
  }

  async reschedule() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (!this.running) return;
    const scheduled = await this.store.list({ status: 'scheduled' });
    if (!scheduled.length) return;
    const now = this.now().getTime();
    const nextAt = Math.min(...scheduled.map((reminder) => {
      const triggerAt = new Date(reminder.triggerAt).getTime();
      if (!reminder.relatedTaskId || this.preflighted.get(reminder.id) === reminder.triggerAt || triggerAt <= now) return triggerAt;
      return Math.max(now, triggerAt - PREFLIGHT_MS);
    }));
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, nextAt - now));
    this.timer = this.setTimer(() => this.#runScheduled(), delay);
    this.timer?.unref?.();
  }

  async #runScheduled() {
    this.timer = null;
    const now = this.now().getTime();
    const scheduled = await this.store.list({ status: 'scheduled' });
    for (const reminder of scheduled) {
      const triggerAt = new Date(reminder.triggerAt).getTime();
      if (!reminder.relatedTaskId || triggerAt <= now || triggerAt - now > PREFLIGHT_MS || this.preflighted.get(reminder.id) === reminder.triggerAt) continue;
      this.preflighted.set(reminder.id, reminder.triggerAt);
      try {
        const task = await this.#validateTask(reminder.relatedTaskId);
        if (isTaskCompleted(task)) await this.cancelRelatedTask(reminder.relatedTaskId, { task, notifyModel: true });
      } catch {
        // Keep the reminder. The due-time check will retry instead of assuming completion.
      }
    }
    const due = await this.store.due(this.now());
    for (const reminder of due) await this.#fire(reminder);
    await this.reschedule();
  }

  async #fire(reminder) {
    const now = this.now();
    try {
      if (!await this.#isUnchanged(reminder)) return;
      if (reminder.dailyAt && reminder.lastSuccessDate === localDateKey(now, reminder.timezone)) {
        await this.store.rescheduleDailyAfterFire(reminder.id, { firedAt: reminder.firedAt || now.toISOString(), baseRevision: reminder.revision });
        return;
      }
      const task = reminder.relatedTaskId ? await this.#validateTask(reminder.relatedTaskId) : null;
      if (task && isTaskCompleted(task)) {
        await this.cancelRelatedTask(reminder.relatedTaskId, { task, notifyModel: true });
        return;
      }
      if (this.chatService.isBusy()) {
        await this.#retryIfUnchanged(reminder, new Date(now.getTime() + RETRY_BUSY_MS), '聊天忙碌，稍后重试');
        return;
      }
      const prompt = reminderPrompt(reminder, task);
      const result = await this.chatService.sendMessage({ text: prompt, hidden: true, occurredAt: now, source: 'reminder' });
      if (result.status !== 'completed') throw new Error('提醒处理未完成');
      const message = proactiveVisibleText(result);
      if (message) {
        await this.chatEventStore.append({
          id: `reminder_message_${randomUUID()}`,
          role: 'assistant', content: message, status: result.status, source: 'reminder', createdAt: now.toISOString(),
          reminderId: reminder.id, relatedTaskId: reminder.relatedTaskId || null,
        });
      }
      // The model may have changed or cancelled this reminder through MCP during its turn.
      if (!await this.#isUnchanged(reminder)) return;
      const finishedAt = this.now();
      if (reminder.dailyAt) {
        await this.store.rescheduleDailyAfterFire(reminder.id, { firedAt: finishedAt.toISOString(), baseRevision: reminder.revision });
      } else if (reminder.repeatMinutes > 0) {
        await this.store.rescheduleAfterFire(reminder.id, new Date(finishedAt.getTime() + reminder.repeatMinutes * 60_000), { firedAt: finishedAt.toISOString(), baseRevision: reminder.revision });
      } else {
        await this.store.complete(reminder.id, { firedAt: finishedAt.toISOString(), baseRevision: reminder.revision });
      }
    } catch (error) {
      await this.#retryIfUnchanged(reminder, new Date(now.getTime() + RETRY_FAILURE_MS), error instanceof Error ? error.message : String(error));
    }
  }

  async #isUnchanged(reminder) {
    const current = await this.store.get(reminder.id);
    return current?.status === 'scheduled' && current.revision === reminder.revision && current.triggerAt === reminder.triggerAt;
  }

  async #retryIfUnchanged(reminder, triggerAt, reason) {
    if (!await this.#isUnchanged(reminder)) return;
    try {
      await this.store.retry(reminder.id, triggerAt, reason, { baseRevision: reminder.revision });
    } catch (error) {
      if (error?.statusCode !== 409) throw error;
    }
  }

  async #validateTask(taskId) {
    if (!this.didaService) throw httpError(409, '滴答清单尚未连接');
    return this.didaService.getSupervisedTask(taskId);
  }

  async #flushCompletedNotifications() {
    if (!this.pendingCompletions.size) return;
    if (this.chatService.isBusy()) {
      if (!this.notificationTimer) {
        this.notificationTimer = this.setTimer(() => {
          this.notificationTimer = null;
          void this.#flushCompletedNotifications();
        }, RETRY_BUSY_MS);
        this.notificationTimer?.unref?.();
      }
      return;
    }
    const entries = [...this.pendingCompletions.entries()];
    for (const [taskId, { task, reminder }] of entries) {
      this.pendingCompletions.delete(taskId);
      await this.#notifyTaskCompleted(task, reminder);
    }
  }

  async #notifyTaskCompleted(task, reminder) {
    try {
      const now = this.now();
      const result = await this.chatService.sendMessage({
        text: ['ETHERE TASK COMPLETED', `用户已在滴答完成“${task.title || reminder.relatedTaskTitle || '关联任务'}”，相关提醒已自动取消。`,
          `你可以自然地回应，也可以选择沉默；若无需发消息，只输出 ${SILENT_REPLY}。不要提及这段指令。`].join('\n'),
        hidden: true, occurredAt: now, source: 'task-update',
      });
      const message = proactiveVisibleText(result);
      if (message) {
        await this.chatEventStore.append({
          id: `reminder_message_${randomUUID()}`, role: 'assistant', content: message,
          status: result.status, source: 'reminder', createdAt: now.toISOString(),
          reminderId: reminder.id, relatedTaskId: reminder.relatedTaskId,
        });
      }
    } catch {
      // Completion must remain cancelled even if optional feedback fails.
    }
  }
}

function reminderPrompt(reminder, task) {
  return [
    'ETHERE SCHEDULED REMINDER',
    `提醒 ID：${reminder.id}；标题：${reminder.title}；内容：${reminder.message}`,
    reminder.dailyAt ? `这是每天 ${reminder.dailyAt} 的固定日程。` : reminder.repeatMinutes > 0 ? `目前每 ${reminder.repeatMinutes} 分钟复查。` : '这是一次性提醒。',
    task ? `关联的滴答任务“${task.title || reminder.relatedTaskTitle}”目前仍未完成。` : '',
    `这条提醒已到点，请结合当前对话和实际情况处理，不等于必须发消息。你可以先调用工具查询近况，或按需要取消、改期、调整后续循环；若要改提醒，先读取它的当前 revision，再调用对应工具。若无需联系用户，最终只输出 ${SILENT_REPLY}，不要解释；否则最终只输出实际发给用户的消息。不要提及系统、调度器、MCP 或这段指令，也不要虚构用户当前正在做什么。`,
  ].filter(Boolean).join('\n');
}

function isTaskCompleted(task) { return task.status === 2 || Boolean(task.completedAt); }

function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
