import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeveloperTaskStore } from '../server/developer-task-store.mjs';
import { DeveloperTaskManager } from '../server/developer-task-manager.mjs';
import { createDeveloperBridgeServer } from '../server/developer-bridge-api.mjs';
import { DeveloperEventService } from '../server/developer-event-service.mjs';
import { ChatEventStore } from '../server/chat-event-store.mjs';

class FakeAppServer {
  constructor() { this.calls = []; this.listeners = new Set(); this.responses = []; this.nextThread = 0; this.hold = false; this.askApproval = false; this.finishStatus = 'completed'; this.agentText = '真实修改已完成'; }
  async initialize() {}
  onMessage(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(message) { for (const listener of this.listeners) listener(message); }
  respond(id, result) { this.responses.push([id, result]); }
  async request(method, params) {
    this.calls.push([method, params]);
    if (method === 'thread/start') return { thread: { id: `thread-${++this.nextThread}` } };
    if (method === 'turn/start') {
      if (!this.hold) queueMicrotask(() => {
        if (this.askApproval) this.emit({ id: 55, method: 'item/commandExecution/requestApproval', params: { threadId: params.threadId, command: 'unsafe command' } });
        this.emit({ method: 'item/completed', params: { threadId: params.threadId, item: { type: 'fileChange', changes: [{ path: 'result.txt' }] } } });
        this.emit({ method: 'item/completed', params: { threadId: params.threadId, item: { type: 'commandExecution', command: 'npm test', exitCode: 0, status: 'completed' } } });
        this.emit({ method: 'item/completed', params: { threadId: params.threadId, item: { type: 'agentMessage', text: this.agentText } } });
        this.emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { status: this.finishStatus } } });
      });
      return { turn: { id: `turn-${this.calls.length}` } };
    }
    if (method === 'turn/interrupt') {
      queueMicrotask(() => this.emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { status: 'interrupted' } } }));
    }
    return {};
  }
  async close() {}
}

async function waitFor(manager, id, status) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await manager.get(id);
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task did not reach ${status}`);
}

test('bridge persists task/thread, resumes the same thread, emits idempotent events and enforces local API auth', async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-bridge-test-'));
  const project = await mkdtemp(join(tmpdir(), 'ethere-bridge-project-'));
  const fake = new FakeAppServer();
  const manager = new DeveloperTaskManager({ dataRoot, allowedRoots: [project], client: fake });
  context.after(() => manager.close());
  const server = createDeveloperBridgeServer({ manager, token: 'local-secret' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/tasks`)).status, 401);
  assert.equal((await fetch(`${base}/tasks`, { headers: { Authorization: 'Bearer local-secret' } })).status, 200);
  await assert.rejects(manager.create({ title: 'escape', cwd: dataRoot, instruction: '改文件' }), /白名单|允许的项目目录/);

  const created = await manager.create({ title: '测试任务', cwd: project, instruction: '建立文件并测试' });
  const first = await waitFor(manager, created.id, 'completed');
  assert.equal(first.threadId, 'thread-1');
  assert.deepEqual(first.files, ['result.txt']);
  assert.equal(first.tests[0].exitCode, 0);
  assert.equal((await manager.pendingEvents()).length, 1);
  const eventId = (await manager.pendingEvents())[0].id;
  await manager.acknowledgeEvent(eventId);
  await manager.acknowledgeEvent(eventId);
  assert.equal((await manager.pendingEvents()).length, 0);

  const resumed = await manager.send(created.id, '再修改一次');
  const second = await waitFor(manager, resumed.id, 'completed');
  assert.equal(second.threadId, first.threadId);
  assert.equal(fake.calls.filter(([method]) => method === 'thread/start').length, 1);
  assert.equal(fake.calls.filter(([method]) => method === 'thread/resume').length, 1);
  assert.equal((await manager.pendingEvents()).length, 1);
  await manager.close();

  const recovered = new DeveloperTaskManager({ dataRoot, allowedRoots: [project], client: new FakeAppServer() });
  context.after(() => recovered.close());
  assert.equal((await recovered.get(created.id)).threadId, first.threadId);
  assert.equal((await recovered.pendingEvents()).length, 1);
});

test('approval is declined and reported as waiting, not silently granted or called completed', async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-bridge-approval-'));
  const project = await mkdtemp(join(tmpdir(), 'ethere-bridge-project-'));
  const fake = new FakeAppServer(); fake.askApproval = true;
  const manager = new DeveloperTaskManager({ dataRoot, allowedRoots: [project], client: fake });
  context.after(() => manager.close());
  const created = await manager.create({ title: '需要审批', cwd: project, instruction: '尝试操作' });
  const waiting = await waitFor(manager, created.id, 'waiting_approval');
  assert.match(waiting.blocker, /请求审批/);
  assert.deepEqual(fake.responses, [[55, { decision: 'decline' }]]);
});

