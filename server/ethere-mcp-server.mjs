import { writeSync } from 'node:fs';
import { TimelineStore } from './timeline-store.mjs';
import { createTimelineMcpTools } from './timeline-mcp-tools.mjs';
import { MemoryNodeStore } from './memory-node-store.mjs';
import { UnifiedMemoryStore } from './unified-memory-store.mjs';
import { ChatEventStore } from './chat-event-store.mjs';
import { SpaceStore } from './space-store.mjs';
import { createMemoryMcpTools } from './memory-mcp-tools.mjs';
import { MemoryV2Client } from './memory-v2-client.mjs';
import { createMemoryV2McpTools } from './memory-v2-mcp-tools.mjs';
import { ConfigStore } from './config-store.mjs';
import { createDocumentMcpTools } from './document-mcp-tools.mjs';
import { createTaskMcpTools } from './task-mcp-tools.mjs';
import { createReminderMcpTools } from './reminder-mcp-tools.mjs';
import { createSpaceMcpTools } from './space-mcp-tools.mjs';
import { createPhoneUsageMcpTools } from './phone-usage-mcp-tools.mjs';
import { DeveloperBridgeClient } from './developer-bridge-client.mjs';
import { createDeveloperTaskMcpTools } from './developer-task-mcp-tools.mjs';
import { createDeviceActionMcpTools } from './device-action-mcp-tools.mjs';
import { StudyPlanStore } from './study-plan-store.mjs';
import { createStudyMcpTools } from './study-mcp-tools.mjs';
import { createBossMcpTools } from './boss-mcp-tools.mjs';
import { resolveDataRoot } from './paths.mjs';

if (!process.env.ETHERE_DATA_DIR) throw new Error('Ethere MCP 需要显式 ETHERE_DATA_DIR；拒绝使用默认 LocalAppData 目录');
const dataRoot = resolveDataRoot();
const timelineStore = new TimelineStore({ dataRoot });
const memoryNodeStore = new MemoryNodeStore({ dataRoot });
const memoryStore = new UnifiedMemoryStore({ dataRoot, memoryNodeStore });
const chatEventStore = new ChatEventStore({ dataRoot });
const spaceStore = new SpaceStore({ dataRoot });
const configStore = new ConfigStore({ dataRoot });
const studyPlanStore = new StudyPlanStore({ dataRoot });
await timelineStore.initialize();
await memoryNodeStore.initialize();
await memoryStore.initialize();
await spaceStore.initialize();
await studyPlanStore.initialize();
const timelineTools = createTimelineMcpTools({ timelineStore });
const legacyMemoryNodesEnabled = process.env.ETHERE_ENABLE_LEGACY_MEMORY_NODES === 'true';
const memoryTools = createMemoryMcpTools({ memoryStore, memoryNodeStore, chatEventStore, spaceStore, timelineStore, includeLegacyNodes: legacyMemoryNodesEnabled, includePromotion: legacyMemoryNodesEnabled });
const memoryV2Tools = createMemoryV2McpTools({ client: new MemoryV2Client() });
const documentTools = createDocumentMcpTools({ configStore });
const taskTools = createTaskMcpTools();
const reminderTools = createReminderMcpTools();
const spaceTools = createSpaceMcpTools();
const phoneUsageTools = createPhoneUsageMcpTools();
const developerTools = createDeveloperTaskMcpTools({ bridge: new DeveloperBridgeClient({
  dataRoot, baseUrl: process.env.ETHERE_DEVELOPER_BRIDGE_BASE || 'http://127.0.0.1:4174',
}) });
const deviceActionTools = createDeviceActionMcpTools();
const studyTools = createStudyMcpTools({ studyPlanStore });
const bossTools = createBossMcpTools({ dataRoot });
const toolGroups = [timelineTools, memoryTools, memoryV2Tools, documentTools, taskTools, reminderTools, spaceTools, phoneUsageTools, developerTools, deviceActionTools, studyTools, bossTools];
const reader = createMessageReader(process.stdin);

reader.onMessage(async (message) => {
  if (!message || typeof message !== 'object') return;
  const { id, method, params = {} } = message;
  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ethere-tools', version: '0.1.0' },
        instructions: '这些工具管理用户的私有时间轴、核心记忆、受监督任务、提醒、空间和学习计划，并可只读搜索 BOSS 职位。按每个工具的 description 与参数 schema 选择和调用工具；不要向用户暴露内部 ID、版本号或原始 JSON。BOSS 工具绝不执行打招呼、投递或跟进。',
      }, reader.mode());
      return;
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
    if (method === 'ping') return respond(id, {}, reader.mode());
    if (method === 'tools/list') return respond(id, { tools: toolGroups.flatMap((group) => group.list()) }, reader.mode());
    if (method === 'tools/call') {
      try {
        const name = String(params.name || '');
        const group = toolGroups.find((candidate) => candidate.list().some((tool) => tool.name === name));
        if (!group) throw Object.assign(new Error(`未知工具：${name}`), { code: 'UNKNOWN_TOOL' });
        const data = await group.call(name, params.arguments || {});
        return respond(id, { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data }) }] }, reader.mode());
      } catch (error) {
        const payload = {
          ok: false,
          error: {
            code: error?.code || httpCodeName(error?.statusCode),
            message: error instanceof Error ? error.message : String(error),
            ...(error?.currentRevision ? { currentRevision: error.currentRevision } : {}),
          },
        };
        return respond(id, { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true }, reader.mode());
      }
    }
    fail(id, -32601, `Method not found: ${method}`, reader.mode());
  } catch (error) {
    fail(id, -32603, error instanceof Error ? error.message : String(error), reader.mode());
  }
});

function createMessageReader(stream) {
  let buffer = Buffer.alloc(0);
  let transport = 'content-length';
  const listeners = new Set();
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (buffer.length) {
      const headerEnd = findHeaderEnd(buffer);
      if (headerEnd >= 0) {
        transport = 'content-length';
        const separatorLength = buffer[headerEnd] === 13 ? 4 : 2;
        const header = buffer.subarray(0, headerEnd).toString('utf8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) { buffer = Buffer.alloc(0); return; }
        const length = Number(match[1]);
        const start = headerEnd + separatorLength;
        if (buffer.length < start + length) return;
        emit(buffer.subarray(start, start + length).toString('utf8'));
        buffer = buffer.subarray(start + length);
        continue;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.subarray(0, newline).toString('utf8').trim();
      buffer = buffer.subarray(newline + 1);
      if (!line) continue;
      transport = 'jsonl';
      emit(line);
    }
  });
  function emit(text) {
    try {
      const message = JSON.parse(text);
      for (const listener of listeners) listener(message);
    } catch { /* ignore malformed protocol input */ }
  }
  return {
    onMessage(listener) { listeners.add(listener); },
    mode() { return transport; },
  };
}

function findHeaderEnd(buffer) {
  const crlf = buffer.indexOf('\r\n\r\n');
  return crlf >= 0 ? crlf : buffer.indexOf('\n\n');
}

function respond(id, result, mode) {
  writeMessage({ jsonrpc: '2.0', id, result }, mode);
}

function fail(id, code, message, mode) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } }, mode);
}

function writeMessage(payload, mode) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (mode === 'jsonl') return writeSync(process.stdout.fd, Buffer.concat([body, Buffer.from('\n')]));
  writeSync(process.stdout.fd, Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

function httpCodeName(statusCode) {
  if (statusCode === 409) return 'CONFLICT';
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 400) return 'INVALID_ARGUMENT';
  return 'TOOL_ERROR';
}
