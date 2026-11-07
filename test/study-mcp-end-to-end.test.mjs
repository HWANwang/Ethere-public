import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { StudyPlanStore } from '../server/study-plan-store.mjs';

const mcpScript = fileURLToPath(new URL('../server/ethere-mcp-server.mjs', import.meta.url));

test('real MCP process and App store share learning plans across process restart', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-study-mcp-e2e-'));
  let mcp;
  let appStore;
  try {
    mcp = await openMcp(dataRoot);
    const names = (await mcp.request('tools/list')).result.tools.map((tool) => tool.name);
    assert.ok(names.includes('ethere_study_plan_create'));
    assert.ok(names.includes('ethere_study_plan_update'));
    assert.ok(names.includes('ethere_boss_search_jobs'));
    assert.ok(!names.includes('ethere_boss_greet'));

    const created = await mcp.call('ethere_study_plan_create', {
      title: '语用学', lessons: ['语言与语境', '会话含义'],
    });
    const planId = created.plan.id;
    assert.equal(created.plan.currentLessonId, created.plan.lessons[0].id);

    appStore = new StudyPlanStore({ dataRoot });
    assert.equal((await appStore.get(planId)).title, '语用学');
    const checkpoint = await mcp.call('ethere_study_plan_update', {
      planId, baseRevision: 1, action: 'checkpoint', note: '讲到指示语，下一次从例子继续',
    });
    assert.equal((await appStore.get(planId)).checkpoint, checkpoint.plan.checkpoint);
    assert.equal(checkpoint.plan.lessons[0].status, 'pending');

    await mcp.stop();
    mcp = await openMcp(dataRoot);
    assert.equal((await mcp.call('ethere_study_plan_get', { planId })).plan.checkpoint, '讲到指示语，下一次从例子继续');
    const completed = await mcp.call('ethere_study_plan_update', {
      planId, baseRevision: 2, action: 'complete_lesson', summary: '用户说已学完第一节',
    });
    assert.equal(completed.plan.currentLessonId, created.plan.lessons[1].id);
    assert.equal((await appStore.get(planId)).lessons[0].status, 'done');
    assert.equal((await mcp.call('ethere_study_plans_list')).plans[0].completedCount, 1);
  } finally {
    appStore?.close();
    await mcp?.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

async function openMcp(dataRoot) {
  const child = spawn(process.execPath, [mcpScript], {
    env: { ...process.env, ETHERE_DATA_DIR: dataRoot, ETHERE_API_BASE: 'http://127.0.0.1:1' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let buffer = '';
  let stderr = '';
  let nextId = 0;
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const pending = waiting.get(message.id);
      if (pending) { waiting.delete(message.id); pending(message); }
    }
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const request = (method, params = {}) => {
    const id = ++nextId;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`MCP ${method} 超时：${stderr}`)); }, 10_000);
      waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return reply;
  };
  const call = async (name, args = {}) => {
    const response = await request('tools/call', { name, arguments: args });
    assert.equal(response.result?.isError, undefined, response.result?.content?.[0]?.text);
    return JSON.parse(response.result.content[0].text);
  };
  const stop = async () => {
    if (child.exitCode !== null) return;
    await new Promise((resolve) => { child.once('close', resolve); child.kill(); });
  };
  await request('initialize', { protocolVersion: '2024-11-05' });
  return { request, call, stop };
}
