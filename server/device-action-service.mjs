import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_ACTIONS = 300;

export class DeviceActionService {
  constructor({ dataRoot, now = () => Date.now() }) {
    if (!dataRoot) throw new Error('缺少设备动作数据目录');
    this.file = join(dataRoot, 'state', 'device-actions.json');
    this.now = now;
    this.actions = null;
    this.chain = Promise.resolve();
    this.waiters = new Set();
  }

  async createPopup({ message, actions }) {
    return this.#write(async () => {
      if (this.actions.some((item) => item.type === 'attention_popup' && !['resolved', 'failed', 'cancelled'].includes(item.state))) {
        throw httpError(409, '已有监督弹窗，不能叠加');
      }
      const cleanMessage = requiredText(message, 500, '弹窗内容');
      if (!Array.isArray(actions) || !actions.length || actions.length > 4) throw httpError(400, '请提供 1～4 个操作按钮');
      const cleanActions = actions.map((item) => ({ id: requiredText(item?.id, 40, '按钮 ID'), label: requiredText(item?.label, 20, '按钮文字') }));
      if (new Set(cleanActions.map((item) => item.id)).size !== cleanActions.length || cleanActions.some((item) => item.id === 'dismissed')) throw httpError(400, '按钮 ID 不能重复或使用 dismissed');
      return this.#insert({ type: 'attention_popup', message: cleanMessage, actions: cleanActions });
    });
  }

  async createCall({ title = 'Ethere', openingText = '喂，用户，我在。', triggerAt = '', snoozeMinutes = 10, reminderId = '' } = {}) {
    return this.#write(async () => {
      const callTitle = requiredText(title, 80, '来电标题');
      const opening = requiredText(openingText, 1600, '接通开场语');
      const time = triggerAt ? Date.parse(triggerAt) : this.now();
      if (!Number.isFinite(time) || time < this.now() - 60_000 || time > this.now() + 365 * 86400_000) throw httpError(400, '来电时间无效');
      const delay = Number.isInteger(snoozeMinutes) && snoozeMinutes >= 1 && snoozeMinutes <= 1440 ? snoozeMinutes : 10;
      return this.#insert({ type: 'incoming_call', title: callTitle, openingText: opening, triggerAt: new Date(Math.max(this.now(), time)).toISOString(), snoozeMinutes: delay, reminderId: String(reminderId || '').slice(0, 100) });
    });
  }

  async cancelCall(id) {
    return this.#write(async () => {
      const original = this.actions.find((item) => item.id === id && item.type === 'incoming_call');
      if (!original) throw httpError(404, '来电不存在');
      if (['resolved', 'failed', 'cancelled'].includes(original.state)) return publicAction(original);
      if (this.actions.some((item) => item.type === 'incoming_call_cancel' && item.targetId === id && !['resolved', 'failed'].includes(item.state))) return publicAction(original);
      return this.#insert({ type: 'incoming_call_cancel', targetId: id });
    });
  }

  async poll(timeoutMs = 12000) {
    await this.chain;
    await this.#load();
    const queued = this.actions.find((item) => item.state === 'queued');
    if (queued) return publicAction(queued);
    return new Promise((resolve) => {
      const waiter = (action) => { clearTimeout(timer); this.waiters.delete(waiter); resolve(publicAction(action)); };
      const timer = setTimeout(() => { this.waiters.delete(waiter); resolve(null); }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  async acknowledge(id, state) {
    return this.#write(async () => {
      const item = this.actions.find((entry) => entry.id === id);
      if (!item) throw httpError(404, '设备动作不存在');
      const allowed = item.type === 'incoming_call' ? ['scheduled', 'displaying'] : ['displaying'];
      if (!allowed.includes(state)) throw httpError(400, '设备动作状态无效');
      if (item.state === 'queued') { item.state = state; item.updatedAt = new Date(this.now()).toISOString(); }
      return publicAction(item);
    });
  }

  async resolve(id, outcome, error = '', triggerAt = '') {
    return this.#write(async () => {
      const item = this.actions.find((entry) => entry.id === id);
      if (!item) throw httpError(404, '设备动作不存在');
      if (['resolved', 'failed', 'cancelled'].includes(item.state)) return { action: publicAction(item), duplicate: true };
      const valid = item.type === 'incoming_call_cancel' ? ['cancelled', 'failed'] : item.type === 'attention_popup'
        ? ['dismissed', 'failed', ...item.actions.map((choice) => choice.id)]
        : ['answered', 'snoozed', 'ended', 'failed'];
      if (!valid.includes(outcome)) throw httpError(400, '设备动作结果无效');
      item.state = outcome === 'failed' ? 'failed' : outcome === 'snoozed' ? 'scheduled' : 'resolved';
      if (outcome === 'snoozed' && Number.isFinite(Date.parse(triggerAt))) item.triggerAt = new Date(triggerAt).toISOString();
      item.outcome = outcome;
      item.error = String(error || '').slice(0, 300);
      item.updatedAt = new Date(this.now()).toISOString();
      if (item.type === 'incoming_call_cancel' && outcome === 'cancelled') {
        const target = this.actions.find((entry) => entry.id === item.targetId && entry.type === 'incoming_call');
        if (target && !['resolved', 'failed', 'cancelled'].includes(target.state)) {
          target.state = 'cancelled';
          target.outcome = 'cancelled';
          target.updatedAt = item.updatedAt;
        }
      }
      return { action: publicAction(item), duplicate: false };
    });
  }

  async pendingResults() {
    await this.chain;
    await this.#load();
    return this.actions.filter((item) => ['resolved', 'failed'].includes(item.state) && !item.eventDelivered).map(publicAction);
  }

  async markEventDelivered(id) {
    return this.#write(async () => {
      const item = this.actions.find((entry) => entry.id === id);
      if (!item) throw httpError(404, '设备动作不存在');
      item.eventDelivered = true;
      return publicAction(item);
    });
  }

  async #insert(data) {
    const now = new Date(this.now()).toISOString();
    const action = { id: randomUUID(), ...data, state: 'queued', outcome: '', error: '', eventDelivered: data.type === 'incoming_call_cancel', createdAt: now, updatedAt: now };
    this.actions.push(action);
    this.actions = this.actions.slice(-MAX_ACTIONS);
    return publicAction(action);
  }

  async #load() {
    if (this.actions) return;
    try { const saved = JSON.parse(await readFile(this.file, 'utf8')); this.actions = Array.isArray(saved) ? saved : []; }
    catch { this.actions = []; }
    for (const cancellation of this.actions) {
      if (cancellation.type !== 'incoming_call_cancel' || cancellation.state !== 'resolved' || cancellation.outcome !== 'cancelled') continue;
      const target = this.actions.find((item) => item.id === cancellation.targetId && item.type === 'incoming_call');
      if (target && !['resolved', 'failed', 'cancelled'].includes(target.state)) {
        target.state = 'cancelled';
        target.outcome = 'cancelled';
        target.updatedAt = cancellation.updatedAt;
      }
    }
  }

  async #write(operation) {
    const work = this.chain.then(async () => {
      await this.#load();
      const result = await operation();
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(this.actions), 'utf8');
      await rename(temp, this.file);
      if (result?.state === 'queued') {
        for (const waiter of [...this.waiters]) waiter(result);
      }
      return result;
    });
    this.chain = work.catch(() => {});
    return work;
  }
}

function publicAction(action) { return { ...action, actions: action.actions?.map((item) => ({ ...item })) }; }
function requiredText(value, max, label) { const text = String(value || '').trim(); if (!text || text.length > max) throw httpError(400, `${label}长度需为 1～${max} 字`); return text; }
function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
