import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEthereServer } from '../server/server.mjs';
import { MemoryStore } from '../server/memory-store.mjs';
import { MemoryNodeStore } from '../server/memory-node-store.mjs';
import { UnifiedMemoryStore } from '../server/unified-memory-store.mjs';
import { ConfigStore } from '../server/config-store.mjs';
import { ChatEventStore } from '../server/chat-event-store.mjs';
import { SpaceStore } from '../server/space-store.mjs';
import { PhoneUsageStore } from '../server/phone-usage-store.mjs';
import { PhoneUsageRefresh } from '../server/phone-usage-refresh.mjs';

test('4173 代理记忆整理状态、手动触发和暂停开关', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const calls = [];
  const memoryV2Client = {
    async maintenanceStatus() { return { enabled: true, pendingSources: 4 }; },
    async maintenanceHistory(limit) { calls.push(['history', limit]); return { batches: [] }; },
    async triggerMaintenance() { calls.push(['trigger']); return { running: true }; },
    async setMaintenanceEnabled(enabled) { calls.push(['enabled', enabled]); return { enabled }; },
  };
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore: {}, memoryV2Client });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1/memory-v2/maintenance`;
  assert.equal((await (await fetch(base)).json()).pendingSources, 4);
  assert.deepEqual((await (await fetch(`${base}/history?limit=7`)).json()).batches, []);
  assert.equal((await fetch(`${base}/trigger`, { method: 'POST' })).status, 202);
  assert.deepEqual(await (await fetch(`${base}/enabled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })).json(), { enabled: false });
  assert.deepEqual(calls, [['history', '7'], ['trigger'], ['enabled', false]]);
});

test('phone usage tool waits for a fresh phone snapshot over SSE', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-phone-api-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const phoneUsageStore = new PhoneUsageStore({ dataRoot });
  const phoneUsageRefresh = new PhoneUsageRefresh({ timeoutMs: 1_000 });
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore: {}, phoneUsageStore, phoneUsageRefresh });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1/phone-usage`;
  const unavailable = await fetch(`${base}/recent?fresh=true`);
  assert.equal(unavailable.status, 503);

  const controller = new AbortController();
  const stream = await fetch(`${base}/requests/stream`, { signal: controller.signal });
  const reader = stream.body.getReader();
  await reader.read();
  try {
    const freshResponse = fetch(`${base}/recent?fresh=true&lookbackMinutes=60`);
    let chunk = '';
    while (!chunk.includes('\n\n')) chunk += new TextDecoder().decode((await reader.read()).value);
    const command = JSON.parse(chunk.match(/data: ([^\n]+)/)[1]);
    assert.equal(command.lookbackMinutes, 60);
    const end = new Date();
    const start = new Date(end.getTime() - 3_600_000);
    const upload = await fetch(`${base}/snapshots`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      id: 'fresh-1', requestId: command.id, schemaVersion: 2, collectedAt: end.toISOString(), intervalStart: start.toISOString(), intervalEnd: end.toISOString(),
      apps: [{ packageName: 'app', appName: '应用', foregroundMs: 1_200_000 }],
      timeline: [{ type: 'app', packageName: 'app', startAt: start.toISOString(), endAt: new Date(start.getTime() + 1_200_000).toISOString() }],
    }) });
    assert.equal(upload.status, 201);
    const result = await (await freshResponse).json();
    assert.equal(result.apps[0].foregroundMs, 1_200_000);
    assert.equal(result.timeline.length, 1);
    assert.equal(result.stale, false);
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
});

test('retrievable memory nodes page and resolve live sources without copying deleted text', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-node-api-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const memoryNodeStore = new MemoryNodeStore({ dataRoot });
  const chatEventStore = new ChatEventStore({ dataRoot });
  await chatEventStore.append({ id: 'source-1', role: 'user', content: '我重新开始学陶艺了' });
  const node = await memoryNodeStore.create({ topicKey: '学陶艺', content: '想再学陶艺', owner: 'user' });
  await memoryNodeStore.addSource(node.id, { type: 'chat', id: 'source-1' });
  await memoryNodeStore.addSource(node.id, { type: 'chat', id: 'missing-source' });
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore, memoryNodeStore });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1/memory/nodes`;
  const list = await (await fetch(`${base}?tier=retrievable&limit=20`)).json();
  assert.equal(list.total, 1);
  const detail = await (await fetch(`${base}/${node.id}`)).json();
  assert.match(detail.node.sources.find((source) => source.id === 'source-1').content, /学陶艺/);
  const missing = detail.node.sources.find((source) => source.id === 'missing-source');
  assert.equal(missing.unavailable, true);
  assert.equal('content' in missing, false);
});

