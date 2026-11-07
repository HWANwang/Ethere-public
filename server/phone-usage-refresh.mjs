import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 20_000;

export class PhoneUsageRefresh {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, onDiagnostic = () => {} } = {}) {
    this.timeoutMs = timeoutMs;
    this.onDiagnostic = onDiagnostic;
    this.listeners = new Set();
    this.pending = new Map();
    this.pollClients = 0;
    this.lastPollAt = 0;
    this.queued = [];
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  channelStatus() {
    const connected = this.listeners.size > 0 || this.pollClients > 0 || Date.now() - this.lastPollAt <= 30_000;
    return { connected, lastContactAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null };
  }

  async poll(timeoutMs = 12_000) {
    this.lastPollAt = Date.now();
    this.pollClients += 1;
    try {
      const queued = this.queued.shift();
      if (queued) return queued;
      return await new Promise((resolve) => {
        const listener = (command) => { clearTimeout(timer); this.listeners.delete(listener); resolve(command); };
        const timer = setTimeout(() => { this.listeners.delete(listener); resolve(null); }, timeoutMs);
        this.listeners.add(listener);
      });
    } finally {
      this.pollClients -= 1;
    }
  }

  async request(lookbackMinutes = 120) {
    const id = randomUUID();
    const minutes = Math.max(5, Math.min(10_080, Number(lookbackMinutes) || 120));
    if (!this.channelStatus().connected) {
      this.record('channel-unavailable', { requestId: id, lookbackMinutes: minutes, error: '手机实时采集通道未连接' });
      throw httpError(503, '手机暂未连接实时采集通道，请打开 Ethere 后重试');
    }
    this.record('request-sent', { requestId: id, lookbackMinutes: minutes });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.record('timeout', { requestId: id, lookbackMinutes: minutes, error: '手机未在规定时间内返回' });
        reject(httpError(504, '手机未在规定时间内返回使用情况，请确认 Ethere 仍在运行'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, lookbackMinutes: minutes });
      if (!this.listeners.size) this.queued.push({ id, lookbackMinutes: minutes });
      for (const listener of this.listeners) {
        try { listener({ id, lookbackMinutes: minutes }); } catch { /* Other listeners can still receive it. */ }
      }
    });
  }

  complete(id, snapshot) {
    const pending = this.pending.get(String(id || ''));
    if (!pending) return false;
    this.pending.delete(id);
    this.queued = this.queued.filter((item) => item.id !== id);
    clearTimeout(pending.timer);
    this.record('snapshot-received', { requestId: id, lookbackMinutes: pending.lookbackMinutes });
    pending.resolve(snapshot);
    return true;
  }

  fail(id, message) {
    const pending = this.pending.get(String(id || ''));
    if (!pending) return false;
    this.pending.delete(id);
    this.queued = this.queued.filter((item) => item.id !== id);
    clearTimeout(pending.timer);
    this.record('phone-failed', { requestId: id, lookbackMinutes: pending.lookbackMinutes, error: message });
    pending.reject(httpError(502, String(message || '手机采集使用情况失败')));
    return true;
  }

  record(stage, details = {}) {
    try {
      void Promise.resolve(this.onDiagnostic(stage, {
        ...details, channelConnected: this.channelStatus().connected,
      })).catch(() => {});
    } catch { /* Diagnostics must never prevent a response. */ }
  }
}

function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
