import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../server/memory-store.mjs';
import { MemoryNodeStore } from '../server/memory-node-store.mjs';
import { UnifiedMemoryStore } from '../server/unified-memory-store.mjs';
import { ChatEventStore } from '../server/chat-event-store.mjs';
import { createMemoryMcpTools } from '../server/memory-mcp-tools.mjs';

test('memory MCP only proposes changes and identifies duplicate candidates', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-mcp-'));
  const store = new MemoryStore({ dataRoot, idFactory: () => 'memory-one' });
  await store.initialize();
  await store.create({ title: '独处时的情绪变化', contentMarkdown: '长时间独处后更容易陷入低落。' });
  const tools = createMemoryMcpTools({ memoryStore: store });
  const listed = await tools.call('ethere_memory_list', { query: '独处' });
  assert.deepEqual(listed.memories.map(({ id, title }) => ({ id, title })), [{ id: 'memory-one', title: '独处时的情绪变化' }]);
  assert.match(listed.memories[0].contentMarkdown, /低落/);
  const proposal = await tools.call('ethere_memory_propose', {
    operation: 'create', title: '独处时的情绪变化', contentMarkdown: '独处后容易低落，需要轻柔提醒。', reason: '这是跨线程反复出现的模式。',
  });
  assert.equal(proposal.pendingApproval, true);
  assert.equal(proposal.proposal.duplicateCandidate.memoryId, 'memory-one');
  assert.equal((await store.list()).memories.length, 1);
  assert.match(tools.list().find((item) => item.name === 'ethere_memory_propose').description, /核心记忆的新增、更新或按需记忆节点晋升建议/);
  assert.doesNotMatch(tools.list().find((item) => item.name === 'ethere_memory_propose').description, /待办、提醒和时间线事件不要写入记忆/);
});

test('memory MCP update requires an existing stable memory id', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-mcp-'));
  const store = new MemoryStore({ dataRoot });
  await store.initialize();
  const tools = createMemoryMcpTools({ memoryStore: store });
  await assert.rejects(() => tools.call('ethere_memory_propose', {
    operation: 'update', targetMemoryId: 'missing', title: '主题', contentMarkdown: '完整内容', reason: '长期稳定。',
  }), /不存在或已经归档.*当前有效主题与 ID/);
});

test('memory MCP promotion requires the current retrievable node revision', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-promote-mcp-'));
  const memoryNodeStore = new MemoryNodeStore({ dataRoot, idFactory: () => 'node-promote' });
  const memoryStore = new UnifiedMemoryStore({ dataRoot, memoryNodeStore });
  await memoryStore.initialize();
  const node = await memoryNodeStore.create({ topicKey: '相处默契', content: '会回来继续聊。', status: 'active' });
  const tools = createMemoryMcpTools({ memoryStore, memoryNodeStore });
  const args = { operation: 'promote', targetMemoryId: node.id, title: '相处默契', contentMarkdown: '会回来继续聊。', reason: '每个新线程都需要。' };
  await assert.rejects(() => tools.call('ethere_memory_propose', { ...args, baseRevision: 2 }), /修订号不匹配/);
  const result = await tools.call('ethere_memory_propose', { ...args, baseRevision: 1 });
  assert.equal(result.proposal.baseRevision, 1);
  assert.equal(result.proposal.targetMemoryId, node.id);
  assert.equal((await memoryNodeStore.get(node.id)).tier, 'retrievable');
});

test('chat history search returns bounded original user and assistant messages for recall', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-chat-search-'));
  const memoryStore = new MemoryStore({ dataRoot });
  const chatEventStore = new ChatEventStore({ dataRoot });
  await chatEventStore.append({ id: 'old-user', role: 'user', content: '我以前喜欢做陶艺。' });
  await chatEventStore.append({ id: 'old-activity', role: 'activity', content: '已记录陶艺' });
  await chatEventStore.append({ id: 'old-assistant', role: 'assistant', content: '你说过陶艺很重要。' });
  const tools = createMemoryMcpTools({ memoryStore, chatEventStore });
  const result = await tools.call('ethere_chat_history_search', { query: '陶艺' });
  assert.deepEqual(result.events.map((event) => event.id), ['old-user', 'old-assistant']);
  assert.equal(result.hasMore, false);
});

