import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBossMcpTools, runBossReadOnly } from '../server/boss-mcp-tools.mjs';

test('BOSS MCP exposes only search and detail, never communication or application', async () => {
  const seen = [];
  const tools = createBossMcpTools({ dataRoot: 'C:/ethere-data', run: async (...args) => { seen.push(args); return { jobs: [] }; } });
  assert.deepEqual(tools.list().map((item) => item.name), ['ethere_boss_search_jobs', 'ethere_boss_job_detail']);
  assert.ok(tools.list().every((item) => item.annotations.readOnlyHint));
  await tools.call('ethere_boss_search_jobs', { keyword: '产品经理', city: '北京' });
  await tools.call('ethere_boss_job_detail', { securityId: 'a'.repeat(336) });
  assert.equal(seen[0][0].operation, 'search');
  assert.equal(seen[1][0].operation, 'detail');
  assert.equal(tools.list()[1].inputSchema.properties.securityId.maxLength, 1024);
  assert.equal(tools.list()[1].inputSchema.properties.encryptJobId.maxLength, 128);
  assert.match(seen[0][1].credentialFile.replaceAll('\\', '/'), /integrations\/boss-cli\/credential\.json$/);
  await assert.rejects(tools.call('ethere_boss_greet', {}), { code: 'UNKNOWN_TOOL' });
});

test('BOSS adapter without dedicated login gives a clear error, no browser cookie fallback', async () => {
  await assert.rejects(
    runBossReadOnly({ operation: 'search', keyword: '产品经理' }, { credentialFile: 'C:/ethere-unconfigured-boss/credential.json', python: process.execPath }),
    /专用浏览器登录/,
  );
});

test('BOSS read-only query refreshes browser session and retries code 37 only once', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-boss-retry-'));
  const credentialFile = join(dataRoot, 'credential.json');
  await writeFile(credentialFile, '{}');
  const sequence = [];
  let calls = 0;
  try {
    const result = await runBossReadOnly({ operation: 'search', keyword: '测试' }, {
      credentialFile, dataRoot, python: process.execPath,
      refreshSession: async () => { sequence.push('refresh'); },
      reloadPage: async () => { sequence.push('reload'); },
      execute: async () => {
        sequence.push('query');
        if (calls++ === 0) throw Object.assign(new Error('security code 37'), { code: 'BOSS_SESSION_EXPIRED' });
        return { jobs: [] };
      },
    });
    assert.deepEqual(result, { jobs: [] });
    assert.deepEqual(sequence, ['refresh', 'query', 'reload', 'refresh', 'query']);
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});
