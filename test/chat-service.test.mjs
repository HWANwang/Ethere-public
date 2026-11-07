import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatService } from '../server/chat-service.mjs';

class FakeCodexClient {
  constructor() {
    this.listeners = new Set();
    this.calls = [];
  }

  async initialize() {
    this.calls.push(['initialize']);
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(message) {
    for (const listener of this.listeners) listener(message);
  }

  async request(method, params) {
    this.calls.push([method, params]);
    if (method === 'thread/start') return { thread: { id: 'ethere-test-thread' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emit({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId: 'turn-1', delta: '你好' } });
        this.emit({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId: 'turn-1', delta: '。' } });
        this.emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn-1', status: 'completed' } } });
      });
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/compact/start') {
      queueMicrotask(() => {
        this.emit({ method: 'item/completed', params: { threadId: params.threadId, item: { id: 'compact-1', type: 'contextCompaction' } } });
      });
      return {};
    }
    return {};
  }
}

test('chat creates an isolated Codex thread, streams text, and stores state outside the repository', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-test-'));
  const client = new FakeCodexClient();
  const service = new ChatService({ client, dataRoot });
  const events = [];
  const phases = [];

  const result = await service.sendMessage({ text: '测试连接', onTiming: (phase) => phases.push(phase) }, (event) => events.push(event));

  assert.equal(result.threadId, 'ethere-test-thread');
  assert.equal(result.text, '你好。');
  assert.deepEqual(events, [{ type: 'delta', delta: '你好' }, { type: 'delta', delta: '。' }]);
  assert.deepEqual(phases, ['modelRequested', 'turnStarted']);
  assert.equal(client.calls.filter(([method]) => method === 'thread/start').length, 1);
  const threadStart = client.calls.find(([method]) => method === 'thread/start')[1];
  assert.doesNotMatch(threadStart.developerInstructions, /你是 Ethere/);
  assert.match(threadStart.developerInstructions, /只允许调用当前运行时已经注册的工具/);
  const turn = client.calls.find(([method]) => method === 'turn/start')[1];
  assert.match(turn.input[0].text, /^\[消息时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 北京时间\]\n\n测试连接$/);
  assert.equal(turn.sandboxPolicy.type, 'readOnly');
  const state = JSON.parse(await readFile(join(dataRoot, 'state', 'chat-session.json'), 'utf8'));
  assert.equal(state.threadId, 'ethere-test-thread');
});

test('a concrete past-conversation question prompts source lookup without loading every memory', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-recall-test-'));
  const client = new FakeCodexClient();
  const memoryNodeStore = { latestHandoff: async () => null };
  let recallOptions;
  const memoryV2Client = { recallForTurn: async (_query, options) => {
    recallOptions=options;
    return { memories: [{ memory_id: 'm1', state: 'watch', content: '曾想重新陶艺练习。' }] };
  } };
  const recentConversation=[{ seq: 3, role: 'user', content: '刚才聊到陶艺练习', createdAt: '2026-11-07T01:00:00.000Z' }];
  await new ChatService({ client, dataRoot, memoryNodeStore, memoryV2Client })
    .sendMessage({ text: '你还记得之前说过陶艺吗？', recentConversation });
  const turn = client.calls.find(([method]) => method === 'turn/start')[1];
  assert.match(turn.input[0].text, /曾想重新陶艺练习/);
  assert.match(turn.input[0].text, /待观察、可修正的判断/);
  assert.deepEqual(recallOptions.context,recentConversation);
  assert.match(turn.input[0].text, /search_memories/);
  assert.match(turn.input[0].text, /ethere_chat_history_search/);
});

test('chat retries a transient active-writer conflict before accepting the turn', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-writer-test-'));
  const client = new FakeCodexClient();
  const request = client.request.bind(client);
  let conflicts = 1;
  client.request = async (method, params) => {
    if (method === 'turn/start' && conflicts-- > 0) {
      client.calls.push([method, params]);
      throw new Error('thread ethere-test-thread already has an active writer');
    }
    return request(method, params);
  };
  const service = new ChatService({ client, dataRoot, activeWriterRetryDelaysMs: [0] });
  const result = await service.sendText('继续说');
  assert.equal(result.text, '你好。');
  assert.equal(client.calls.filter(([method]) => method === 'turn/start').length, 2);
  assert.equal(service.isBusy(), false);
});

