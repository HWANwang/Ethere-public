import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { CodexAppServerClient } from './codex-app-server-client.mjs';
import { DeveloperTaskStore } from './developer-task-store.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'waiting_input', 'waiting_approval']);
const MAX_INSTRUCTION = 20_000;

export class DeveloperTaskManager {
  constructor({ dataRoot, allowedRoots, client = new CodexAppServerClient(), store = new DeveloperTaskStore({ dataRoot }) }) {
    if (!dataRoot) throw new Error('开发代理桥必须指定 ETHERE_DATA_DIR');
    if (!Array.isArray(allowedRoots) || !allowedRoots.length) throw new Error('开发代理桥必须设置项目目录白名单');
    this.dataRoot = dataRoot;
    this.allowedRoots = allowedRoots;
    this.client = client;
    this.store = store;
    this.ready = false;
    this.running = null;
    this.processing = false;
    this.unsubscribe = null;
    this.messageChain = Promise.resolve();
  }

  async initialize() {
    if (this.ready) return;
    await this.store.initialize();
    this.allowedRoots = await Promise.all(this.allowedRoots.map((root) => realpath(root)));
    this.unsubscribe = this.client.onMessage((message) => {
      this.messageChain = this.messageChain.then(() => this.#handleMessage(message)).catch((error) => {
        if (this.running) this.running.reject(error);
      });
    });
    for (const task of await this.store.list({ limit: 100 })) {
      if (task.status !== 'running') continue;
      // A process crash can occur after a write but before its callback. Never infer success
      // from prose or rerun an uncertain write automatically.
      const recovered = await this.store.put({ ...task, status: 'waiting_input', blocker: '代理桥曾中断；原回合结果不确定，请核对工作目录后在同一任务继续。' });
      await this.#emitEvent(recovered);
    }
    this.ready = true;
    this.#schedule();
  }

  async create({ title, cwd, instruction, model = '', permission = 'workspaceWrite' }) {
    await this.initialize();
    const checked = await this.#validate({ title, cwd, instruction, model, permission });
    const now = new Date().toISOString();
    const task = await this.store.put({
      id: randomUUID(), ...checked, threadId: '', turnId: '', generation: 1,
      status: 'queued', resultSummary: '', files: [], tests: [], blocker: '',
      createdAt: now, updatedAt: now,
    });
    this.#schedule();
    return publicTask(task);
  }

  async get(id) {
    await this.initialize();
    const task = await this.store.get(id);
    if (!task) throw taskError(404, '开发任务不存在');
    return publicTask(task);
  }

  async list() {
    await this.initialize();
    return (await this.store.list()).map(publicTask);
  }

  async send(id, instruction) {
    await this.initialize();
    const task = await this.store.get(id);
    if (!task) throw taskError(404, '开发任务不存在');
    if (!TERMINAL.has(task.status) || task.status === 'cancelled') throw taskError(409, '任务仍在运行或已取消');
    await this.#validateWorkDirectory(task.cwd);
    const text = String(instruction || '').trim();
    if (!text || text.length > MAX_INSTRUCTION) throw taskError(400, '追加指令不能为空且不能超过 20000 字');
    const revised = await this.store.put({ ...task, instruction: text, generation: task.generation + 1,
      status: 'queued', turnId: '', blocker: '', resultSummary: '', files: [], tests: [] });
    this.#schedule();
    return publicTask(revised);
  }

  async cancel(id) {
    await this.initialize();
    const task = await this.store.get(id);
    if (!task) throw taskError(404, '开发任务不存在');
    if (task.status === 'cancelled') return publicTask(task);
    if (task.status === 'running' && this.running?.taskId === id) {
      this.running.cancelRequested = true;
      if (task.turnId) await this.client.request('turn/interrupt', { threadId: task.threadId, turnId: task.turnId });
      return publicTask(await this.store.get(id));
    }
    const cancelled = await this.store.put({ ...task, status: 'cancelled', blocker: '任务已取消' });
    await this.#emitEvent(cancelled);
    return publicTask(cancelled);
  }

  async pendingEvents() { await this.initialize(); return this.store.pendingEvents(); }
  async acknowledgeEvent(id) { await this.initialize(); return this.store.acknowledgeEvent(id); }
  async close() { this.unsubscribe?.(); await this.client.close(); await this.store.close(); }

  async #validate({ title, cwd, instruction, model, permission }) {
    const normalizedTitle = String(title || '').trim().slice(0, 120);
    const normalizedInstruction = String(instruction || '').trim();
    const normalizedModel = String(model || '').trim();
    if (!normalizedTitle || !normalizedInstruction || normalizedInstruction.length > MAX_INSTRUCTION) throw taskError(400, '标题和 1–20000 字任务要求必填');
    if (normalizedModel.length > 120) throw taskError(400, '模型名称过长');
    if (!['readOnly', 'workspaceWrite'].includes(permission)) throw taskError(400, '权限仅支持 readOnly 或 workspaceWrite');
    if (!isAbsolute(String(cwd || ''))) throw taskError(400, '工作目录必须是绝对路径');
    const actual = await this.#validateWorkDirectory(cwd);
    return { title: normalizedTitle, cwd: actual, instruction: normalizedInstruction, model: normalizedModel, permission };
  }

  async #validateWorkDirectory(cwd) {
    if (!isAbsolute(String(cwd || ''))) throw taskError(400, '工作目录必须是绝对路径');
    const actual = await realpath(resolve(cwd)).catch(() => { throw taskError(400, '工作目录不存在'); });
    if (!(await stat(actual)).isDirectory()) throw taskError(400, '工作目录不是目录');
    const inside = this.allowedRoots.some((root) => {
      const part = relative(root, actual);
      return part === '' || (part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part));
    });
    if (!inside) throw taskError(403, '工作目录不在允许的项目目录内');
    return actual;
  }

  #schedule() {
    if (this.processing) return;
    this.processing = true;
    queueMicrotask(() => { void this.#drain().catch((error) => { console.error('开发任务调度失败', error); }); });
  }

  async #drain() {
    try {
      while (true) {
        const task = await this.store.nextQueued();
        if (!task) break;
        await this.#run(task);
      }
    } finally { this.processing = false; }
  }

  async #run(initial) {
    let task = await this.store.put({ ...initial, status: 'running' });
    let settle;
    let reject;
    const completion = new Promise((resolveDone, rejectDone) => { settle = resolveDone; reject = rejectDone; });
    this.running = { taskId: task.id, threadId: task.threadId, settle, reject, cancelRequested: false, approvalRequested: false };
    try {
      await this.#validateWorkDirectory(task.cwd);
      await this.client.initialize();
      if (task.threadId) await this.client.request('thread/resume', { threadId: task.threadId });
      else {
        const started = await this.client.request('thread/start', {
          cwd: task.cwd,
          developerInstructions: '你是独立的 Ethere 工程代理，只在给定项目目录内工作。遵守项目的 AGENTS.md、沙箱与审批边界。实际修改并运行相关测试；不要声称没验证的结果。若必须等用户给信息，最终以 WAITING_INPUT: 开头说明具体问题。若权限不足，不要绕开限制。',
          ...(task.model ? { model: task.model } : {}),
        });
        const threadId = started?.thread?.id || started?.threadId;
        if (!threadId) throw new Error('Codex 未返回开发线程 ID');
        task = await this.store.put({ ...task, threadId });
        this.running.threadId = threadId;
      }
      const startedTurn = await this.client.request('turn/start', {
        threadId: task.threadId, cwd: task.cwd,
        input: [{ type: 'text', text: task.instruction }],
        ...(task.model ? { model: task.model } : {}),
        approvalPolicy: 'on-request',
        sandboxPolicy: task.permission === 'readOnly' ? { type: 'readOnly' }
          : { type: 'workspaceWrite', writableRoots: [task.cwd], networkAccess: false },
      });
      task = await this.store.put({ ...task, turnId: startedTurn?.turn?.id || startedTurn?.turnId || task.turnId });
      if (this.running.cancelRequested && task.turnId) {
        await this.client.request('turn/interrupt', { threadId: task.threadId, turnId: task.turnId });
      }
      const finished = await completion;
      const current = await this.store.get(task.id);
      const finalStatus = this.running.cancelRequested ? 'cancelled'
        : this.running.approvalRequested ? 'waiting_approval'
          : finished.status === 'completed' ? (/^WAITING_INPUT:/u.test(current.resultSummary) ? 'waiting_input' : 'completed')
            : 'failed';
      const blocker = finalStatus === 'waiting_approval' ? current.blocker
        : finalStatus === 'waiting_input' ? current.resultSummary
          : finalStatus === 'failed' ? finished.error || `Codex 回合状态：${finished.status}` : '';
      task = await this.store.put({ ...current, status: finalStatus, blocker });
      await this.#emitEvent(task);
    } catch (error) {
      task = await this.store.put({ ...(await this.store.get(task.id)), status: 'failed', blocker: error?.message || String(error) });
      await this.#emitEvent(task);
    } finally {
      this.running = null;
    }
  }

  async #handleMessage(message) {
    const run = this.running;
    if (!run) return;
    const params = message?.params || {};
    const threadId = params.threadId || params.turn?.threadId || '';
    if (threadId && threadId !== run.threadId) return;
    if (message?.id != null && /requestApproval$/u.test(message.method || '')) {
      run.approvalRequested = true;
      const task = await this.store.get(run.taskId);
      await this.store.put({ ...task, blocker: `Codex 请求审批：${String(params.command || params.reason || message.method).slice(0, 400)}` });
      // No model-initiated approval. Deny this attempt and surface it to the user.
      this.client.respond(message.id, { decision: 'decline' });
      return;
    }
    if (message.method === 'item/completed') {
      const item = params.item || {};
      const task = await this.store.get(run.taskId);
      if (item.type === 'agentMessage') {
        const text = typeof item.text === 'string' ? item.text : Array.isArray(item.content)
          ? item.content.map((part) => part?.text || '').join('') : '';
        if (text) await this.store.put({ ...task, resultSummary: text.slice(0, 2_000) });
      } else if (item.type === 'fileChange') {
        const files = [...new Set([...task.files, ...(item.changes || []).map((change) => change.path).filter(Boolean)])].slice(0, 100);
        await this.store.put({ ...task, files });
      } else if (item.type === 'commandExecution') {
        const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command || '');
        const tests = [...task.tests, {
          command: command.slice(0, 2_000), exitCode: item.exitCode ?? null, status: item.status || '',
          outputTail: String(item.aggregatedOutput || '').slice(-800),
        }].slice(-20);
        await this.store.put({ ...task, tests });
      }
      return;
    }
    if (message.method === 'turn/completed') run.settle({ status: params.turn?.status || 'unknown', error: params.turn?.error?.message || '' });
    if (message.method === 'turn/failed') run.settle({ status: 'failed', error: params.turn?.error?.message || params.error?.message || 'Codex 回合失败' });
  }

  async #emitEvent(task) {
    await this.store.appendEvent({
      id: `${task.id}:${task.generation}:${task.status}`, taskId: task.id, title: task.title,
      status: task.status, resultSummary: task.resultSummary.slice(0, 1_200),
      files: task.files, tests: task.tests, blocker: task.blocker,
      createdAt: new Date().toISOString(),
    });
  }
}

export function publicTask(task) {
  const { instruction, ...visible } = task;
  return visible;
}

function taskError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