test('document approval accepts only a current revision and exposes rollback history', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-document-approval-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const configStore = new ConfigStore({ dataRoot });
  const current = await configStore.writeDocument('persona', '旧人设');
  const chatEventStore = new ChatEventStore({ dataRoot });
  const proposal = await chatEventStore.append({ id: 'document-approval', role: 'activity', source: 'mcp', status: 'pending', content: '建议修改人设', approval: {
    kind: 'document-change', status: 'pending', proposal: { name: 'persona', baseRevision: current.revision, previousText: '旧人设', text: '新人设', reason: '用户同意修改' },
  } });
  const chatService = { async refreshInstructions() { return { applied: false, status: 'pending-new-thread' }; } };
  const server = createEthereServer({ webRoot, chatService, attachmentStore: {}, chatEventStore, configStore });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1`;
  const accept = await fetch(`${base}/chat/approvals/${proposal.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'accept' }) });
  assert.equal(accept.status, 200);
  assert.equal((await configStore.readDocument('persona')).text, '新人设');
  const history = await (await fetch(`${base}/documents/persona/history`)).json();
  assert.equal(history.versions.length, 2);
  const rollback = await fetch(`${base}/documents/persona/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: current.revision, baseRevision: (await configStore.readDocument('persona')).revision }) });
  assert.equal(rollback.status, 200);
  assert.equal((await configStore.readDocument('persona')).text, '旧人设');
});

test('chat event stream publishes reminder counts immediately and after changes', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  let onReminderChange = null;
  let reminderUnsubscribed = false;
  const chatEventStore = { async listAfter() { return { events: [], cursor: 0, reset: false }; }, subscribe() { return () => {}; } };
  const reminderService = {
    async list() { return { reminders: [{ id: 'reminder-1' }] }; },
    subscribe(listener) { onReminderChange = listener; return () => { reminderUnsubscribed = true; }; },
  };
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore, reminderService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ethere/v1/chat/events/stream`, { signal: controller.signal });
  const reader = response.body.getReader();
  try {
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"reminderCount":1/);
    assert.equal(typeof onReminderChange, 'function');
    onReminderChange({ scheduledCount: 0 });
    const next = new TextDecoder().decode((await reader.read()).value);
    assert.match(next, /"reminderCount":0/);
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  for (let attempt = 0; attempt < 20 && !reminderUnsubscribed; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(reminderUnsubscribed, true);
});

test('chat event stream forwards memory notices written by a separate MCP process store', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-cross-process-events-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const serverStore = new ChatEventStore({ dataRoot });
  const mcpStore = new ChatEventStore({ dataRoot });
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore: serverStore });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ethere/v1/chat/events/stream`, { signal: controller.signal });
  const reader = response.body.getReader();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    await reader.read();
    await mcpStore.append({ id: 'separate-memory-notice', role: 'notice', source: 'memory', content: '已创建记忆 · 学陶艺' });
    let chunk = '';
    while (!chunk.includes('separate-memory-notice')) chunk += new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /"source":"memory"/);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader.cancel().catch(() => {});
  }
});

test('server stores user and assistant space posts with stable identities and revision-safe soft deletion', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-space-api-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const spaceStore = new SpaceStore({ dataRoot });
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore: {}, spaceStore });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1/space/posts`;

  const user = await fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentMarkdown: '用户记录', occurredAt: '2026-10-29T12:00:00+08:00' }),
  }).then((response) => response.json());
  const assistant = await fetch(`${base}/assistant`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentMarkdown: '助手观察' }),
  }).then((response) => response.json());
  assert.equal(user.post.author, 'user');
  assert.equal(assistant.post.author, 'assistant');
  assert.equal('bossName' in assistant.post, false);

  const compact = await fetch(`${base}?compact=true&author=assistant`).then((response) => response.json());
  assert.deepEqual(compact.posts.map((post) => Object.keys(post).sort()), [['author', 'contentMarkdown', 'imageCount', 'occurredAt', 'postId', 'revision']]);

  const updated = await fetch(`${base}/${encodeURIComponent(assistant.post.id)}/assistant`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseRevision: assistant.post.revision, contentMarkdown: '重写后的观察' }),
  }).then((response) => response.json());
  assert.equal(updated.post.contentMarkdown, '重写后的观察');
  const deleted = await fetch(`${base}/${encodeURIComponent(user.post.id)}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRevision: user.post.revision }),
  }).then((response) => response.json());
  assert.equal(deleted.post.status, 'archived');
  const remaining = await fetch(base).then((response) => response.json());
  assert.deepEqual(remaining.posts.map((post) => post.author), ['assistant']);
});

test('server exposes Dida connection, project selection, and supervised reads through bounded endpoints', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const didaService = {
    async status() { return { connected: true, supervisedProjects: [] }; },
    async startOAuthLogin() { return { authorizationUrl: 'https://example.test/oauth' }; },
    async listProjects() { return { projects: [{ id: 'p1', name: '监督清单' }] }; },
    async selectProjects(payload) { return { supervisedProjects: payload.projectIds.map((id) => ({ id, name: id === 'p1' ? '监督清单' : '第二清单' })) }; },
    async listSupervisedTasks(query) { return { projects: [{ id: 'p1', name: '监督清单' }], ...query, count: 0, tasks: [] }; },
  };
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore: {}, didaService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1`;
  assert.equal((await fetch(`${base}/integrations/dida/status`).then((response) => response.json())).connected, true);
  const selected = await fetch(`${base}/integrations/dida/supervised-project`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectIds: ['p1'] }) }).then((response) => response.json());
  assert.equal(selected.supervisedProjects[0].id, 'p1');
  const tasks = await fetch(`${base}/tasks/supervised?scope=today&keyword=test&limit=10`).then((response) => response.json());
  assert.equal(tasks.scope, 'today');
  assert.equal(tasks.keyword, 'test');
});

