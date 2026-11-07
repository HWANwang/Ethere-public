import { CodexAppServerClient } from '../../server/codex-app-server-client.mjs';

const MODEL = 'gpt-6-luna';

export class CodexMaintenanceBackend {
  constructor({ cwd, client = new CodexAppServerClient(), timeoutMs = 12 * 60_000 }) {
    this.cwd = cwd; this.client = client; this.timeoutMs = timeoutMs; this.resumed = new Set();
  }

  async createThread(role, instructions) {
    await this.client.initialize();
    const result = await this.client.request('thread/start', { cwd: this.cwd, model: MODEL, effort: 'medium',
      developerInstructions: `${instructions}\n你是只读的 ${role} 后台窗口；不要调用工具，不要向用户发聊天消息。` });
    const id = result?.thread?.id || result?.threadId;
    if (!id) throw new Error(`Codex 未返回 ${role} 后台线程 ID`);
    this.resumed.add(id);
    return id;
  }

  async #resume(threadId) {
    await this.client.initialize();
    if (this.resumed.has(threadId)) return;
    await this.client.request('thread/resume', { threadId, model: MODEL, effort: 'medium' });
    this.resumed.add(threadId);
  }

  async turn(threadId, prompt) {
    await this.#resume(threadId);
    let turnId = '';
    let text = '';
    let settle;
    let reject;
    const completion = new Promise((resolve, fail) => { settle = resolve; reject = fail; });
    const timer = setTimeout(() => reject(new Error('Luna 后台回合超时')), this.timeoutMs);
    const off = this.client.onMessage((event) => {
      if (event?.params?.threadId !== threadId) return;
      if (event.method === 'item/agentMessage/delta' && (!turnId || event.params.turnId === turnId)) text += event.params.delta || '';
      if (event.method === 'item/completed' && event.params.item?.type === 'agentMessage' && !text) text = event.params.item.text || '';
      if (event.method === 'turn/completed' && (!turnId || event.params.turn?.id === turnId)) {
        const status = event.params.turn?.status;
        if (status === 'completed') settle();
        else reject(new Error(`Luna 后台回合未完成：${status || 'unknown'}`));
      }
      if (event.method === 'ethere/appServerClosed') reject(new Error('后台 Codex app-server 断开'));
    });
    try {
      let started;
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          started = await this.client.request('turn/start', { threadId, cwd: this.cwd,
            input: [{ type: 'text', text: prompt }], model: MODEL, effort: 'medium', approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } });
          break;
        } catch (error) {
          if (!/ActiveTurnNotSteerable.*Compact/i.test(String(error?.message)) || attempt === 11) throw error;
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
      turnId = started?.turn?.id || started?.turnId || '';
      await completion;
      return text.trim();
    } catch (error) {
      if (turnId && /超时/.test(error.message)) await this.client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      throw error;
    } finally { clearTimeout(timer); off(); }
  }

  async compact(threadId) {
    await this.#resume(threadId);
    let settle; let reject;
    const completion = new Promise((resolve, fail) => { settle = resolve; reject = fail; });
    const timer = setTimeout(() => reject(new Error('Luna 后台压缩超时')), this.timeoutMs);
    const off = this.client.onMessage((event) => {
      if (event?.params?.threadId !== threadId) return;
      if (event.method === 'item/completed' && event.params.item?.type === 'contextCompaction') settle();
      if (event.method === 'ethere/appServerClosed') reject(new Error('后台 Codex app-server 断开'));
    });
    try { await this.client.request('thread/compact/start', { threadId }); await completion; }
    finally { clearTimeout(timer); off(); }
  }

  async close() { await this.client.close(); }
}