test('running task can be cancelled and a crash recovers to waiting_input without duplicate writes', async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-bridge-cancel-'));
  const project = await mkdtemp(join(tmpdir(), 'ethere-bridge-project-'));
  const fake = new FakeAppServer(); fake.hold = true;
  const manager = new DeveloperTaskManager({ dataRoot, allowedRoots: [project], client: fake });
  context.after(() => manager.close());
  const created = await manager.create({ title: '取消任务', cwd: project, instruction: '执行很久' });
  await waitFor(manager, created.id, 'running');
  for (let attempt = 0; attempt < 100 && !(await manager.get(created.id)).turnId; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await manager.cancel(created.id);
  await waitFor(manager, created.id, 'cancelled');
  assert.equal(fake.calls.some(([method]) => method === 'turn/interrupt'), true);

  const store = new DeveloperTaskStore({ dataRoot });
  await store.put({ id: 'interrupted-task', title: '重启任务', cwd: project, instruction: '做事', threadId: 'old-thread', turnId: 'old-turn', generation: 1,
    status: 'running', resultSummary: '', files: [], tests: [], blocker: '', createdAt: new Date().toISOString() });
  await store.close();
  const restored = new DeveloperTaskManager({ dataRoot, allowedRoots: [project], client: new FakeAppServer() });
  context.after(() => restored.close());
  assert.equal((await restored.get('interrupted-task')).status, 'waiting_input');
  assert.equal((await restored.pendingEvents()).some((event) => event.taskId === 'interrupted-task'), true);
});

test('duplicate callback and App restart cannot duplicate a delivered Ethere message', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-bridge-delivery-'));
  const chatEventStore = new ChatEventStore({ dataRoot });
  const event = { id: 'task-1:1:completed', taskId: 'task-1', title: '完成小任务', status: 'completed', resultSummary: '改好了', files: ['x.js'], tests: [], blocker: '' };
  let acknowledged = false;
  const bridge = {
    async pendingEvents() { return { events: acknowledged ? [] : [event] }; },
    async acknowledgeEvent() { acknowledged = true; },
  };
  let wakeCount = 0;
  const chatService = {
    isBusy: () => false,
    async sendMessage() { wakeCount += 1; return { status: 'completed', text: '小任务完成了。' }; },
  };
  const firstApp = new DeveloperEventService({ bridge, chatService, chatEventStore });
  await firstApp.tick();
  assert.equal(wakeCount, 1);
  assert.equal((await chatEventStore.listHistory()).events.filter((item) => item.source === 'developer-task').length, 1);
  acknowledged = false; // Simulate a crash after writing the visible receipt but before ack.
  const restartedApp = new DeveloperEventService({ bridge, chatService, chatEventStore });
  await restartedApp.tick();
  assert.equal(wakeCount, 1);
  assert.equal(acknowledged, true);
  assert.equal((await chatEventStore.listHistory()).events.filter((item) => item.source === 'developer-task').length, 1);
});

test('a question is waiting_input and an incomplete app-server turn is failed, never completed', async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-bridge-status-'));
  const project = await mkdtemp(join(tmpdir(), 'ethere-bridge-project-'));
  const fake = new FakeAppServer(); fake.agentText = 'WAITING_INPUT: 请提供测试账号。';
  const manager = new DeveloperTaskManager({ dataRoot, allowedRoots: [project], client: fake });
  context.after(() => manager.close());
  const waiting = await manager.create({ title: '缺信息', cwd: project, instruction: '做事' });
  assert.equal((await waitFor(manager, waiting.id, 'waiting_input')).blocker, fake.agentText);
  fake.finishStatus = 'failed'; fake.agentText = '我做完了';
  const failed = await manager.create({ title: '不完整回合', cwd: project, instruction: '做事' });
  assert.equal((await waitFor(manager, failed.id, 'failed')).status, 'failed');
});

test('a completed task cannot resume after its working directory leaves the allowlist', async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-bridge-root-restriction-'));
  const project = await mkdtemp(join(tmpdir(), 'ethere-bridge-previous-project-'));
  const restricted = await mkdtemp(join(tmpdir(), 'ethere-bridge-restricted-'));
  const original = new DeveloperTaskManager({ dataRoot, allowedRoots: [project], client: new FakeAppServer() });
  const created = await original.create({ title: '旧任务', cwd: project, instruction: '做事' });
  await waitFor(original, created.id, 'completed');
  await original.close();
  const manager = new DeveloperTaskManager({ dataRoot, allowedRoots: [restricted], client: new FakeAppServer() });
  context.after(() => manager.close());
  await assert.rejects(manager.send(created.id, '继续修改'), /工作目录不在允许的项目目录内/);
  assert.equal((await manager.get(created.id)).status, 'completed');
});