test('chat gives a useful retry message when another writer remains active', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-busy-test-'));
  const client = new FakeCodexClient();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'turn/start') {
      client.calls.push([method, params]);
      throw new Error('thread ethere-test-thread already has an active writer');
    }
    return request(method, params);
  };
  const service = new ChatService({ client, dataRoot, activeWriterRetryDelaysMs: [0] });
  await assert.rejects(service.sendText('继续说'), /对话暂时被占用，请稍后点击重试/);
  assert.equal(client.calls.filter(([method]) => method === 'turn/start').length, 2);
  assert.equal(service.isBusy(), false);
});

test('timed-out reply interrupts the remote Codex turn before releasing the chat slot', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-timeout-test-'));
  const client = new FakeCodexClient();
  const originalRequest = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'turn/start') {
      client.calls.push([method, params]);
      return { turn: { id: 'stuck-turn' } };
    }
    if (method === 'turn/interrupt') {
      client.calls.push([method, params]);
      queueMicrotask(() => client.emit({ method: 'turn/completed', params: {
        threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' },
      } }));
      return {};
    }
    return originalRequest(method, params);
  };
  const service = new ChatService({ client, dataRoot, turnTimeoutMs: 15 });
  await assert.rejects(service.sendMessage({ text: '你在吗', source: 'voice' }), /Codex 回复超时/);
  assert.deepEqual(client.calls.find(([method]) => method === 'turn/interrupt')?.[1], {
    threadId: 'ethere-test-thread', turnId: 'stuck-turn',
  });
  assert.equal(service.isBusy(), false);
  assert.equal((await service.runtimeStatus()).operation, null);
});

test('check-in has a shorter hard limit than ordinary chat and releases the writer', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-checkin-timeout-'));
  const client = new FakeCodexClient();
  const originalRequest = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'turn/start') { client.calls.push([method, params]); return { turn: { id: 'checkin-stuck' } }; }
    if (method === 'turn/interrupt') { client.calls.push([method, params]); return {}; }
    return originalRequest(method, params);
  };
  const service = new ChatService({ client, dataRoot, turnTimeoutMs: 1000, checkinTurnTimeoutMs: 15 });
  await assert.rejects(service.sendMessage({ text: 'check-in', source: 'checkin' }), /Codex 回复超时/);
  assert.equal(client.calls.filter(([method]) => method === 'turn/interrupt').length, 1);
  assert.equal(service.isBusy(), false);
});

test('app-server disconnect immediately releases an in-progress reply', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-disconnect-test-'));
  const client = new FakeCodexClient();
  const originalRequest = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'turn/start') {
      client.calls.push([method, params]);
      queueMicrotask(() => client.emit({ method: 'ethere/appServerClosed', params: { error: '连接断开' } }));
      return { turn: { id: 'lost-turn' } };
    }
    return originalRequest(method, params);
  };
  const service = new ChatService({ client, dataRoot, turnTimeoutMs: 10_000 });
  await assert.rejects(service.sendText('你好'), /连接断开/);
  assert.equal(service.isBusy(), false);
});

test('a voice reply preempts background reminder work without treating the reminder as delivered', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-voice-priority-test-'));
  const client = new FakeCodexClient();
  const originalRequest = client.request.bind(client);
  let turns = 0;
  client.request = async (method, params) => {
    if (method === 'turn/start') {
      client.calls.push([method, params]);
      turns += 1;
      const id = `turn-${turns}`;
      if (turns === 2) queueMicrotask(() => client.emit({ method: 'turn/completed', params: {
        threadId: params.threadId, turn: { id, status: 'completed' },
      } }));
      return { turn: { id } };
    }
    if (method === 'turn/interrupt') {
      client.calls.push([method, params]);
      queueMicrotask(() => client.emit({ method: 'turn/completed', params: {
        threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' },
      } }));
      return {};
    }
    return originalRequest(method, params);
  };
  const service = new ChatService({ client, dataRoot });
  const reminder = service.sendMessage({ text: '后台提醒', source: 'reminder' });
  while (!client.calls.some(([method]) => method === 'turn/start')) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await service.runtimeStatus()).operation.kind, 'reminder');
  const voice = await service.sendMessage({ text: '我醒了', source: 'voice' });
  assert.equal(voice.status, 'completed');
  assert.equal((await reminder).status, 'interrupted');
  assert.equal(client.calls.find(([method]) => method === 'turn/interrupt')?.[1].turnId, 'turn-1');
  assert.equal(service.isBusy(), false);
});

