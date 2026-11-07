import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient } from '../server/codex-app-server-client.mjs';
import { createAttachmentStore } from '../server/attachments.mjs';
import { ChatService } from '../server/chat-service.mjs';
import { ChatEventStore } from '../server/chat-event-store.mjs';
import { CheckinService } from '../server/checkin-service.mjs';
import { ConfigStore } from '../server/config-store.mjs';
import { TimelineStore } from '../server/timeline-store.mjs';
import { MemoryNodeStore } from '../server/memory-node-store.mjs';
import { UnifiedMemoryStore } from '../server/unified-memory-store.mjs';
import { MemoryReviewService, CodexMemoryReviewer } from '../server/memory-review-service.mjs';
import { buildEthereMcpConfigArgs } from '../server/mcp-config.mjs';
import { resolveProjectDataRoot } from '../server/paths.mjs';
import { createEthereServer } from '../server/server.mjs';
import { DidaService } from '../server/dida-service.mjs';
import { ReminderStore } from '../server/reminder-store.mjs';
import { ReminderService } from '../server/reminder-service.mjs';
import { SpaceStore } from '../server/space-store.mjs';
import { PhoneUsageStore } from '../server/phone-usage-store.mjs';
import { PhoneUsageRefresh } from '../server/phone-usage-refresh.mjs';
import { PhoneUsageDiagnostics } from '../server/phone-usage-diagnostics.mjs';
import { SpaceReplyService } from '../server/space-reply-service.mjs';
import { DeveloperBridgeClient } from '../server/developer-bridge-client.mjs';
import { DeveloperEventService } from '../server/developer-event-service.mjs';
import { DeviceActionService } from '../server/device-action-service.mjs';
import { DeviceActionEventService } from '../server/device-action-event-service.mjs';
import { StudyPlanStore } from '../server/study-plan-store.mjs';
import { MemoryV2Client } from '../server/memory-v2-client.mjs';
import { MemoryV2SourceSync } from '../server/memory-v2-source-sync.mjs';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const dataRoot = resolveProjectDataRoot(projectRoot);
process.env.ETHERE_DATA_DIR = dataRoot;
const port = Number(process.env.PORT || 4173);

await mkdir(dataRoot, { recursive: true });
const apiBase = `http://127.0.0.1:${port}`;
const bridgeBaseUrl = `http://127.0.0.1:${Number(process.env.ETHERE_DEVELOPER_BRIDGE_PORT || 4174)}`;
const client = new CodexAppServerClient({ appServerArgs: buildEthereMcpConfigArgs({ apiBase, dataRoot, bridgeBaseUrl }) });
const configStore = new ConfigStore({ dataRoot });
const didaService = new DidaService({ client, configStore, workspaceRoot: dataRoot });
const timelineStore = new TimelineStore({ dataRoot });
const memoryNodeStore = new MemoryNodeStore({ dataRoot });
const memoryStore = new UnifiedMemoryStore({ dataRoot, memoryNodeStore });
const reminderStore = new ReminderStore({ dataRoot });
const spaceStore = new SpaceStore({ dataRoot });
const studyPlanStore = new StudyPlanStore({ dataRoot });
const phoneUsageStore = new PhoneUsageStore({ dataRoot });
const phoneUsageDiagnostics = new PhoneUsageDiagnostics({ dataRoot });
const phoneUsageRefresh = new PhoneUsageRefresh({
  onDiagnostic: (stage, details) => phoneUsageDiagnostics.record(stage, details),
});
await timelineStore.initialize();
await memoryNodeStore.initialize();
await memoryStore.initialize();
await reminderStore.initialize();
await spaceStore.initialize();
await studyPlanStore.initialize();
await phoneUsageStore.initialize();
const chatEventStore = new ChatEventStore({ dataRoot });
const memoryV2Client = new MemoryV2Client();
const deviceActionService = new DeviceActionService({ dataRoot });
const chatService = new ChatService({
  client, dataRoot, configStore, memoryStore, memoryNodeStore, memoryV2Client, workspaceRoot: dataRoot,
  onPhoneUsageRead: ({ succeeded, id, error }) => {
    void phoneUsageDiagnostics.record(succeeded ? 'mcp-read-succeeded' : 'mcp-read-failed', {
      requestId: id, error: error?.message || error || '',
    }).catch(() => {});
    return chatEventStore.append({
      id: `phone_usage_read_${randomUUID()}`,
      role: 'notice', source: 'phone-usage', content: succeeded ? '看了看你的手机使用情况' : '手机使用情况暂不可用',
    });
  },
});
// The old retrievable-node reviewer is kept behind an explicit rollback/debug flag.
// Production ordinary memory is owned exclusively by memory-lab V2.
const legacyMemoryReviewEnabled = process.env.ETHERE_ENABLE_LEGACY_MEMORY_REVIEW === 'true';
const memoryReviewService = legacyMemoryReviewEnabled ? new MemoryReviewService({
  chatEventStore, memoryNodeStore,
  reviewer: new CodexMemoryReviewer({ dataRoot, configStore }),
  isBusy: () => chatService.isBusy(),
}) : null;
const attachmentStore = createAttachmentStore({ dataRoot });
const spaceReplyService = new SpaceReplyService({ chatService, chatEventStore, spaceStore });
const checkinService = new CheckinService({ configStore, chatService, chatEventStore });
const reminderService = new ReminderService({ reminderStore, didaService, chatService, chatEventStore });
const developerEventService = new DeveloperEventService({
  bridge: new DeveloperBridgeClient({ dataRoot }), chatService, chatEventStore,
});
const deviceActionEventService = new DeviceActionEventService({ deviceActionService, chatService, chatEventStore });
const memoryV2SourceSync = new MemoryV2SourceSync({ client: memoryV2Client, chatEventStore, timelineStore, spaceStore, dataRoot });
const server = createEthereServer({ webRoot, chatService, attachmentStore, chatEventStore, configStore, checkinService, timelineStore, memoryStore, memoryNodeStore, memoryV2Client, memoryReviewService, didaService, reminderService, spaceStore, spaceReplyService, phoneUsageStore, phoneUsageRefresh, deviceActionService, studyPlanStore });

await checkinService.start();
await reminderService.start();
await spaceReplyService.resumeLatest();
await memoryReviewService?.start();
void memoryV2SourceSync.start();
developerEventService.start();
deviceActionEventService.start();

server.listen(port, '127.0.0.1', () => {
  console.log(`Ethere: http://127.0.0.1:${port}`);
  console.log(`Ethere data: ${dataRoot}`);
});

async function shutdown() {
  checkinService.stop();
  reminderService.stop();
  memoryReviewService?.stop();
  memoryV2SourceSync.stop();
  developerEventService.stop();
  deviceActionEventService.stop();
  server.close();
  studyPlanStore.close();
  await client.close();
}

process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
