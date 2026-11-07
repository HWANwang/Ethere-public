import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveProjectDataRoot } from '../server/paths.mjs';

test('production scripts pin data to the project even without ETHERE_DATA_DIR', () => {
  const root = resolve('C:/ethere-test');
  const expected = join(root, 'local-data');
  assert.equal(resolveProjectDataRoot(root, {}), expected);
  assert.equal(resolveProjectDataRoot(root, { ETHERE_DATA_DIR: expected }), expected);
});

test('production scripts refuse a mismatched data directory before starting services', () => {
  const root = resolve('C:/ethere-test');
  assert.throws(() => resolveProjectDataRoot(root, { ETHERE_DATA_DIR: resolve('C:/other-ethere-data') }), /ETHERE_DATA_DIR 与当前项目不一致/);
});

test('MCP refuses an implicit LocalAppData data directory', () => {
  const result = spawnSync(process.execPath, [resolve('server/ethere-mcp-server.mjs')], {
    env: { ...process.env, ETHERE_DATA_DIR: '' }, encoding: 'utf8', timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /需要显式 ETHERE_DATA_DIR/);
});