test('server exposes health and streams chat as NDJSON', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const chatService = {
    sendCount: 0,
    dataRoot: 'C:\\ethere-test-data',
    health: async () => ({ connected: true, runtime: 'fake' }),
    async sendMessage(payload, emit) {
      this.sendCount += 1;
      assert.equal(payload.text, 'hello');
      assert.deepEqual(payload.attachments, [{ type: 'image', absolutePath: 'C:\\private\\image.jpg' }]);
      assert.ok(!Number.isNaN(new Date(payload.occurredAt).getTime()));
      emit({ type: 'delta', delta: 'hi' });
      return { threadId: 'thread-new', turnId: 'turn-new', text: 'hi', status: 'completed' };
    },
    interruptActive: async () => ({ interrupted: false }),
  };
  const attachmentStore = {
    async saveChatImages(images) {
      assert.equal(images[0].name, 'blue.jpg');
      return [{ type: 'image', absolutePath: 'C:\\private\\image.jpg' }];
    },
  };
  let seq = 0;
  const events = [];
  const chatEventStore = {
    async append(event) { const stored = { ...event, seq: ++seq }; events.push(stored); return stored; },
    async listAfter(after) { const selected = events.filter((event) => event.seq > Number(after || 0)); return { events: selected, cursor: selected.at(-1)?.seq || Number(after || 0) }; },
    async listHistory(options) {
      if (options.roles) { assert.deepEqual(options, { limit: 24, roles: ['user', 'assistant'] }); return { events: [] }; }
      assert.deepEqual(options, { before: null, after: null, limit: '1', date: '2026-10-29', query: null });
      return { events: events.slice(0, 1), before: 1, hasMore: true, date: options.date };
    },
    async getById(id) { return events.find((event) => event.id === id) || null; },
    async findReplyTo(id) { return events.find((event) => event.replyTo === id) || null; },
    async listRepliesTo(id) { return events.filter((event) => event.replyTo === id); },
  };
  const timings = [];
  const server = createEthereServer({ webRoot, chatService, attachmentStore, chatEventStore, onChatTiming: (record) => timings.push(record) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/api/ethere/v1/health`).then((response) => response.json());
  assert.deepEqual(health, { connected: true, runtime: 'fake', serverConnected: true, runtimeConnected: true,
    instance: { pid: process.pid, dataRoot: 'C:\\ethere-test-data' } });

  const response = await fetch(`${base}/api/ethere/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello', messageId: 'message_test_123', images: [{ name: 'blue.jpg', dataUrl: 'data:image/jpeg;base64,YQ==' }] }),
  });
  assert.equal(response.status, 200);
  const lines = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].type, 'start');
  assert.equal(lines[0].messageId, 'reply_message_test_123');
  assert.deepEqual(lines[1], { type: 'delta', delta: 'hi' });
  assert.deepEqual(lines[2], { type: 'done', threadId: 'thread-new', turnId: 'turn-new', status: 'completed', cursor: 2 });
  assert.equal(timings[0].side, 'server');
  assert.equal(timings[0].id, 'message_test');
  assert.equal(timings[0].failed, false);
  assert.ok(timings[0].acceptedMs <= timings[0].firstDeltaMs);
  assert.ok(timings[0].firstDeltaMs <= timings[0].modelDoneMs);
  assert.ok(timings[0].modelDoneMs <= timings[0].storedMs);
  const metricResponse = await fetch(`${base}/api/ethere/v1/chat/latency`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId: 'message_test_123', platform: 'android', firstResponseMs: 90, firstDeltaMs: 120, firstVisibleMs: 140, doneMs: 300, message: 'must not be logged' }),
  });
  assert.equal(metricResponse.status, 204);
  assert.equal(timings[1].side, 'client');
  assert.equal(timings[1].platform, 'android');
  assert.equal(timings[1].firstVisibleMs, 140);
  assert.equal(JSON.stringify(timings).includes('must not be logged'), false);

  const history = await fetch(`${base}/api/ethere/v1/chat/events?after=0`).then((result) => result.json());
  assert.equal(history.events.length, 2);
  assert.deepEqual(history.events.map((event) => event.role), ['user', 'assistant']);

  const turn = await fetch(`${base}/api/ethere/v1/chat/turns/message_test_123`).then((result) => result.json());
  assert.equal(turn.state, 'completed');
  assert.deepEqual(turn.events.map((event) => event.role), ['user', 'assistant']);
  assert.equal(turn.cursor, 2);
  const missingTurn = await fetch(`${base}/api/ethere/v1/chat/turns/missing_test_123`).then((result) => result.json());
  assert.equal(missingTurn.state, 'missing');

  const datedHistory = await fetch(`${base}/api/ethere/v1/chat/history?limit=1&date=2026-10-29`).then((result) => result.json());
  assert.equal(datedHistory.events.length, 1);
  assert.equal(datedHistory.date, '2026-10-29');

  const replay = await fetch(`${base}/api/ethere/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello', messageId: 'message_test_123' }),
  }).then((result) => result.text());
  assert.match(replay, /"replayed":true/);
  assert.equal(chatService.sendCount, 1);
});

test('lightweight runtime activity identifies background work and voice chat without loading instructions', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-activity-web-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const sources = [];
  const chatService = {
    activityStatus: () => ({ busy: true, operation: { kind: 'reminder', stage: 'generating', startedAt: '2026-11-03T00:00:00.000Z' } }),
    async sendMessage(payload) { sources.push(payload.source); return { text: '听见了', status: 'completed' }; },
  };
  const events = [];
  const chatEventStore = {
    async getById(id) { return events.find((event) => event.id === id) || null; },
    async append(event) { const stored = { ...event, seq: events.length + 1 }; events.push(stored); return stored; },
  };
  const server = createEthereServer({ webRoot, chatService, chatEventStore,
    attachmentStore: { async saveChatImages() { return []; } }, onChatTiming: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1`;
  const activity = await (await fetch(`${base}/runtime/activity`)).json();
  assert.equal(activity.operation.kind, 'reminder');
  const response = await fetch(`${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '你听到了吗', channel: 'voice', messageId: 'voice-test-1' }) });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(sources, ['voice']);
});

test('quoted chat persists the selected excerpt and gives the model its source without changing reply linkage', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-quote-test-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-quote-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const chatEventStore = new ChatEventStore({ dataRoot });
  await chatEventStore.append({ id: 'assistant-source-0001', role: 'assistant', content: '你不用马上解决所有问题。' });
  const modelInputs = [];
  const server = createEthereServer({
    webRoot, chatEventStore,
    attachmentStore: { async saveChatImages() { return []; } },
    chatService: { async sendMessage(payload) { modelInputs.push(payload.text); return { text: '嗯，先慢一点。', status: 'completed' }; } },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}/api/ethere/v1/chat`;
  const body = { message: '你这句话对我有用', messageId: 'user-quoted-0001', quote: { sourceMessageId: 'assistant-source-0001', text: '你不用马上解决所有问题。' } };
  const first = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(first.status, 200);
  await first.text();
  assert.match(modelInputs[0], /引用了助手此前的一段话/);
  assert.match(modelInputs[0], /你不用马上解决所有问题。/);
  assert.match(modelInputs[0], /用户现在说：\n你这句话对我有用/);
  const stored = await chatEventStore.getById('user-quoted-0001');
  assert.equal(stored.content, body.message);
  assert.deepEqual(stored.quote, { sourceMessageId: body.quote.sourceMessageId, sourceRole: 'assistant', text: body.quote.text });
  assert.equal(stored.replyTo, '');
  assert.equal((await chatEventStore.findReplyTo(stored.id)).replyTo, stored.id);
  const replay = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.match(await replay.text(), /"replayed":true/);
  assert.equal(modelInputs.length, 1);
  const invalid = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, messageId: 'user-quoted-0002', quote: { sourceMessageId: 'missing-source-0001', text: '伪造' } }) });
  assert.equal(invalid.status, 400);
});

