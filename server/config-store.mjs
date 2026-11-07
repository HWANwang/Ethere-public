import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_VOICE_ID, normalizeVoiceId } from './voice-catalog.mjs';

const DOCUMENT_NAMES = new Set(['persona', 'operations']);
const DEFAULT_SETTINGS = Object.freeze({
  bossName: 'Ethere',
  model: 'default',
  voiceId: DEFAULT_VOICE_ID,
  checkin: { enabled: true, minMinutes: 30, maxMinutes: 90 },
  dida: { projects: [] },
});

export class ConfigStore {
  constructor({ dataRoot }) {
    this.dataRoot = dataRoot;
    this.settingsFile = join(dataRoot, 'config', 'settings.json');
    this.documentsRoot = join(dataRoot, 'config', 'documents');
    this.writeChain = Promise.resolve();
  }

  async getSettings() {
    try {
      return normalizeSettings(JSON.parse(await readFile(this.settingsFile, 'utf8')));
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  async updateSettings(patch) {
    return this.#write(async () => {
      const current = await this.getSettings();
      const next = normalizeSettings({
        ...current,
        ...(patch && typeof patch === 'object' ? patch : {}),
        checkin: { ...current.checkin, ...(patch?.checkin || {}) },
        dida: { ...current.dida, ...(patch?.dida || {}) },
      });
      await writeAtomic(this.settingsFile, next);
      return next;
    });
  }

  async readDocument(name) {
    validateDocumentName(name);
    const file = join(this.documentsRoot, `${name}.md`);
    try {
      const info = await readFile(file, 'utf8');
      return { name, text: info, revision: revisionOf(info) };
    } catch {
      return { name, text: '', revision: revisionOf('') };
    }
  }

  async writeDocument(name, text, { baseRevision = '', source = 'user', approvalId = '' } = {}) {
    validateDocumentName(name);
    const value = String(text ?? '');
    if (value.length > 40_000) throw httpError(413, '文档过长');
    const file = join(this.documentsRoot, `${name}.md`);
    const previousFile = join(this.documentsRoot, `${name}.previous.md`);
    let oldRevision = '';
    let changed = false;
    await this.#write(async () => {
      let current = '';
      let exists = true;
      try {
        current = await readFile(file, 'utf8');
      } catch {
        exists = false;
      }
      oldRevision = revisionOf(current);
      if (baseRevision && baseRevision !== oldRevision) throw httpError(409, '文档已被更新，请重新查看差异后再提交');
      if (exists && current === value) return;
      if (exists) {
        await this.#archiveDocumentVersion(name, current, { source: 'previous' });
        await writeAtomicText(previousFile, current);
      }
      await writeAtomicText(file, value);
      await this.#archiveDocumentVersion(name, value, { source, approvalId });
      changed = true;
    });
    return { name, text: value, revision: revisionOf(value), previousRevision: oldRevision, changed, updatedAt: new Date().toISOString() };
  }

  async documentHistory(name) {
    validateDocumentName(name);
    await this.writeChain;
    const directory = join(this.documentsRoot, 'history', name);
    const files = await readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    const revisions = [];
    for (const file of files.filter((item) => /^[a-f0-9]{16}\.json$/.test(item))) {
      try { revisions.push(JSON.parse(await readFile(join(directory, file), 'utf8'))); } catch { /* 其他历史版本仍可查看。 */ }
    }
    const current = await this.readDocument(name);
    if (!revisions.some((item) => item.revision === current.revision)) revisions.push({ revision: current.revision, text: current.text, source: 'existing', savedAt: null });
    return revisions.sort((left, right) => String(right.savedAt || '').localeCompare(String(left.savedAt || '')));
  }

  async restoreDocument(name, revision, { baseRevision = '' } = {}) {
    const history = await this.documentHistory(name);
    const target = history.find((item) => item.revision === revision);
    if (!target) throw httpError(404, '文档历史版本不存在');
    return this.writeDocument(name, target.text, { baseRevision, source: 'rollback' });
  }

  async readRuntimeInstructions() {
    const [persona, operations] = await Promise.all([
      this.readDocument('persona'),
      this.readDocument('operations'),
    ]);
    return {
      persona: persona.text.trim(),
      operations: operations.text.trim(),
      revision: revisionOf(`${persona.revision}:${operations.revision}`),
    };
  }

  #write(operation) {
    const next = this.writeChain.then(operation);
    this.writeChain = next.catch(() => {});
    return next;
  }

  async #archiveDocumentVersion(name, text, { source = 'user', approvalId = '' } = {}) {
    const revision = revisionOf(text);
    const file = join(this.documentsRoot, 'history', name, `${revision}.json`);
    await mkdir(dirname(file), { recursive: true });
    const payload = { revision, text, source, approvalId, savedAt: new Date().toISOString() };
    try { await writeFile(file, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

function revisionOf(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}
function normalizeSettings(value = {}) {
  const rawMin = Number(value?.checkin?.minMinutes);
  const rawMax = Number(value?.checkin?.maxMinutes);
  const minMinutes = Number.isFinite(rawMin) ? Math.max(5, Math.min(1_435, Math.round(rawMin))) : DEFAULT_SETTINGS.checkin.minMinutes;
  const maxMinutes = Number.isFinite(rawMax) ? Math.max(minMinutes + 5, Math.min(1_440, Math.round(rawMax))) : DEFAULT_SETTINGS.checkin.maxMinutes;
  const model = typeof value.model === 'string' && value.model.trim() ? value.model.trim() : 'default';
  const bossName = typeof value.bossName === 'string' && value.bossName.trim() ? value.bossName.trim().slice(0, 20) : 'Ethere';
  return {
    bossName,
    model,
    voiceId: normalizeVoiceId(value.voiceId),
    checkin: {
      enabled: typeof value?.checkin?.enabled === 'boolean' ? value.checkin.enabled : DEFAULT_SETTINGS.checkin.enabled,
      minMinutes,
      maxMinutes,
    },
    dida: {
      projects: normalizeDidaProjects(value?.dida),
    },
  };
}

function normalizeDidaProjects(value = {}) {
  const candidates = Array.isArray(value?.projects)
    ? value.projects
    : value?.projectId
      ? [{ id: value.projectId, name: value.projectName }]
      : [];
  const seen = new Set();
  return candidates.flatMap((project) => {
    const id = typeof project?.id === 'string' ? project.id.trim().slice(0, 120) : '';
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const name = typeof project?.name === 'string' ? project.name.trim().slice(0, 120) : '';
    return [{ id, name }];
  }).slice(0, 20);
}

function validateDocumentName(name) {
  if (!DOCUMENT_NAMES.has(name)) throw httpError(404, '文档不存在');
}

async function writeAtomic(file, value) {
  await writeAtomicText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeAtomicText(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, file);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
