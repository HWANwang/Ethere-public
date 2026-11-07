import { spawn } from 'node:child_process';

const REQUEST_TIMEOUT_MS = 60_000;

export class CodexAppServerClient {
  constructor({
    command = process.env.ETHERE_CODEX_COMMAND || 'codex',
    env = process.env,
    appServerArgs = [],
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    spawnProcess = spawnCodex,
  } = {}) {
    this.command = command;
    this.env = normalizeRuntimeEnvironment(env);
    this.appServerArgs = Array.isArray(appServerArgs) ? [...appServerArgs] : [];
    this.requestTimeoutMs = requestTimeoutMs;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.listeners = new Set();
    this.readyPromise = null;
    this.stderrTail = '';
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.#initialize();
    try {
      return await this.readyPromise;
    } catch (error) {
      this.readyPromise = null;
      throw error;
    }
  }

  async #initialize() {
    this.#startProcess();
    await this.request('initialize', {
      clientInfo: { name: 'ethere', title: 'Ethere', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', null);
  }

  #startProcess() {
    if (this.child && !this.child.killed) return;
    const child = this.spawnProcess(this.command, this.env, this.appServerArgs);
    this.child = child;
    this.buffer = '';
    this.stderrTail = '';
    child.stdout.on('data', (chunk) => this.#consumeStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-8_000);
    });
    child.on('error', (error) => this.#handleClose(error));
    child.on('close', (code) => this.#handleClose(new Error(
      `Codex app-server 已退出 (${code ?? 'unknown'})${this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ''}`,
    )));
  }

  #consumeStdout(chunk) {
    this.buffer += chunk.toString('utf8');
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.#handleMessage(JSON.parse(line));
      } catch {
        // app-server may write non-protocol diagnostics; stderr is retained separately.
      }
    }
  }

  #handleMessage(message) {
    const key = message?.id == null ? '' : String(message.id);
    if (key && this.pending.has(key) && !message.method) {
      const pending = this.pending.get(key);
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex RPC 请求失败'));
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  #handleClose(error) {
    if (!this.child) return;
    this.child = null;
    this.readyPromise = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: 'ethere/appServerClosed', params: { error: error?.message || 'Codex app-server 已断开' } });
  }

  request(method, params) {
    if (!this.child?.stdin?.writable) throw new Error('Codex app-server 尚未启动');
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC 超时：${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return response;
  }

  notify(method, params) {
    if (!this.child?.stdin?.writable) throw new Error('Codex app-server 尚未启动');
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id, result) {
    if (!this.child?.stdin?.writable) throw new Error('Codex app-server 尚未启动');
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  async close() {
    const child = this.child;
    this.child = null;
    this.readyPromise = null;
    if (!child) return;
    child.stdin.end();
    child.kill();
  }
}

function normalizeRuntimeEnvironment(env) {
  const normalized = { ...env };
  if (process.platform !== 'win32' || normalized.HOME) return normalized;
  const userHome = normalized.USERPROFILE
    || (normalized.HOMEDRIVE && normalized.HOMEPATH ? `${normalized.HOMEDRIVE}${normalized.HOMEPATH}` : '');
  if (userHome) normalized.HOME = userHome;
  return normalized;
}

function spawnCodex(command, env, appServerArgs = []) {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', command, 'app-server', ...appServerArgs], {
      env: { ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
  return spawn(command, ['app-server', ...appServerArgs], {
    env: { ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