test('persona and operation rules are applied once after editing instead of on every message', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-test-'));
  const client = new FakeCodexClient();
  let persona = '第一次人设';
  const configStore = {
    getSettings: async () => ({ model: 'gpt-test' }),
    readRuntimeInstructions: async () => ({ persona, operations: '只做只读操作', revision: persona }),
  };
  const service = new ChatService({ client, dataRoot, configStore });
  await service.sendText('第一条');
  persona = '修改后立刻生效';
  const refreshed = await service.refreshInstructions();
  await service.sendText('第二条');

  const started = client.calls.find(([method]) => method === 'thread/start')[1];
  assert.match(started.developerInstructions, /第一次人设/);
  assert.equal(client.calls.filter(([method]) => method === 'thread/resume').length, 0);
  const turns = client.calls.filter(([method]) => method === 'turn/start');
  assert.match(turns[1][1].input[0].text, /ETHERE SESSION INSTRUCTIONS REFRESH/);
  assert.match(turns[1][1].input[0].text, /修改后立刻生效/);
  assert.match(turns[1][1].input[0].text, /只做只读操作/);
  assert.match(turns[2][1].input[0].text, /第二条$/);
  assert.equal(refreshed.applied, true);
  assert.match(refreshed.appliedInstructionRevision, /^修改后立刻生效:rules-[0-9a-f]{12}$/);
});

test('active memory is read on a new thread and later edits use an internal delta', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-test-'));
  const client = new FakeCodexClient();
  let memoryRevision = 2;
  const configStore = {
    getSettings: async () => ({ model: 'default' }),
    readRuntimeInstructions: async () => ({ persona: '', operations: '', revision: 'docs-1' }),
  };
  const memoryStore = { context: async () => ({ revision: memoryRevision, text: '# 长期记忆\n\n<!-- memory-id: memory-one -->\n## 外出前检查习惯\n\n出门前检查钥匙。\n' }) };
  const service = new ChatService({ client, dataRoot, configStore, memoryStore });
  await service.sendText('第一条');
  const started = client.calls.find(([method]) => method === 'thread/start')[1];
  assert.match(started.developerInstructions, /memory-id: memory-one/);
  memoryRevision = 3;
  const application = await service.applyMemoryChange({ id: 'memory-one', title: '外出前检查习惯', contentMarkdown: '出门前检查钥匙、手机和耳机。' });
  const turns = client.calls.filter(([method]) => method === 'turn/start');
  assert.match(turns.at(-1)[1].input[0].text, /ETHERE MEMORY DELTA/);
  assert.doesNotMatch(turns.at(-1)[1].input[0].text, /当前人设/);
  assert.equal(application.applied, true);
});

test('timeline write tool calls split assistant output with a persistent activity', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-test-'));
  const client = new FakeCodexClient();
  client.request = async (method, params) => {
    client.calls.push([method, params]);
    if (method === 'thread/start') return { thread: { id: 'ethere-test-thread' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        client.emit({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId: 'turn-tool', itemId: 'message-before', delta: '我先帮你记下来。' } });
        client.emit({ method: 'item/completed', params: { threadId: params.threadId, turnId: 'turn-tool', item: {
          id: 'call-1', type: 'mcpToolCall', server: 'ethere_tools', tool: 'ethere_timeline_events_batch_create',
          status: 'completed', arguments: { events: [{}, {}] },
        } } });
        client.emit({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId: 'turn-tool', itemId: 'message-after', delta: '已经记好了。' } });
        client.emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn-tool', status: 'completed' } } });
      });
      return { turn: { id: 'turn-tool' } };
    }
    return {};
  };
  const events = [];
  const result = await new ChatService({ client, dataRoot }).sendText('记一下', (event) => events.push(event));

  assert.deepEqual(events, [
    { type: 'delta', delta: '我先帮你记下来。' },
    { type: 'activity', callId: 'call-1', tool: 'ethere_timeline_events_batch_create', content: '已记录时间线 · 2 条', status: 'completed' },
    { type: 'segment', segment: 1 },
    { type: 'delta', delta: '已经记好了。' },
  ]);
  assert.deepEqual(result.timeline.map((item) => [item.type, item.text || item.content]), [
    ['assistant', '我先帮你记下来。'],
    ['activity', '已记录时间线 · 2 条'],
    ['assistant', '已经记好了。'],
  ]);
});