test('memory MCP searches both tiers and creates an immediately active source-backed node', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-memory-create-mcp-'));
  const memoryNodeStore = new MemoryNodeStore({ dataRoot });
  const memoryStore = new UnifiedMemoryStore({ dataRoot, memoryNodeStore });
  const chatEventStore = new ChatEventStore({ dataRoot });
  await memoryStore.initialize();
  await chatEventStore.append({ id: 'music-message', role: 'user', content: '学陶艺的时候，我喜欢清楚的反馈。' });
  const core = await memoryNodeStore.create({ topicKey: '音乐经历', content: '小时候学过陶艺。', tier: 'core', status: 'active', approved: true });
  const tools = createMemoryMcpTools({ memoryStore, memoryNodeStore, chatEventStore });
  assert.equal(tools.list().some((tool) => tool.name === 'ethere_memory_node_revise'), true);
  assert.equal(Boolean(tools.list().find((tool) => tool.name === 'ethere_memory_node_revise')?.inputSchema?.properties?.title), true);
  const input = { topicKey: '陶艺练习时的反馈偏好', content: '目前发现，陶艺练习时有反馈可能更容易继续。', aliases: ['学陶艺'], sources: [{ type: 'chat', id: 'music-message' }] };
  await assert.rejects(() => tools.call('ethere_memory_node_create', { ...input, sources: [{ type: 'chat', id: 'missing' }] }), /来源.*不存在/);
  assert.equal((await memoryNodeStore.list()).total, 1);
  const created = await tools.call('ethere_memory_node_create', input);
  assert.equal(created.node.tier, 'retrievable');
  assert.equal(created.node.status, 'active');
  assert.equal(created.node.sourceCount, 1);
  assert.equal((await memoryNodeStore.get(created.node.id)).aliases[0], '学陶艺');
  let notices = (await chatEventStore.listAfter(0)).events.filter((event) => event.source === 'memory');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].content, '已创建记忆');
  await assert.rejects(() => tools.call('ethere_memory_node_create', input), /已有按需记忆节点/);
  await assert.rejects(() => tools.call('ethere_memory_node_create', { ...input, topicKey: '学陶艺' }), /修订已有节点/);
  const found = await tools.call('ethere_memory_nodes_search', { query: '学陶艺 陶艺 音乐经历' });
  assert.equal(found.nodes.find((node) => node.id === core.id).tier, 'core');
  assert.equal(found.nodes.find((node) => node.id === core.id).tierLabel, '核心记忆');
  assert.equal(found.nodes.find((node) => node.id === created.node.id).status, 'active');
  assert.equal(found.queryMode, 'split-by-term');
  assert.deepEqual(found.groups.map((group) => group.term), ['学陶艺', '陶艺', '音乐经历']);
  assert.equal(found.groups[1].nodes.some((node) => node.id === core.id), true);
  assert.equal(found.groups[0].nodes.some((node) => node.id === created.node.id), true);
  const opened = await tools.call('ethere_memory_node_open', { id: created.node.id });
  assert.equal(opened.sources[0].id, 'music-message');
  await chatEventStore.append({ id: 'later-music-message', role: 'user', content: '过了两天，我发现陶艺练习时有反馈更愿意继续。' });
  await assert.rejects(() => tools.call('ethere_memory_node_revise', { nodeId: created.node.id, baseRevision: 1, content: '更新', sources: [{ type: 'chat', id: 'missing' }] }), /来源.*不存在/);
  await assert.rejects(() => tools.call('ethere_memory_node_revise', { nodeId: core.id, baseRevision: 1, sources: [{ type: 'chat', id: 'later-music-message' }] }), /核心内容必须走审批/);
  const revised = await tools.call('ethere_memory_node_revise', {
    nodeId: created.node.id, baseRevision: 1,
    content: '陶艺练习时有反馈可能更容易继续；两天后再次提到这一点，仍待验证。',
    sources: [{ type: 'chat', id: 'later-music-message' }], aliases: ['陶艺练习'],
  });
  assert.equal(revised.revised, true);
  assert.equal(revised.node.revision, 2);
  assert.equal(revised.node.sourceCount, 2);
  assert.equal((await memoryNodeStore.get(created.node.id)).content, '陶艺练习时有反馈可能更容易继续；两天后再次提到这一点，仍待验证。');
  notices = (await chatEventStore.listAfter(0)).events.filter((event) => event.source === 'memory');
  assert.equal(notices.length, 2);
  assert.equal(notices[1].content, '已更新记忆');
  const renamed = await tools.call('ethere_memory_node_revise', {
    nodeId: created.node.id, baseRevision: 2, title: '陶艺练习与反馈',
  });
  assert.equal(renamed.node.topicKey, '陶艺练习与反馈');
  assert.equal(renamed.node.revision, 3);
  const renamedNode = await memoryNodeStore.get(created.node.id);
  assert.equal(renamedNode.sources.length, 2);
  assert.equal(renamedNode.aliases.includes('陶艺练习时的反馈偏好'), true);
  assert.equal((await tools.call('ethere_memory_nodes_search', { query: '陶艺练习时的反馈偏好' })).nodes.some((node) => node.id === created.node.id), true);
  assert.equal((await tools.call('ethere_memory_nodes_search', { query: '陶艺练习与反馈' })).nodes.some((node) => node.id === created.node.id), true);
  await assert.rejects(() => tools.call('ethere_memory_node_revise', { nodeId: created.node.id, baseRevision: 3, title: '音乐经历' }), /已有记忆节点/);
  await assert.rejects(() => tools.call('ethere_memory_node_revise', { nodeId: created.node.id, baseRevision: 1, sources: [{ type: 'chat', id: 'music-message' }] }), /重新打开/);
  for (let index = 0; index < 8; index += 1) {
    const id = `music-extra-${index}`;
    await chatEventStore.append({ id, role: 'user', content: `有关陶艺练习的补充 ${index}` });
    await memoryNodeStore.addSource(created.node.id, { type: 'chat', id });
  }
  const firstPage = await tools.call('ethere_memory_node_open', { id: created.node.id });
  const secondPage = await tools.call('ethere_memory_node_open', { id: created.node.id, sourceOffset: firstPage.nextSourceOffset });
  assert.equal(firstPage.sourceCount, 10);
  assert.equal(firstPage.sources.length, 8);
  assert.equal(secondPage.sources.length, 2);
  assert.equal(secondPage.nextSourceOffset, null);
});
