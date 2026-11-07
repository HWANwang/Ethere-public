import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryMcpTools } from '../server/memory-mcp-tools.mjs';
import { createMemoryV2McpTools, MEMORY_V2_MCP_TOOL_NAMES } from '../server/memory-v2-mcp-tools.mjs';
import { MemoryV2Client } from '../server/memory-v2-client.mjs';
import { MemoryV2SourceSync } from '../server/memory-v2-source-sync.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('生产工具面只保留核心审批、原始聊天与 V2 记忆工具', () => {
  const core = createMemoryMcpTools({
    memoryStore: { list: async () => ({ memories: [] }) },
    memoryNodeStore: {},
    chatEventStore: { listHistory: async () => ({ events: [], hasMore: false }) },
    includeLegacyNodes: false,
    includePromotion: false,
  }).list();
  const coreNames = core.map((tool) => tool.name);
  assert.deepEqual(coreNames, ['ethere_memory_list', 'ethere_memory_propose', 'ethere_chat_history_search']);
  assert.deepEqual(core.find((tool) => tool.name === 'ethere_memory_propose').inputSchema.properties.operation.enum, ['create', 'update']);
  assert.ok(coreNames.every((name) => !name.startsWith('ethere_memory_node_')));
});

test('V2 工具完整覆盖搜索、打开、关系、证据和纠错', () => {
  const client = {
    search: async () => ({}), getMemory: async () => ({}), getRelated: async () => ({}),
    getEvidence: async () => ({}), reportIssue: async () => ({}),
  };
  assert.deepEqual(createMemoryV2McpTools({ client }).list().map((tool) => tool.name), [...MEMORY_V2_MCP_TOOL_NAMES]);
});

test('V2 工具输入边界和只读标记与五项操作一致', () => {
  const tools = createMemoryV2McpTools({ client: {} }).list();
  assert.deepEqual(tools.map(({ name, inputSchema, annotations }) => ({ name, required: inputSchema.required, readOnly: annotations.readOnlyHint })), [
    { name: 'search_memories', required: ['query'], readOnly: true },
    { name: 'get_memory', required: ['memory_id'], readOnly: true },
    { name: 'get_related_memories', required: ['memory_id'], readOnly: true },
    { name: 'get_memory_evidence', required: ['memory_id'], readOnly: true },
    { name: 'report_memory_issue', required: ['memory_id', 'issue_type'], readOnly: false },
  ]);
  assert.ok(tools.every((tool) => tool.inputSchema.additionalProperties === false));
  assert.deepEqual(tools.at(-1).inputSchema.properties.issue_type.enum,
    ['incorrect', 'outdated', 'mixed', 'missing_context', 'forget_requested']);
});

test('V2 recall fails open when the independent service is unavailable', async () => {
  const client = new MemoryV2Client({ baseUrl: 'http://127.0.0.1:1', recallTimeoutMs: 20 });
  const result = await client.recallForTurn('陶艺');
  assert.deepEqual(result.memories, []);
  assert.equal(result.degraded, true);
});

test('V2 source cursor advances only after an idempotent import succeeds', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-v2-sync-'));
  let attempts = 0;
  const imported = [];
  const client = { async importSources(records) { attempts += 1; if (attempts === 1) throw new Error('offline'); imported.push(...records); } };
  const chatEventStore = { async listAfter(cursor) { return cursor ? { events: [], cursor } : { events: [
    { seq: 1, id: 'u1', role: 'user', content: '我学过陶艺', createdAt: '2026-11-01T10:00:00Z' },
    { seq: 2, id: 'n1', role: 'notice', content: '通知' },
  ], cursor: 2 }; } };
  const sync = new MemoryV2SourceSync({ client, chatEventStore,
    timelineStore: { query: async () => [] }, spaceStore: { list: async () => ({ posts: [] }) }, dataRoot });
  try {
    await sync.tick();
    assert.equal(sync.cursor, 0);
    await sync.tick();
    assert.equal(sync.cursor, 2);
    assert.deepEqual(imported.map((record) => record.externalId), ['u1']);
    assert.equal(JSON.parse(await readFile(join(dataRoot, 'runtime', 'memory-v2-sync.json'))).chatCursor, 2);
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});