test('space write tool calls surface a compact activity between assistant segments', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-test-'));
  const client = new FakeCodexClient();
  client.request = async (method, params) => {
    client.calls.push([method, params]);
    if (method === 'thread/start') return { thread: { id: 'ethere-test-thread' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        client.emit({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId: 'turn-space', itemId: 'before', delta: '我记一下。' } });
        client.emit({ method: 'item/completed', params: { threadId: params.threadId, turnId: 'turn-space', item: {
          id: 'space-call', type: 'mcpToolCall', server: 'ethere_tools', tool: 'ethere_space_post_create', status: 'completed', arguments: { contentMarkdown: '观察' },
        } } });
        client.emit({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId: 'turn-space', itemId: 'after', delta: '写好了。' } });
        client.emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn-space', status: 'completed' } } });
      });
      return { turn: { id: 'turn-space' } };
    }
    return {};
  };
  const events = [];
  await new ChatService({ client, dataRoot }).sendText('写到空间', (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.type), ['delta', 'activity', 'segment', 'delta']);
  assert.equal(events[1].content, '已写入空间');
});

test('check-in exposes read tools as activities without changing ordinary chat tool display', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-checkin-tools-'));
  const client = new FakeCodexClient();
  client.request = async (method, params) => {
    client.calls.push([method, params]);
    if (method === 'thread/start') return { thread: { id: 'ethere-test-thread' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        for (const [id, tool] of [['read-1', 'ethere_memory_nodes_search'], ['read-2', 'ethere_reminders_list']]) {
          client.emit({ method: 'item/completed', params: { threadId: params.threadId, turnId: 'turn-checkin', item: {
            id, type: 'mcpToolCall', server: 'ethere_tools', tool, status: 'completed', arguments: {},
          } } });
        }
        client.emit({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId: 'turn-checkin', itemId: 'silent', delta: 'ETHERE_SILENT' } });
        client.emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn-checkin', status: 'completed' } } });
      });
      return { turn: { id: 'turn-checkin' } };
    }
    return {};
  };
  const emitted = [];
  const result = await new ChatService({ client, dataRoot }).sendMessage({ text: 'check-in', source: 'checkin' }, (event) => emitted.push(event));
  assert.deepEqual(emitted.filter((event) => event.type === 'activity').map((event) => event.content), ['已搜索记忆', '已查看提醒']);
  assert.deepEqual(result.timeline.map((item) => item.type), ['activity', 'activity', 'assistant']);
});

test('successful and failed phone usage reads both trigger honest notice callbacks without chat activities', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-phone-usage-test-'));
  const client = new FakeCodexClient();
  client.request = async (method, params) => {
    if (method === 'thread/start') return { thread: { id: 'ethere-test-thread' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        for (const [id, status] of [['phone-read-ok', 'completed'], ['phone-read-failed', 'failed']]) {
          client.emit({ method: 'item/completed', params: { threadId: params.threadId, turnId: 'turn-phone', item: {
            id, type: 'mcpToolCall', server: 'ethere_tools', tool: 'ethere_phone_usage_recent_get', status,
          } } });
        }
        client.emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn-phone', status: 'completed' } } });
      });
      return { turn: { id: 'turn-phone' } };
    }
    return {};
  };
  const reads = [];
  const streamed = [];
  const result = await new ChatService({ client, dataRoot, onPhoneUsageRead: (item) => reads.push([item.id, item.succeeded]) })
    .sendText('看看近况', (event) => streamed.push(event));
  await Promise.resolve();
  assert.deepEqual(reads, [['phone-read-ok', true], ['phone-read-failed', false]]);
  assert.deepEqual(streamed, []);
  assert.deepEqual(result.timeline, []);
});

