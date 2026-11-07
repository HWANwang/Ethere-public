import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../server/config-store.mjs';

test('fresh installs enable proactive check-ins by default', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-config-test-'));
  const settings = await new ConfigStore({ dataRoot }).getSettings();
  assert.equal(settings.checkin.enabled, true);
});

test('settings, selected Dida projects, and editable documents persist under the private data root', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-config-test-'));
  const store = new ConfigStore({ dataRoot });
  const settings = await store.updateSettings({ model: 'gpt-test', checkin: { enabled: true, minMinutes: 10, maxMinutes: 20 }, dida: { projects: [{ id: 'private-project-id', name: '监督清单' }, { id: 'second-private-id', name: '第二清单' }] } });
  await store.writeDocument('persona', '温柔但直接');
  await store.writeDocument('persona', '温柔、直接，也会提醒我休息');
  await store.writeDocument('persona', '温柔、直接，提醒我休息但不要说教');
  await store.writeDocument('operations', '写入前先确认');

  assert.equal(settings.model, 'gpt-test');
  assert.deepEqual(settings.checkin, { enabled: true, minMinutes: 10, maxMinutes: 20 });
  assert.deepEqual(settings.dida, { projects: [{ id: 'private-project-id', name: '监督清单' }, { id: 'second-private-id', name: '第二清单' }] });
  const instructions = await store.readRuntimeInstructions();
  assert.equal(instructions.persona, '温柔、直接，提醒我休息但不要说教');
  assert.match(instructions.revision, /^[a-f0-9]{16}$/);
  assert.equal(await readFile(join(dataRoot, 'config', 'documents', 'persona.previous.md'), 'utf8'), '温柔、直接，也会提醒我休息');
  assert.equal(await readFile(join(dataRoot, 'config', 'documents', 'operations.md'), 'utf8'), '写入前先确认');
});
test('legacy single Dida project settings migrate to the multi-select shape', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-config-test-'));
  await mkdir(join(dataRoot, 'config'), { recursive: true });
  await writeFile(join(dataRoot, 'config', 'settings.json'), JSON.stringify({ dida: { projectId: 'legacy-project', projectName: '旧监督清单' } }));
  const store = new ConfigStore({ dataRoot });
  const settings = await store.getSettings();
  assert.deepEqual(settings.dida.projects, [{ id: 'legacy-project', name: '旧监督清单' }]);
});
test('unknown document names cannot escape the private document directory', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-config-test-'));
  const store = new ConfigStore({ dataRoot });
  await assert.rejects(store.writeDocument('../secret', 'no'), /文档不存在/);
});

test('document revisions retain history, reject stale proposals, and roll back as a new version', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-document-history-test-'));
  const store = new ConfigStore({ dataRoot });
  const first = await store.writeDocument('persona', '第一版');
  const second = await store.writeDocument('persona', '第二版', { baseRevision: first.revision, source: 'approval', approvalId: 'proposal-1' });
  await assert.rejects(store.writeDocument('persona', '过期提案', { baseRevision: first.revision }), /文档已被更新/);
  const history = await store.documentHistory('persona');
  assert.deepEqual(history.map((item) => item.text).sort(), ['第一版', '第二版']);
  const restored = await store.restoreDocument('persona', first.revision, { baseRevision: second.revision });
  assert.equal(restored.text, '第一版');
  assert.equal((await store.readDocument('persona')).revision, first.revision);
});