test('server health keeps local data available when the model runtime is unavailable', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const server = createEthereServer({
    webRoot,
    chatService: { dataRoot: 'C:\\ethere-test-data', health: async () => { throw new Error('runtime unavailable'); } },
    attachmentStore: {},
    chatEventStore: {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ethere/v1/health`);
  const health = await response.json();
  assert.equal(response.status, 200);
  assert.equal(health.serverConnected, true);
  assert.equal(health.runtimeConnected, false);
  assert.deepEqual(health.instance, { pid: process.pid, dataRoot: 'C:\\ethere-test-data' });
  assert.match(health.runtimeError, /runtime unavailable/);
});

test('server persists and replays assistant segments around timeline write activities', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  let seq = 0;
  const events = [];
  const chatEventStore = {
    async append(event) { const existing = events.find((item) => item.id === event.id); if (existing) return existing; const stored = { ...event, seq: ++seq }; events.push(stored); return stored; },
    async getById(id) { return events.find((event) => event.id === id) || null; },
    async findReplyTo(id) { return events.find((event) => event.replyTo === id && event.role === 'assistant') || null; },
    async listRepliesTo(id) { return events.filter((event) => event.replyTo === id && ['assistant', 'activity'].includes(event.role)); },
  };
  const chatService = {
    async sendMessage(_payload, emit) {
      emit({ type: 'delta', delta: '我先记。' });
      emit({ type: 'activity', callId: 'call-1', content: '已记录时间线', status: 'completed' });
      emit({ type: 'segment', segment: 1 });
      emit({ type: 'delta', delta: '记好了。' });
      return {
        threadId: 'thread-1', turnId: 'turn-1', status: 'completed', text: '我先记。记好了。',
        timeline: [
          { type: 'assistant', index: 0, text: '我先记。' },
          { type: 'activity', callId: 'call-1', content: '已记录时间线', status: 'completed' },
          { type: 'assistant', index: 1, text: '记好了。' },
        ],
      };
    },
  };
  const server = createEthereServer({
    webRoot, chatService, chatEventStore,
    attachmentStore: { async saveChatImages() { return []; } },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}/api/ethere/v1/chat`;
  const body = { message: '记一下', messageId: 'message_tool_test' };
  const first = (await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.text())).trim().split('\n').map(JSON.parse);
  assert.deepEqual(first.map((event) => event.type), ['start', 'delta', 'activity', 'segment', 'delta', 'done']);
  assert.equal(first[2].content, '已记录时间线');
  assert.deepEqual(events.map((event) => event.role), ['user', 'assistant', 'activity', 'assistant']);
  assert.equal(events[1].turnComplete, false);
  assert.equal(events[3].turnComplete, true);
  const replay = (await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.text())).trim().split('\n').map(JSON.parse);
  assert.deepEqual(replay.map((event) => event.type), ['start', 'delta', 'activity', 'segment', 'delta', 'done']);
  assert.equal(replay.at(-1).replayed, true);
});

