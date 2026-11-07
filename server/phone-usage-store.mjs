import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class PhoneUsageStore {
  constructor({ dataRoot, now = () => new Date() }) {
    this.file = join(dataRoot, 'phone-usage', 'snapshots.json');
    this.now = now;
    this.snapshots = [];
    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      this.snapshots = Array.isArray(value?.snapshots) ? value.snapshots.map(normalizeSnapshot).filter(Boolean) : [];
    } catch { this.snapshots = []; }
    this.#prune();
  }

  async ingest(input = {}) {
    await this.initialize();
    const snapshot = normalizeSnapshot({ ...input, id: input.id || randomUUID(), receivedAt: this.now().toISOString() });
    if (!snapshot) throw httpError(400, '手机使用数据格式不完整');
    return this.#write(async () => {
      const existing = this.snapshots.find((item) => item.id === snapshot.id);
      if (existing) return structuredClone(existing);
      this.snapshots.push(snapshot);
      this.#prune();
      await this.#persist();
      return structuredClone(snapshot);
    });
  }

  async status() {
    await this.initialize();
    const latest = [...this.snapshots].filter((item) => item.schemaVersion >= 2).sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0];
    return { available: Boolean(latest), dataUpdatedAt: latest?.collectedAt || null, snapshotCount: this.snapshots.length };
  }

  async recent({ lookbackMinutes = 120, appIds = [], includeTimeline = true, snapshotId = '' } = {}) {
    await this.initialize();
    const minutes = Math.max(5, Math.min(10_080, Number(lookbackMinutes) || 120));
    const allowed = new Set((Array.isArray(appIds) ? appIds : String(appIds || '').split(',')).map(String).map((v) => v.trim()).filter(Boolean));
    const latest = snapshotId
      ? this.snapshots.find((item) => item.id === snapshotId && item.schemaVersion >= 2)
      : [...this.snapshots].filter((item) => item.schemaVersion >= 2).sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0];
    if (!latest) return {
      interval: { start: new Date(this.now().getTime() - minutes * 60_000).toISOString(), end: this.now().toISOString(), lookbackMinutes: minutes },
      dataUpdatedAt: null, stale: true, dataQuality: 'unavailable', screen: null, apps: [], ...(includeTimeline ? { timeline: [] } : {}),
    };
    const endMs = new Date(latest.intervalEnd).getTime();
    const startMs = Math.max(new Date(latest.intervalStart).getTime(), endMs - minutes * 60_000);
    const names = new Map(latest.apps.map((app) => [app.packageName, app.appName]));
    const fragments = latest.timeline.map((item) => ({
      ...item,
      startAt: new Date(Math.max(startMs, new Date(item.startAt).getTime())).toISOString(),
      endAt: new Date(Math.min(endMs, new Date(item.endAt).getTime())).toISOString(),
    })).filter((item) => item.endAt > item.startAt).sort((a, b) => a.startAt.localeCompare(b.startAt));
    const totals = new Map();
    const safeTimeline = [];
    let appCursor = startMs;
    for (const item of fragments) {
      if (item.type !== 'app') { safeTimeline.push(item); continue; }
      if (!item.packageName) continue;
      const start = Math.max(appCursor, new Date(item.startAt).getTime());
      const end = new Date(item.endAt).getTime();
      if (end <= start) continue;
      appCursor = end;
      const segment = { ...item, startAt: new Date(start).toISOString() };
      safeTimeline.push(segment);
      if (allowed.size && !allowed.has(item.packageName)) continue;
      const current = totals.get(item.packageName) || { packageName: item.packageName, appName: names.get(item.packageName) || item.packageName, foregroundMs: 0, lastUsedAt: null };
      current.foregroundMs += end - start;
      if (!current.lastUsedAt || segment.endAt > current.lastUsedAt) current.lastUsedAt = segment.endAt;
      totals.set(item.packageName, current);
    }
    return {
      interval: { start: new Date(startMs).toISOString(), end: latest.intervalEnd, lookbackMinutes: minutes },
      dataUpdatedAt: latest.collectedAt,
      stale: this.now().getTime() - new Date(latest.collectedAt).getTime() > 5 * 60_000,
      dataQuality: endMs - new Date(latest.intervalStart).getTime() < minutes * 60_000 - 1000 ? 'partial' : 'usage-events',
      screen: latest.screen,
      apps: [...totals.values()].sort((a, b) => b.foregroundMs - a.foregroundMs).slice(0, 30),
      ...(includeTimeline ? { timeline: safeTimeline.filter((item) => item.type !== 'app' || !allowed.size || allowed.has(item.packageName)).slice(-100), timelineTruncated: safeTimeline.length > 100 } : {}),
    };
  }

  #prune() { const cutoff = this.now().getTime() - RETENTION_MS; this.snapshots = this.snapshots.filter((item) => new Date(item.intervalEnd).getTime() >= cutoff).slice(-1000); }
  #write(operation) { const next = this.writeChain.then(operation); this.writeChain = next.catch(() => {}); return next; }
  async #persist() { await mkdir(dirname(this.file), { recursive: true }); const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`; await writeFile(temp, `${JSON.stringify({ snapshots: this.snapshots }, null, 2)}\n`, { flag: 'wx' }); await rename(temp, this.file); }
}

function normalizeSnapshot(value = {}) {
  const id = text(value.id, 120); const collectedAt = iso(value.collectedAt); const intervalStart = iso(value.intervalStart); const intervalEnd = iso(value.intervalEnd);
  if (!id || !collectedAt || !intervalStart || !intervalEnd || intervalEnd <= intervalStart) return null;
  const schemaVersion = Number(value.schemaVersion) >= 2 ? 2 : 1;
  const apps = (Array.isArray(value.apps) ? value.apps : []).flatMap((app) => { const packageName = text(app?.packageName, 240); const foregroundMs = Math.max(0, Math.round(Number(app?.foregroundMs) || 0)); if (!packageName || !foregroundMs) return []; return [{ packageName, appName: text(app?.appName, 120) || packageName, foregroundMs, lastUsedAt: iso(app?.lastUsedAt) || null }]; });
  const screen = value.screen && typeof value.screen === 'object' ? { interactive: typeof value.screen.interactive === 'boolean' ? value.screen.interactive : null, lastChangedAt: iso(value.screen.lastChangedAt) || null, interactiveMs: Math.max(0, Math.round(Number(value.screen.interactiveMs) || 0)), unlockCount: Math.max(0, Math.round(Number(value.screen.unlockCount) || 0)) } : null;
  const timeline = (Array.isArray(value.timeline) ? value.timeline : []).flatMap((item) => { const startAt = iso(item?.startAt); const endAt = iso(item?.endAt); if (!startAt || !endAt || endAt <= startAt) return []; return [{ type: ['app', 'screen', 'keyguard'].includes(item.type) ? item.type : 'app', startAt, endAt, packageName: text(item.packageName, 240), state: text(item.state, 40) }]; });
  return { id, schemaVersion, collectedAt, intervalStart, intervalEnd, receivedAt: iso(value.receivedAt) || collectedAt, screen, apps, timeline };
}
function text(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function iso(value) { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toISOString() : ''; }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
