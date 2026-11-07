import { spawn } from 'node:child_process';

export class VoiceCodexClient {
  constructor({ command = process.env.VOICE_LAB_CODEX || 'codex' } = {}) {
    this.command = command;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.listeners = new Set();
    this.closeListeners = new Set();
    this.ready = null;
    this.nextId = 0;
    this.stderrTail = '';
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async initialize() {
    if (this.ready) return this.ready;
    this.ready = this.#initialize().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }

  async #initialize() {
    const child = spawn(this.command, ['app-server', '--listen', 'stdio://'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child = child;
    this.buffer = '';
    this.stderrTail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#consume(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2000); });
    const fail = error => this.#closed(child, error);
    child.on('error', fail);
    child.on('close', code => fail(new Error(`Codex app-server 已退出（${code ?? 'unknown'}）`)));
    await this.request('initialize', {
      clientInfo: { name: 'ethere_voice_lab', title: 'Ethere Voice Lab', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', null);
  }

  #consume(chunk) {
    this.buffer += chunk;
    for (;;) {
      const pos = this.buffer.indexOf('\n');
      if (pos < 0) break;
      const line = this.buffer.slice(0, pos).trim();
      this.buffer = this.buffer.slice(pos + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id != null && !message.method && this.pending.has(String(message.id))) {
        const pending = this.pending.get(String(message.id));
        this.pending.delete(String(message.id));
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || 'Codex 请求失败'));
        else pending.resolve(message.result);
      } else {
        for (const listener of this.listeners) listener(message);
      }
    }
  }

  #closed(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
  }

  request(method, params, timeoutMs = 30_000) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error('Codex app-server 未连接'));
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (!error || !this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Codex 通道写入失败'));
      });
    });
  }

  notify(method, params) {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server 未连接');
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }

  respond(id, result) {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server 未连接');
    this.child.stdin.write(JSON.stringify({ id, result }) + '\n');
  }

  close() {
    this.child?.kill();
  }
}