test('server stores compaction completion as a local activity event', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const events = [];
  const chatEventStore = {
    async append(event) { const stored = { ...event, seq: events.length + 1 }; events.push(stored); return stored; },
    async listAfter() { return { events, cursor: events.length }; },
  };
  const server = createEthereServer({
    webRoot,
    chatService: { compactThread: async () => ({ compacted: true, threadId: 'thread-1', completedAt: '2026-10-29T03:30:00.000Z' }) },
    attachmentStore: {},
    chatEventStore,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/ethere/v1/runtime/compact`, { method: 'POST' }).then((result) => result.json());
  assert.equal(response.cursor, 1);
  assert.deepEqual(events[0], {
    id: events[0].id,
    role: 'activity',
    content: '已完成上下文压缩',
    source: 'compaction',
    createdAt: '2026-10-29T03:30:00.000Z',
    seq: 1,
  });
});

test('server exposes timeline reads and revision-safe writes', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const calls = [];
  const timelineStore = {
    async query(options) { calls.push(['query', options]); return [{ id: 'evt-1' }]; },
    async stats(options) { calls.push(['stats', options]); return { ...options, totalMinutes: 60, groups: [] }; },
    async listCategories(options) { calls.push(['categories', options]); return { revision: 2, categories: [] }; },
    async addCategory(payload) { calls.push(['addCategory', payload]); return { revision: 3, categories: [{ id: payload.id, name: payload.name, children: [] }] }; },
    async addSubcategory(payload) { calls.push(['addSubcategory', payload]); return { revision: 4, categories: [] }; },
    async renameCategory(payload) { calls.push(['renameCategory', payload]); return { revision: 5, categories: [] }; },
    async setCategoryStatus(payload) { calls.push(['setCategoryStatus', payload]); return { revision: 6, categories: [] }; },
    async getReview(date) { calls.push(['review', date]); return { text: '完成只读链路', revision: 1 }; },
    async createEvent(payload) { calls.push(['create', payload]); return { id: 'evt-2', revision: 1, ...payload }; },
    async updateEvent(id, patch, options) { calls.push(['update', id, patch, options]); return { id, revision: 2, ...patch }; },
    async archiveEvent(id, options) { calls.push(['archive', id, options]); return { id, revision: 3, deletedAt: '2026-10-29T10:00:00.000Z' }; },
    async restoreEvent(id, options) { calls.push(['restore', id, options]); return { id, revision: 4, deletedAt: null }; },
    async setReview(date, payload) { calls.push(['setReview', date, payload]); return { text: payload.text, revision: 2 }; },
  };
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore: {}, timelineStore });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1`;

  const timeline = await fetch(`${base}/timeline?start=2026-10-27&end=2026-10-29`).then((response) => response.json());
  const stats = await fetch(`${base}/timeline/stats?start=2026-10-27&end=2026-10-29`).then((response) => response.json());
  const categories = await fetch(`${base}/timeline/categories?includeInactive=true`).then((response) => response.json());
  const addedCategory = await fetch(`${base}/timeline/categories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'health', name: '健康', color: '#719C87', baseRevision: 2 }) }).then((response) => response.json());
  const addedSubcategory = await fetch(`${base}/timeline/categories/health/children`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'walking', name: '散步', baseRevision: 3 }) }).then((response) => response.json());
  const renamedCategory = await fetch(`${base}/timeline/categories/health`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '身体', color: '#D77D62', baseRevision: 4 }) }).then((response) => response.json());
  const disabledSubcategory = await fetch(`${base}/timeline/categories/health/children/walking`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'inactive', baseRevision: 5 }) }).then((response) => response.json());
  const review = await fetch(`${base}/timeline/reviews/2026-10-29`).then((response) => response.json());
  const created = await fetch(`${base}/timeline/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '整理书桌', mutationId: 'create-1' }) }).then((response) => response.json());
  const updated = await fetch(`${base}/timeline/events/evt-2`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '整理房间', baseRevision: 1, mutationId: 'update-1' }) }).then((response) => response.json());
  const archived = await fetch(`${base}/timeline/events/evt-2/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRevision: 2, mutationId: 'archive-1' }) }).then((response) => response.json());
  const restored = await fetch(`${base}/timeline/events/evt-2/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRevision: 3, mutationId: 'restore-1' }) }).then((response) => response.json());
  const savedReview = await fetch(`${base}/timeline/reviews/2026-10-29`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '**完成**', baseRevision: 1, mutationId: 'review-1' }) }).then((response) => response.json());

  assert.equal(timeline.events[0].id, 'evt-1');
  assert.equal(stats.totalMinutes, 60);
  assert.equal(categories.revision, 2);
  assert.equal(addedCategory.revision, 3);
  assert.equal(addedSubcategory.revision, 4);
  assert.equal(renamedCategory.revision, 5);
  assert.equal(disabledSubcategory.revision, 6);
  assert.equal(review.review.text, '完成只读链路');
  assert.equal(created.event.id, 'evt-2');
  assert.equal(updated.event.title, '整理房间');
  assert.ok(archived.event.deletedAt);
  assert.equal(restored.event.deletedAt, null);
  assert.equal(savedReview.review.text, '**完成**');
  assert.deepEqual(calls, [
    ['query', { start: '2026-10-27', end: '2026-10-29' }],
    ['stats', { start: '2026-10-27', end: '2026-10-29' }],
    ['categories', { includeInactive: true }],
    ['addCategory', { id: 'health', name: '健康', color: '#719C87', baseRevision: 2 }],
    ['addSubcategory', { id: 'walking', name: '散步', baseRevision: 3, categoryId: 'health' }],
    ['renameCategory', { categoryId: 'health', subcategoryId: null, baseRevision: 4, name: '身体', color: '#D77D62' }],
    ['setCategoryStatus', { categoryId: 'health', subcategoryId: 'walking', baseRevision: 5, status: 'inactive' }],
    ['review', '2026-10-29'],
    ['create', { title: '整理书桌', mutationId: 'create-1' }],
    ['update', 'evt-2', { title: '整理房间' }, { baseRevision: 1, mutationId: 'update-1' }],
    ['archive', 'evt-2', { baseRevision: 2, mutationId: 'archive-1' }],
    ['restore', 'evt-2', { baseRevision: 3, mutationId: 'restore-1' }],
    ['setReview', '2026-10-29', { text: '**完成**', baseRevision: 1, mutationId: 'review-1' }],
  ]);
});