test('timeline category proposal tool becomes an interactive pending approval', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-test-'));
  const client = new FakeCodexClient();
  client.request = async (method, params) => {
    client.calls.push([method, params]);
    if (method === 'thread/start') return { thread: { id: 'ethere-test-thread' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        client.emit({ method: 'item/completed', params: { threadId: params.threadId, turnId: 'turn-proposal', item: {
          id: 'call-proposal', type: 'mcpToolCall', server: 'ethere_tools', tool: 'ethere_timeline_category_propose', status: 'completed',
          arguments: { level: 'secondary', name: '代码复盘', parentCategoryId: 'work', reason: '适合单独统计反复出现的复盘活动。' },
        } } });
        client.emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn-proposal', status: 'completed' } } });
      });
      return { turn: { id: 'turn-proposal' } };
    }
    return {};
  };
  const result = await new ChatService({ client, dataRoot }).sendText('分类不够用', () => {});
  assert.equal(result.timeline[0].status, 'pending');
  assert.equal(result.timeline[0].approval.kind, 'timeline-category-create');
  assert.equal(result.timeline[0].approval.proposal.name, '代码复盘');
});

test('Dida task proposals become approvals while explicit completion is a direct activity', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-test-'));
  const client = new FakeCodexClient();
  client.request = async (method, params) => {
    client.calls.push([method, params]);
    if (method === 'thread/start') return { thread: { id: 'ethere-test-thread' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        client.emit({ method: 'item/completed', params: { threadId: params.threadId, turnId: 'turn-task', item: {
          id: 'call-task-proposal', type: 'mcpToolCall', server: 'ethere_tools', tool: 'ethere_task_change_propose', status: 'completed',
          arguments: { operation: 'create', projectId: 'p1', projectName: '监督清单', title: '写测试', dueAt: '2026-11-02T20:00:00+08:00', repeatFlag: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO', reason: '用户想安排这件事' },
        } } });
        client.emit({ method: 'item/completed', params: { threadId: params.threadId, turnId: 'turn-task', item: {
          id: 'call-task-complete', type: 'mcpToolCall', server: 'ethere_tools', tool: 'ethere_task_complete', status: 'completed',
          arguments: { taskId: 't1', taskTitle: '测试' },
        } } });
        client.emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn-task', status: 'completed' } } });
      });
      return { turn: { id: 'turn-task' } };
    }
    return {};
  };
  const result = await new ChatService({ client, dataRoot }).sendText('加一个任务，测试我已完成', () => {});
  assert.equal(result.timeline[0].approval.kind, 'dida-task-change');
  assert.equal(result.timeline[0].approval.status, 'pending');
  assert.equal(result.timeline[0].approval.proposal.projectName, '监督清单');
  assert.equal(result.timeline[0].approval.proposal.repeatFlag, 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO');
  assert.equal(result.timeline[1].content, '已完成滴答任务 · 测试');
});

test('combined Dida task and reminder proposal becomes a single pending approval', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-test-'));
  const client = new FakeCodexClient();
  client.request = async (method, params) => {
    client.calls.push([method, params]);
    if (method === 'thread/start') return { thread: { id: 'ethere-combo-thread' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        client.emit({ method: 'item/completed', params: { threadId: params.threadId, turnId: 'turn-combo', item: {
          id: 'call-task-reminder', type: 'mcpToolCall', server: 'ethere_tools', tool: 'ethere_task_with_reminder_propose', status: 'completed',
          arguments: { task: { projectId: 'p1', projectName: '监督清单', title: '写测试', dueAt: '2099-10-29T12:00:00+08:00', repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1' }, reminder: { message: '问问进度', triggerAt: '2099-10-29T12:00:00+08:00' }, reason: '用户想安排和监督' },
        } } });
        client.emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn-combo', status: 'completed' } } });
      });
      return { turn: { id: 'turn-combo' } };
    }
    return {};
  };
  const result = await new ChatService({ client, dataRoot }).sendText('安排任务并提醒', () => {});
  assert.equal(result.timeline.length, 1);
  assert.equal(result.timeline[0].approval.kind, 'dida-task-with-reminder');
  assert.equal(result.timeline[0].approval.proposal.task.title, '写测试');
  assert.equal(result.timeline[0].approval.proposal.task.repeatFlag, 'RRULE:FREQ=DAILY;INTERVAL=1');
  assert.equal(result.timeline[0].approval.proposal.reminder.title, '写测试');
});

