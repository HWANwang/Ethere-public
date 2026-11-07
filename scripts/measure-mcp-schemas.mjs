import { createTimelineMcpTools } from '../server/timeline-mcp-tools.mjs';
import { createMemoryMcpTools } from '../server/memory-mcp-tools.mjs';
import { createDocumentMcpTools } from '../server/document-mcp-tools.mjs';
import { createTaskMcpTools } from '../server/task-mcp-tools.mjs';
import { createReminderMcpTools } from '../server/reminder-mcp-tools.mjs';
import { createSpaceMcpTools } from '../server/space-mcp-tools.mjs';
import { createPhoneUsageMcpTools } from '../server/phone-usage-mcp-tools.mjs';
import { createDeveloperTaskMcpTools } from '../server/developer-task-mcp-tools.mjs';
import { createDeviceActionMcpTools } from '../server/device-action-mcp-tools.mjs';
import { createStudyMcpTools } from '../server/study-mcp-tools.mjs';
import { createBossMcpTools } from '../server/boss-mcp-tools.mjs';

// Static tool-list payload only: no model call, private data access or inferred token count.
const groups = [
  ['timeline', createTimelineMcpTools({ timelineStore: {} })],
  ['memory', createMemoryMcpTools({ memoryStore: {}, memoryNodeStore: {}, chatEventStore: {} })],
  ['document', createDocumentMcpTools({ configStore: {} })],
  ['task', createTaskMcpTools()],
  ['reminder', createReminderMcpTools()],
  ['space', createSpaceMcpTools()],
  ['phone usage', createPhoneUsageMcpTools()],
  ['developer', createDeveloperTaskMcpTools({ bridge: {} })],
  ['device action', createDeviceActionMcpTools()],
  ['study', createStudyMcpTools({ studyPlanStore: {} })],
  ['BOSS read', createBossMcpTools({ dataRoot: 'schema-measurement-only' })],
];
let totalCount = 0;
let totalBytes = 0;
for (const [name, group] of groups) {
  const tools = group.list();
  const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  totalCount += tools.length;
  totalBytes += bytes;
  console.log(`${name.padEnd(12)} ${String(tools.length).padStart(2)} tools ${String(bytes).padStart(6)} UTF-8 bytes`);
}
console.log(`total        ${String(totalCount).padStart(2)} tools ${String(totalBytes).padStart(6)} UTF-8 bytes`);
console.log('This is the local Ethere tools/list size, not the number of billable model tokens.');