test('server resolves a category approval only after the user accepts it', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  let approvalEvent = {
    id: 'approval-category-1', seq: 4, role: 'activity', status: 'pending', content: '建议新增二级分类 · 代码复盘',
    approval: { kind: 'timeline-category-create', status: 'pending', proposal: { level: 'secondary', name: '代码复盘', parentCategoryId: 'work', reason: '会重复出现' } },
  };
  const calls = [];
  const chatEventStore = {
    async getById(id) { return id === approvalEvent.id ? approvalEvent : null; },
    async update(_id, patch) { approvalEvent = { ...approvalEvent, ...patch, seq: 5 }; return approvalEvent; },
  };
  const timelineStore = {
    async listCategories() { return { revision: 3, categories: [{ id: 'work', name: '工作', color: '#7079D1', status: 'active', children: [] }] }; },
    async addSubcategory(payload) { calls.push(payload); return { revision: 4, categories: [] }; },
  };
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore, timelineStore });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ethere/v1/chat/approvals/approval-category-1`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'accept' }),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.event.approval.status, 'accepted');
  assert.equal(calls[0].categoryId, 'work');
  assert.equal(calls[0].name, '代码复盘');
});

test('server writes proposed Dida changes only after chat approval and completes explicit tasks directly', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  let approvalEvent = {
    id: 'approval-task-1', seq: 1, role: 'activity', status: 'pending', content: '建议新建滴答任务 · 写测试',
    approval: { kind: 'dida-task-change', status: 'pending', proposal: { operation: 'create', projectId: 'p1', projectName: '监督清单', title: '写测试', reason: '用户想安排这件事' } },
  };
  const writes = [];
  const chatEventStore = {
    async getById(id) { return id === approvalEvent.id ? approvalEvent : null; },
    async update(_id, patch) { approvalEvent = { ...approvalEvent, ...patch, seq: approvalEvent.seq + 1 }; return approvalEvent; },
  };
  const didaService = {
    async validateTaskChange(input) { return input; },
    async createTask(input) { writes.push(['create', input]); return { id: 'created-task', title: input.title }; },
    async updateTask(id, input) { writes.push(['update', id, input]); return { id, title: input.title || input.taskTitle }; },
    async completeTask(id) { writes.push(['complete', id]); return { id, status: 2 }; },
  };
  const reminderService = { async cancelRelatedTask(id, options) { writes.push(['cancel-related', id, options.notifyModel]); } };
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore, didaService, reminderService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1`;
  const proposal = await fetch(`${base}/tasks/change-proposal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'create', projectId: 'p1', title: '写测试', reason: '测试' }) }).then((response) => response.json());
  assert.equal(proposal.proposal.operation, 'create');
  assert.equal(writes.length, 0);
  const accepted = await fetch(`${base}/chat/approvals/approval-task-1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'accept' }) }).then((response) => response.json());
  assert.equal(accepted.event.approval.status, 'accepted');
  assert.deepEqual(writes[0][0], 'create');
  await fetch(`${base}/tasks/t1/complete`, { method: 'POST' });
  assert.deepEqual(writes[1], ['complete', 't1']);
  assert.deepEqual(writes[2], ['cancel-related', 't1', false]);

  approvalEvent = {
    id: 'approval-task-2', seq: 3, role: 'activity', status: 'pending', content: '建议修改滴答任务 · 写测试',
    approval: { kind: 'dida-task-change', status: 'pending', proposal: { operation: 'update', taskId: 't1', taskTitle: '写测试', startAt: null, dueAt: null, reason: '改成无日期' } },
  };
  const cleared = await fetch(`${base}/chat/approvals/approval-task-2`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'accept' }) }).then((response) => response.json());
  assert.equal(cleared.event.approval.status, 'accepted');
  assert.equal(writes[3][0], 'update');
  assert.equal(writes[3][2].startAt, null);
  assert.equal(writes[3][2].dueAt, null);
});

