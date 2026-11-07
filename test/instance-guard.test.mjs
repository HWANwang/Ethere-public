import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = async (name) => readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8');

test('all production entrypoints pin the project data root before spawning services', async () => {
  for (const name of ['watchdog.mjs', 'serve.mjs', 'memory-v2-supervisor.mjs']) {
    const text = await source(name);
    assert.match(text, /resolveProjectDataRoot\(projectRoot\)/);
    assert.match(text, /process\.env\.ETHERE_DATA_DIR = dataRoot/);
  }
});

test('watchdog and restart script require instance identity instead of accepting any 4173 health response', async () => {
  const watchdog = await source('watchdog.mjs');
  const restart = await source('restart-ethere-service.ps1');
  assert.match(watchdog, /open\(lockFile, 'wx'\)/);
  assert.match(watchdog, /health\?\.instance\?\.pid !== child\.pid/);
  assert.match(restart, /Get-ListenerPid 4173/);
  assert.match(restart, /Get-VerifiedProcess \$listenerId \$servePath/);
  assert.match(restart, /taskkill\.exe \/PID \$watchdogId \/T \/F/);
  assert.match(restart, /Same-Path \$health\.instance\.dataRoot \$dataRoot/);
});
