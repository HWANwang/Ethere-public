import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatEventStore } from '../server/chat-event-store.mjs';
import { MemoryNodeStore } from '../server/memory-node-store.mjs';
import { UnifiedMemoryStore } from '../server/unified-memory-store.mjs';
import { ChatService } from '../server/chat-service.mjs';

const mcpScript = fileURLToPath(new URL('../server/ethere-mcp-server.mjs', import.meta.url));

test('App and a real MCP child share explicit data: both tiers, source revision, approval and next-thread injection', async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-e2e-'));
  const appEvents = new ChatEventStore({ dataRoot });
  const appNodes = new MemoryNodeStore({ dataRoot });
  const appMemory = new UnifiedMemoryStore({ dataRoot, memoryNodeStore: appNodes });
  await appMemory.initialize();
  await appEvents.append({ id: 'pottery-first', role: 'user', content: '小时候学过陶艺，现在想重新练。' });
  await appEvents.append({ id: 'pottery-later', role: 'user', content: '隔了几天，我发现有明确反馈时更想陶艺练习。' });
  const approvedCore = await appMemory.create({ title: '相处偏好', contentMarkdown: '喜欢自然、温暖的陪伴。', approved: true });

  const child = spawn(process.execPath, [mcpScript], {
    env: { ...process.env, ETHERE_DATA_DIR: dataRoot, ETHERE_API_BASE: 'http://127.0.0.1:1', ETHERE_ENABLE_LEGACY_MEMORY_NODES: 'true' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  context.after(() => child.kill());
  let buffer = '';
  let nextId = 0;
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const pending = waiting.get(message.id);
      if (pending) { waiting.delete(message.id); pending(message); }
    }
  });
  async function request(method, params = {}) {
    const id = ++nextId;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 10_000);
      waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }
  async function call(name, args) {
    const reply = await request('tools/call', { name, arguments: args });
    assert.equal(reply.result?.isError, undefined, reply.result?.content?.[0]?.text);
    return JSON.parse(reply.result.content[0].text);
  }

  await request('initialize', { protocolVersion: '2024-11-05' });
  const created = await call('ethere_memory_node_create', {
    topicKey: '陶艺', content: '小时候学过陶艺，现在想重新练。', aliases: ['陶艺练习'],
    sources: [{ type: 'chat', id: 'pottery-first' }],
  });
  assert.equal(created.node.tier, 'retrievable');
  assert.equal((await appNodes.get(created.node.id)).sources[0].id, 'pottery-first');

  const found = await call('ethere_memory_nodes_search', { query: '陶艺 相处偏好' });
  assert.deepEqual(found.groups.map((group) => group.term), ['陶艺', '相处偏好']);
  assert.equal(found.nodes.find((node) => node.id === created.node.id).tierLabel, '按需记忆');
  assert.equal(found.nodes.find((node) => node.id === approvedCore.id).tierLabel, '核心记忆');
  const opened = await call('ethere_memory_node_open', { id: created.node.id });
  assert.match(opened.sources[0].content, /小时候学过陶艺/);

  const revised = await call('ethere_memory_node_revise', {
    nodeId: created.node.id, baseRevision: opened.node.revision,
    content: '小时候学过陶艺；明确反馈可能使陶艺练习更有动力。', aliases: ['学陶艺'],
    sources: [{ type: 'chat', id: 'pottery-later', relation: 'supports' }],
  });
  assert.equal(revised.node.id, created.node.id);
  assert.equal((await appNodes.get(created.node.id)).sources.length, 2);
  const duplicate = await request('tools/call', { name: 'ethere_memory_node_create', arguments: {
    topicKey: '学陶艺', content: '重复主题', sources: [{ type: 'chat', id: 'pottery-later' }],
  } });
  assert.equal(duplicate.result.isError, true);
  assert.equal(JSON.parse(duplicate.result.content[0].text).error.code, 'NODE_EXISTS');

  const proposal = await call('ethere_memory_propose', {
    operation: 'promote', targetMemoryId: created.node.id, baseRevision: revised.node.revision,
    title: '陶艺', contentMarkdown: '陶艺练习时明确反馈能帮助保持动力。', reason: '长期学习偏好',
  });
  assert.equal(proposal.pendingApproval, true);
  assert.equal((await appNodes.get(created.node.id)).tier, 'retrievable');
  await appMemory.promote(created.node.id, proposal.proposal, { baseRevision: proposal.proposal.baseRevision });
  assert.equal((await appNodes.get(created.node.id)).tier, 'core');
  assert.match((await appMemory.context()).text, /陶艺练习时明确反馈/);

  const calls = [];
  const client = {
    async initialize() {}, onMessage(listener) { this.listener = listener; return () => { this.listener = null; }; },
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'thread/start') return { thread: { id: `new-thread-${calls.filter(([kind]) => kind === 'thread/start').length}` } };
      if (method === 'turn/start') {
        queueMicrotask(() => this.listener?.({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn-1', status: 'completed' } } }));
        return { turn: { id: 'turn-1' } };
      }
      return {};
    },
  };
  const configStore = {
    getSettings: async () => ({ model: 'default' }),
    readRuntimeInstructions: async () => ({ persona: '', operations: '', revision: 'docs' }),
  };
  const chat = new ChatService({ client, dataRoot, configStore, memoryStore: appMemory, memoryNodeStore: appNodes });
  await chat.sendText('你好');
  await chat.startNewThread();
  await chat.sendText('又见面了');
  const starts = calls.filter(([kind]) => kind === 'thread/start');
  assert.equal(starts.length, 2);
  assert.match(starts[1][1].developerInstructions, /陶艺练习时明确反馈/);
  assert.doesNotMatch(starts[1][1].developerInstructions, /pottery-first/);
});