test('one approval creates a Dida task and linked reminder, and partial failure retries only the reminder', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-combo-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const chatEventStore = new ChatEventStore({ dataRoot });
  const proposal = {
    task: { operation: 'create', projectId: 'p1', projectName: '监督清单', title: '写测试', dueAt: '2099-10-29T12:00:00+08:00', repeatFlag: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO', reason: '安排并监督' },
    reminder: { title: '检查进度', message: '问问测试完成了吗', triggerAt: '2099-10-29T12:00:00+08:00', repeatMinutes: 30 },
    reason: '安排并监督',
  };
  await chatEventStore.append({ id: 'approval-combo-1', role: 'activity', status: 'pending', content: '建议新建任务并关联提醒', approval: { kind: 'dida-task-with-reminder', status: 'pending', proposal } });
  let taskCreates = 0;
  let reminderAttempts = 0;
  const reminders = new Map();
  const didaService = {
    async validateTaskChange(input) { return { ...input, projectName: '监督清单' }; },
    async createTask(input) { taskCreates += 1; assert.equal(input.repeatFlag, 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO'); return { id: 'created-task', title: input.title }; },
  };
  const reminderService = {
    async get(id) { return reminders.get(id) || null; },
    async create(input) {
      reminderAttempts += 1;
      if (reminderAttempts === 1) throw new Error('本地写入暂时失败');
      reminders.set(input.id, { ...input, status: 'scheduled' });
      return reminders.get(input.id);
    },
    async reschedule() {},
  };
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore, didaService, reminderService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1`;
  const send = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const suggested = await (await send('/tasks/with-reminder-proposal', proposal)).json();
  assert.equal(suggested.pendingApproval, true);
  assert.equal(suggested.proposal.reminder.title, '写测试');
  assert.equal(suggested.proposal.task.repeatFlag, 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO');
  assert.equal(taskCreates, 0);
  const first = await (await send('/chat/approvals/approval-combo-1', { decision: 'accept' })).json();
  assert.equal(first.event.approval.status, 'task-created');
  assert.match(first.event.content, /提醒未建/);
  assert.equal(taskCreates, 1);
  const retry = await (await send('/chat/approvals/approval-combo-1', { decision: 'accept' })).json();
  assert.equal(retry.event.approval.status, 'accepted');
  assert.equal(taskCreates, 1);
  assert.equal(reminderAttempts, 2);
  assert.equal(reminders.get('reminder_combo_approval-combo-1').relatedTaskId, 'created-task');
  assert.equal(reminders.get('reminder_combo_approval-combo-1').title, '写测试');
  const again = await (await send('/chat/approvals/approval-combo-1', { decision: 'accept' })).json();
  assert.equal(again.event.approval.status, 'accepted');
  assert.equal(taskCreates, 1);
  assert.equal(reminderAttempts, 2);
});

test('expired combo approval does not create a task or reminder', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-combo-expired-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const chatEventStore = new ChatEventStore({ dataRoot });
  await chatEventStore.append({ id: 'approval-combo-expired', role: 'activity', status: 'pending', content: '组合建议', approval: {
    kind: 'dida-task-with-reminder', status: 'pending', proposal: {
      task: { operation: 'create', projectId: 'p1', title: '旧任务', reason: '测试' },
      reminder: { title: '旧提醒', message: '过期', triggerAt: '2020-10-29T12:00:00+08:00' }, reason: '测试',
    },
  } });
  let writes = 0;
  const didaService = { async validateTaskChange(input) { return input; }, async createTask() { writes += 1; return { id: 'bad' }; } };
  const reminderService = { async get() { return null; }, async create() { writes += 1; } };
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore, didaService, reminderService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ethere/v1/chat/approvals/approval-combo-expired`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'accept' }),
  });
  assert.equal(response.status, 409);
  assert.equal(writes, 0);
  assert.equal((await chatEventStore.getById('approval-combo-expired')).approval.status, 'pending');
});

test('uncertain remote task creation stops automatic retries to avoid duplicate Dida tasks', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-combo-uncertain-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const chatEventStore = new ChatEventStore({ dataRoot });
  await chatEventStore.append({ id: 'approval-combo-uncertain', role: 'activity', status: 'pending', content: '组合建议', approval: {
    kind: 'dida-task-with-reminder', status: 'pending', proposal: {
      task: { operation: 'create', projectId: 'p1', title: '写测试', reason: '测试' },
      reminder: { title: '检查', message: '问问进度', triggerAt: '2099-10-29T12:00:00+08:00' }, reason: '测试',
    },
  } });
  let attempts = 0;
  const didaService = {
    async validateTaskChange(input) { return input; },
    async createTask() { attempts += 1; throw new Error('请求超时，远端结果未知'); },
  };
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore, didaService, reminderService: { async get() { return null; } } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const uri = `http://127.0.0.1:${server.address().port}/api/ethere/v1/chat/approvals/approval-combo-uncertain`;
  const approve = () => fetch(uri, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'accept' }) });
  const first = await (await approve()).json();
  assert.equal(first.event.approval.status, 'task-uncertain');
  const second = await (await approve()).json();
  assert.equal(second.event.approval.status, 'task-uncertain');
  assert.equal(attempts, 1);
});

