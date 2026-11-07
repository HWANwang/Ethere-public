import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ChatEventStore } from '../server/chat-event-store.mjs';
import { TimelineStore } from '../server/timeline-store.mjs';
import { SpaceStore } from '../server/space-store.mjs';
import { MemoryV2Client, sourceInstanceForDataRoot, sourceRecord } from '../server/memory-v2-client.mjs';
import { resolveProjectDataRoot } from '../server/paths.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const dataRoot = resolveProjectDataRoot(projectRoot);
const client = new MemoryV2Client({ requestTimeoutMs: 30_000 });
const health = await client.health();
if (resolve(health.dataDir) !== resolve(projectRoot, 'memory-lab', 'runtime') || health.pid !== Number(health.pid)) {
  throw new Error('4191 不是当前项目的新版记忆服务，拒绝导入来源');
}
const sourceInstance = sourceInstanceForDataRoot(dataRoot);
const counts = { chat: 0, timeline: 0, space: 0, tombstones: 0 };
const chat = new ChatEventStore({ dataRoot });
const timeline = new TimelineStore({ dataRoot });
const space = new SpaceStore({ dataRoot });
await timeline.initialize();
await space.initialize();
for (let cursor = 0;;) {
  const page = await chat.listAfter(cursor, 200);
  const rows = page.events.filter((event) => ['user', 'assistant'].includes(event.role) && event.content?.trim())
    .map((event) => sourceRecord('chat', event, sourceInstance));
  if (rows.length) { await client.importSources(rows); counts.chat += rows.length; }
  cursor = page.cursor;
  if (page.events.length < 200) break;
}
for (let offset = 0;; offset += 200) {
  const page = await timeline.listAll({ offset, limit: 200 });
  const rows = page.events.filter((event) => event.deletedAt || [event.title, event.note, event.description].some(Boolean))
    .map((event) => sourceRecord('timeline', event, sourceInstance));
  if (rows.length) { await client.importSources(rows); counts.timeline += rows.length; counts.tombstones += rows.filter((row) => row.deleted).length; }
  if (!page.hasMore) break;
}
for (let offset = 0;; offset += 200) {
  const page = await space.listAll({ offset, limit: 200 });
  const rows = page.posts.filter((post) => post.status === 'archived' || post.contentMarkdown?.trim())
    .map((post) => sourceRecord('space', post, sourceInstance));
  if (rows.length) { await client.importSources(rows); counts.space += rows.length; counts.tombstones += rows.filter((row) => row.deleted).length; }
  if (!page.hasMore) break;
}
process.stdout.write(`${JSON.stringify({ dataRoot, sourceInstance, counts, stats: await client.stats() }, null, 2)}\n`);
