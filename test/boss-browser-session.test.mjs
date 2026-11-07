import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bossCookies, importBossSession } from '../scripts/boss-browser-session.mjs';

test('dedicated BOSS browser importer rejects other domains and requires a complete session', () => {
  const cookies = ['__zp_stoken__', 'wt2', 'wbg', 'zp_at'].map((name) => ({ domain: '.zhipin.com', name, value: `value-${name}` }));
  cookies.push({ domain: 'example.com', name: 'private', value: 'do-not-copy' });
  const { values, missing } = bossCookies(cookies);
  assert.deepEqual(missing, []);
  assert.equal(values.private, undefined);
  assert.equal(Object.keys(values).length, 4);
  assert.deepEqual(bossCookies(cookies.slice(0, 1)).missing, ['wt2', 'wbg', 'zp_at']);
});

test('BOSS session renewal refuses a security page without overwriting the snapshot', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-boss-verify-'));
  try {
    const fetchImpl = async (url) => ({ ok: true, json: async () => url.endsWith('/json/version')
      ? { webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/browser/test' }
      : [{ type: 'page', url: 'https://www.zhipin.com/web/passport/zp/verify.html' }] });
    await assert.rejects(importBossSession({ dataRoot, fetchImpl, Socket: class {} }), /安全验证/);
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});

test('BOSS session renewal preserves the dedicated browser after reading fresh cookies', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-boss-session-'));
  const sent = [];
  const cookies = ['__zp_stoken__', 'wt2', 'wbg', 'zp_at'].map((name) => ({ domain: '.zhipin.com', name, value: `fresh-${name}` }));
  class FakeSocket {
    constructor() { this.handlers = {}; queueMicrotask(() => this.handlers.open?.()); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    send(value) {
      const command = JSON.parse(value);
      sent.push(command.method);
      queueMicrotask(() => this.handlers.message?.({ data: JSON.stringify({ id: command.id, result: { cookies } }) }));
    }
    close() {}
  }
  try {
    const fetchImpl = async (url) => ({ ok: true, json: async () => url.endsWith('/json/version')
      ? { webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/browser/test' }
      : [{ type: 'page', url: 'https://www.zhipin.com/web/geek/jobs' }] });
    await importBossSession({ dataRoot, fetchImpl, Socket: FakeSocket });
    const saved = JSON.parse(await readFile(join(dataRoot, 'integrations', 'boss-cli', 'credential.json'), 'utf8'));
    assert.equal(saved.cookies.__zp_stoken__, 'fresh-__zp_stoken__');
    assert.deepEqual(sent, ['Storage.getCookies']);
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});
