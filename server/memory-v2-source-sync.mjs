import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceRecord, sourceInstanceForDataRoot } from './memory-v2-client.mjs';

export class MemoryV2SourceSync {
  static provenanceVersion = 2;
  constructor({ client, chatEventStore, timelineStore, spaceStore, dataRoot, intervalMs = 60_000 }) {
    Object.assign(this, { client, chatEventStore, timelineStore, spaceStore, dataRoot, intervalMs });
    this.cursorFile = join(dataRoot, 'runtime', 'memory-v2-sync.json');
    this.sourceInstance = sourceInstanceForDataRoot(dataRoot);
    this.cursor = 0; this.structuredBackfillDone = false; this.timer = null; this.running = false;
  }
  async start() { await this.#load(); await this.tick(); this.timer = setInterval(() => void this.tick(), this.intervalMs); }
  stop() { clearInterval(this.timer); this.timer = null; }
  async tick() {
    if (this.running) return; this.running = true;
    try { await this.#syncChat(); await this.#syncStructured(); } catch { /* 离线时下一轮幂等重试。 */ } finally { this.running = false; }
  }
  async #syncChat() {
    for (;;) {
      const page = await this.chatEventStore.listAfter(this.cursor, 200);
      const records = page.events.filter((event) => ['user', 'assistant'].includes(event.role) && event.content?.trim()).map((event) => sourceRecord('chat', event, this.sourceInstance));
      if (records.length) await this.client.importSources(records);
      this.cursor = page.cursor;
      await this.#save();
      if (page.events.length < 200) break;
    }
  }
  async #syncStructured() {
    for (let offset = 0;; offset += 200) {
      const page = await this.timelineStore.listAll({ offset, limit: 200 });
      const records = page.events.filter((event) => event.deletedAt || [event.title, event.note, event.description].some(Boolean))
        .map((event) => sourceRecord('timeline', event, this.sourceInstance));
      if (records.length) await this.client.importSources(records);
      if (!page.hasMore) break;
    }
    for (let offset = 0;; offset += 200) {
      const page = await this.spaceStore.listAll({ offset, limit: 200 });
      const records = page.posts.filter((post) => post.status === 'archived' || post.contentMarkdown?.trim())
        .map((post) => sourceRecord('space', post, this.sourceInstance));
      if (records.length) await this.client.importSources(records);
      if (!page.hasMore) break;
    }
    this.structuredBackfillDone = true;
    await this.#save();
  }
  async #load() {
    try {
      const saved = JSON.parse(await readFile(this.cursorFile, 'utf8'));
      const current = saved.sourceInstance === this.sourceInstance && saved.provenanceVersion === MemoryV2SourceSync.provenanceVersion;
      this.cursor = current ? Math.max(0, Number(saved.chatCursor) || 0) : 0;
      this.structuredBackfillDone = current && saved.structuredBackfillDone === true;
    } catch { this.cursor = 0; this.structuredBackfillDone = false; }
  }
  async #save() {
    await mkdir(join(this.dataRoot, 'runtime'), { recursive: true });
    const temporary = `${this.cursorFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ chatCursor: this.cursor, sourceInstance: this.sourceInstance,
      provenanceVersion: MemoryV2SourceSync.provenanceVersion,
      structuredBackfillDone: this.structuredBackfillDone, updatedAt: new Date().toISOString() }, null, 2));
    await rename(temporary, this.cursorFile);
  }
}
