import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeveloperBridgeClient } from '../server/developer-bridge-client.mjs';
import { DeveloperEventService } from '../server/developer-event-service.mjs';
import { ChatEventStore } from '../server/chat-event-store.mjs';
import { ChatService } from '../server/chat-service.mjs';
import { CodexAppServerClient } from '../server/codex-app-server-client.mjs';
import { buildEthereMcpConfigArgs } from '../server/mcp-config.mjs';

const execute = promisify(execFile);
const bridgeScript = fileURLToPath(new URL('../scripts/developer-bridge.mjs', import.meta.url));
const mcpScript = fileURLToPath(new URL('../server/ethere-mcp-server.mjs', import.meta.url));

test('real independent Codex bridge: MCP create, code and test, Ethere wake, same-thread follow-up', {
  skip: process.env.ETHERE_REAL_CODEX_E2E !== '1' && 'set ETHERE_REAL_CODEX_E2E=1 to run the live Codex integration',
  timeout: 10 * 60_000,
}, async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-bridge-real-data-'));
  const project = await mkdtemp(join(tmpdir(), 'ethere-bridge-real-repo-'));
  await execute('git', ['init'], { cwd: project });
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'bridge-smoke', private: true, scripts: { test: 'node --test' } }));
  await writeFile(join(project, 'smoke.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport { join } from 'node:path';\ntest('feature starts with first', async () => { assert.match(await readFile(join(import.meta.dirname, 'feature.txt'), 'utf8'), /^first/m); });\n`);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { NODE_TEST_CONTEXT: _testContext, ...runtimeEnv } = process.env;
  const bridge = spawn(process.execPath, [bridgeScript], {
    env: { ...runtimeEnv, ETHERE_DATA_DIR: dataRoot, ETHERE_DEVELOPER_PROJECT_ROOTS: project, ETHERE_DEVELOPER_BRIDGE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let bridgeDiagnostics = '';
  bridge.stdout.on('data', (chunk) => { bridgeDiagnostics += chunk.toString(); });
  bridge.stderr.on('data', (chunk) => { bridgeDiagnostics += chunk.toString(); });
  context.after(() => bridge.kill());
  await until(async () => {
    if (bridge.exitCode !== null) throw new Error(`bridge exited: ${bridgeDiagnostics}`);
    return fetch(`${baseUrl}/health`).then((response) => response.ok).catch(() => false);
  }, 30_000);
  const api = new DeveloperBridgeClient({ dataRoot, baseUrl });

  const mcp = spawn(process.execPath, [mcpScript], {
    env: { ...process.env, ETHERE_DATA_DIR: dataRoot, ETHERE_API_BASE: 'http://127.0.0.1:1', ETHERE_DEVELOPER_BRIDGE_BASE: baseUrl },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  context.after(() => mcp.kill());
  const call = mcpCaller(mcp);
  await call('initialize', { protocolVersion: '2024-11-05' });
  const created = await call('tools/call', { name: 'developer_task_create', arguments: {
    title: 'Bridge fixture first step', cwd: project,
    instruction: 'In this temporary repository create feature.txt with a line containing exactly first. Run npm test and report the result. Do not change files outside this repository.',
    permission: 'workspaceWrite',
  } });
  assert.equal(created.ok, true, JSON.stringify(created));
  const taskId = created.task.id;
  const first = await until(async () => {
    const task = (await call('tools/call', { name: 'developer_task_get', arguments: { taskId } })).task;
    return ['completed', 'failed', 'waiting_input', 'waiting_approval', 'cancelled'].includes(task.status) ? task : null;
  }, 4 * 60_000);
  assert.equal(first.status, 'completed', JSON.stringify({ first, bridgeDiagnostics }));
  assert.match(await readFile(join(project, 'feature.txt'), 'utf8'), /^first/m);
  assert.equal(first.tests.some((entry) => /npm test/u.test(entry.command) && entry.exitCode === 0), true, JSON.stringify(first.tests));
  await execute(process.execPath, ['--test', 'smoke.test.mjs'], { cwd: project });

  const chatClient = new CodexAppServerClient({ appServerArgs: buildEthereMcpConfigArgs({ dataRoot, apiBase: 'http://127.0.0.1:1' }) });
  context.after(() => chatClient.close());
  const chatEventStore = new ChatEventStore({ dataRoot });
  const chatService = new ChatService({ client: chatClient, dataRoot, workspaceRoot: dataRoot });
  const events = new DeveloperEventService({ bridge: api, chatService, chatEventStore });
  const delivered = await events.tick();
  assert.equal(delivered.delivered, 1);
  assert.equal((await api.pendingEvents()).events.length, 0);
  assert.equal((await chatEventStore.listHistory({ limit: 10 })).events.some((entry) => entry.source === 'developer-task'), true);

  const sent = await call('tools/call', { name: 'developer_task_send', arguments: {
    taskId, instruction: 'Continue in this same thread. Keep the first line in feature.txt and append a second line containing exactly second. Add a second test assertion for second and run npm test again.',
  } });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const second = await until(async () => {
    const task = (await call('tools/call', { name: 'developer_task_get', arguments: { taskId } })).task;
    return task.generation === 2 && ['completed', 'failed', 'waiting_input', 'waiting_approval', 'cancelled'].includes(task.status) ? task : null;
  }, 4 * 60_000);
  assert.equal(second.status, 'completed', JSON.stringify({ second, bridgeDiagnostics }));
  assert.equal(second.threadId, first.threadId);
  assert.match(await readFile(join(project, 'feature.txt'), 'utf8'), /^first\s+second/m);
  assert.equal(second.tests.some((entry) => /npm test/u.test(entry.command) && entry.exitCode === 0), true, JSON.stringify(second.tests));
  await execute(process.execPath, ['--test', 'smoke.test.mjs'], { cwd: project });
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; }
    catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError || new Error(`timed out after ${timeoutMs}ms`);
}

function mcpCaller(child) {
  let nextId = 0;
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  return async (method, params) => {
    const id = ++nextId;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timeout`)); }, 15_000);
      pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const message = await reply;
    if (method === 'initialize') return message.result;
    return JSON.parse(message.result.content[0].text);
  };
}