test('server manages memory and only writes an AI proposal after approval', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-server-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const memoryStore = new MemoryStore({ dataRoot, idFactory: () => 'memory-approved' });
  const chatEventStore = new ChatEventStore({ dataRoot });
  await memoryStore.initialize();
  await chatEventStore.append({
    id: 'approval-memory-1', role: 'activity', content: '建议记住 · 启动支持', status: 'pending',
    approval: { kind: 'memory-change', status: 'pending', proposal: { operation: 'create', title: '启动支持', contentMarkdown: '开始前先缩小任务。', reason: '长期重复出现。' } },
  });
  const applied = [];
  const chatService = { async applyMemoryChange(memory, action) { applied.push([memory.id, action]); return { applied: true }; } };
  const server = createEthereServer({ webRoot, chatService, attachmentStore: {}, chatEventStore, memoryStore });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1`;
  assert.equal((await fetch(`${base}/memory`).then((response) => response.json())).activeCount, 0);
  const accepted = await fetch(`${base}/chat/approvals/approval-memory-1`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'accept' }),
  }).then((response) => response.json());
  assert.equal(accepted.event.approval.status, 'accepted');
  const list = await fetch(`${base}/memory`).then((response) => response.json());
  assert.equal(list.memories[0].title, '启动支持');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(applied, [['memory-approved', 'upsert']]);
  assert.equal((await chatEventStore.listAfter(0)).events.filter((item) => item.source === 'memory' && item.role === 'notice').length, 1);
});

test('approved memory promotion keeps its original node and source', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-promotion-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const memoryNodeStore = new MemoryNodeStore({ dataRoot, idFactory: () => 'node-original' });
  const memoryStore = new UnifiedMemoryStore({ dataRoot, memoryNodeStore });
  const chatEventStore = new ChatEventStore({ dataRoot });
  await memoryStore.initialize();
  const node = await memoryNodeStore.create({ topicKey: '关系认识', content: '先听见对方。', status: 'active' });
  await memoryNodeStore.addSource(node.id, { type: 'chat', id: 'source-1' });
  await chatEventStore.append({
    id: 'approval-memory-promote', role: 'activity', content: '建议升级常驻', status: 'pending',
    approval: { kind: 'memory-change', status: 'pending', proposal: { operation: 'promote', targetMemoryId: node.id, baseRevision: node.revision, title: '关系认识', contentMarkdown: '先听见对方，再处理事情。', reason: '每个新线程都应记得。' } },
  });
  const server = createEthereServer({ webRoot, chatService: {}, attachmentStore: {}, chatEventStore, memoryStore, memoryNodeStore });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1`;
  const response = await fetch(`${base}/chat/approvals/approval-memory-promote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'accept' }),
  });
  const accepted = await response.json();
  assert.equal(response.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.event.approval.status, 'accepted');
  assert.equal(accepted.event.approval.memoryId, node.id);
  assert.equal((await memoryNodeStore.get(node.id)).sources[0].id, 'source-1');
  assert.equal((await memoryStore.get(node.id)).contentMarkdown, '先听见对方，再处理事情。');
  assert.match((await chatEventStore.listAfter(0)).events.find((item) => item.source === 'memory')?.content || '', /已升级为核心记忆/);
});

test('memory approval responds before slow live-thread synchronization completes', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-approval-async-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const memoryStore = new MemoryStore({ dataRoot });
  const chatEventStore = new ChatEventStore({ dataRoot });
  await memoryStore.initialize();
  await chatEventStore.append({ id: 'slow-memory', role: 'activity', content: '建议记忆', status: 'pending', approval: {
    kind: 'memory-change', status: 'pending', proposal: { operation: 'create', title: '慢同步', contentMarkdown: '已落盘。', reason: '测试' },
  } });
  let finishApply;
  const waitForApply = new Promise((resolve) => { finishApply = resolve; });
  const chatService = { async applyMemoryChange() { await waitForApply; return { applied: true, status: 'applied' }; } };
  const server = createEthereServer({ webRoot, chatService, attachmentStore: {}, chatEventStore, memoryStore });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { finishApply(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/ethere/v1`;
  const response = await fetch(`${base}/chat/approvals/slow-memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'accept' }) });
  const accepted = await response.json();
  assert.equal(accepted.event.approval.status, 'accepted');
  assert.equal(accepted.event.approval.application.status, 'pending');
  assert.equal((await memoryStore.list()).memories.length, 1);
  finishApply();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await chatEventStore.listAfter(0)).events.find((item) => item.id === 'slow-memory')?.approval?.application?.status, 'applied');
});

test('changing the model stores an activity event and returns the rescheduled check-in', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  let settings = { bossName: 'Boss', model: 'default', checkin: { enabled: true, minMinutes: 30, maxMinutes: 90 } };
  const events = [];
  const server = createEthereServer({
    webRoot,
    chatService: {},
    attachmentStore: {},
    chatEventStore: {
      async append(event) { const stored = { ...event, seq: events.length + 1 }; events.push(stored); return stored; },
    },
    configStore: {
      async getSettings() { return settings; },
      async updateSettings(patch) { settings = { ...settings, ...patch }; return settings; },
    },
    checkinService: {
      async reschedule() { return { enabled: true, nextAt: '2026-10-29T04:00:00.000Z' }; },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/ethere/v1/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-test' }),
  }).then((result) => result.json());
  assert.equal(response.model, 'gpt-test');
  assert.equal(response.checkin.nextAt, '2026-10-29T04:00:00.000Z');
  assert.equal(response.activityCursor, 1);
  assert.equal(events[0].role, 'activity');
  assert.equal(events[0].source, 'settings');
  assert.match(events[0].content, /gpt-test/);
});

test('saving persona reports model application separately from server persistence', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  let savedText = '';
  const server = createEthereServer({
    webRoot,
    chatService: { refreshInstructions: async () => ({ applied: true, status: 'applied', instructionRevision: 'r2', appliedInstructionRevision: 'r2' }) },
    attachmentStore: {},
    chatEventStore: {},
    configStore: {
      async writeDocument(name, text) { savedText = text; return { name, text, revision: 'r2', changed: true }; },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/ethere/v1/documents/persona`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '新版人设' }),
  }).then((result) => result.json());

  assert.equal(savedText, '新版人设');
  assert.equal(response.application.applied, true);
  assert.equal(response.application.appliedInstructionRevision, 'r2');
});

test('starting a new runtime thread keeps chat history and appends a boundary activity', async (context) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'ethere-web-test-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Ethere</title>');
  const events = [];
  const server = createEthereServer({
    webRoot,
    chatService: { startNewThread: async () => ({ started: true, previousThreadId: 'old-thread', threadId: null, createdAt: '2026-10-29T06:00:00.000Z' }) },
    attachmentStore: {},
    chatEventStore: { async append(event) { const stored = { ...event, seq: events.length + 1 }; events.push(stored); return stored; } },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/ethere/v1/runtime/thread/new`, { method: 'POST' }).then((result) => result.json());

  assert.equal(response.started, true);
  assert.equal(response.previousThreadId, 'old-thread');
  assert.equal(events[0].source, 'thread');
  assert.equal(events[0].content, '已开始新的对话线程');
});