test('starting a new thread clears only the model binding and keeps instructions for the next message', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-test-'));
  const client = new FakeCodexClient();
  const configStore = {
    getSettings: async () => ({ model: 'default' }),
    readRuntimeInstructions: async () => ({ persona: '新线程人设', operations: '', revision: 'revision-2' }),
  };
  const service = new ChatService({ client, dataRoot, configStore });
  await service.sendText('旧线程消息');
  const reset = await service.startNewThread();
  await service.sendText('新线程消息');

  assert.equal(reset.previousThreadId, 'ethere-test-thread');
  assert.equal(client.calls.filter(([method]) => method === 'thread/start').length, 2);
  const secondStart = client.calls.filter(([method]) => method === 'thread/start')[1][1];
  assert.match(secondStart.developerInstructions, /新线程人设/);
  const state = JSON.parse(await readFile(join(dataRoot, 'state', 'chat-session.json'), 'utf8'));
  assert.match(state.appliedInstructionRevision, /^revision-2:rules-[0-9a-f]{12}$/);
});

test('runtime model catalog and manual compaction use app-server RPC', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-test-'));
  const client = new FakeCodexClient();
  const originalRequest = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'model/list') { client.calls.push([method, params]); return { data: [{ id: 'm1', model: 'gpt-test', displayName: 'GPT Test', description: 'test', isDefault: true }] }; }
    return originalRequest(method, params);
  };
  const service = new ChatService({ client, dataRoot });
  await service.sendText('建立线程');
  const models = await service.listModels();
  const compacted = await service.compactThread();

  assert.deepEqual(models.models[0], { id: 'gpt-test', label: 'GPT Test', description: 'test', isDefault: true });
  assert.equal(compacted.compacted, true);
  assert.ok(client.calls.some(([method]) => method === 'thread/compact/start'));
});

test('chat reuses its own thread for the next turn without repeating opening instructions', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-test-'));
  const client = new FakeCodexClient();
  const service = new ChatService({ client, dataRoot });
  await service.sendText('第一条');
  await service.sendText('第二条');

  assert.equal(client.calls.filter(([method]) => method === 'thread/start').length, 1);
  const turns = client.calls.filter(([method]) => method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.match(turns[1][1].input[0].text, /\n\n第二条$/);
});

test('chat sends persisted images to Codex as localImage input', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-test-'));
  const client = new FakeCodexClient();
  const service = new ChatService({ client, dataRoot });
  const imagePath = join(dataRoot, 'attachments', 'chat', 'blue.jpg');

  await service.sendMessage({ text: '这是什么颜色？', attachments: [{ type: 'image', absolutePath: imagePath }] });

  const turn = client.calls.find(([method]) => method === 'turn/start')[1];
  assert.deepEqual(turn.input.at(-1), { type: 'localImage', path: imagePath });
});

test('a new message can interrupt the active Codex turn and keep its partial reply', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-test-'));
  const client = new FakeCodexClient();
  client.request = async function request(method, params) {
    this.calls.push([method, params]);
    if (method === 'thread/start') return { thread: { id: 'ethere-test-thread' } };
    if (method === 'turn/start') {
      queueMicrotask(() => this.emit({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId: 'turn-long', delta: '已经生成的部分' } }));
      return { turn: { id: 'turn-long' } };
    }
    if (method === 'turn/interrupt') {
      queueMicrotask(() => this.emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } } }));
      return { ok: true };
    }
    return {};
  };
  const service = new ChatService({ client, dataRoot });
  const events = [];
  const sending = service.sendText('请写一篇很长的文章', (event) => events.push(event));
  while (!client.calls.some(([method]) => method === 'turn/start')) await new Promise((resolve) => setImmediate(resolve));

  const stopped = await service.interruptActive();
  const result = await sending;

  assert.equal(stopped.interrupted, true);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.text, '已经生成的部分');
  assert.deepEqual(client.calls.find(([method]) => method === 'turn/interrupt')[1], { threadId: 'ethere-test-thread', turnId: 'turn-long' });
  assert.deepEqual(events.at(-1), { type: 'interrupted' });
});
