import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEthereMcpConfigArgs } from '../server/mcp-config.mjs';

test('Codex app-server receives an isolated Ethere MCP configuration', () => {
  const args = buildEthereMcpConfigArgs({ command: 'C:\\Node\\node.exe', serverScript: 'C:\\Ethere App\\server.mjs', dataRoot: 'C:\\Ethere Data' });
  assert.deepEqual(args.slice(0, 4), [
    '-c', 'mcp_servers.ethere_tools.command="C:\\\\Node\\\\node.exe"',
    '-c', 'mcp_servers.ethere_tools.args=["C:\\\\Ethere App\\\\server.mjs"]',
  ]);
  assert.ok(args.some((value) => value.includes('default_tools_approval_mode="approve"')));
  assert.ok(args.some((value) => value === 'mcp_servers.ethere_tools.env={ETHERE_API_BASE="http://127.0.0.1:4173",ETHERE_DATA_DIR="C:\\\\Ethere Data",ETHERE_DEVELOPER_BRIDGE_BASE="http://127.0.0.1:4174"}'));
  assert.ok(args.some((value) => value.includes('ethere_timeline_events_batch_create.approval_mode="approve"')));
  assert.ok(args.some((value) => value.includes('mcp_servers.dida365.enabled_tools=')));
  assert.ok(args.some((value) => value.includes('"create_task","update_task","complete_task"')));
  assert.ok(args.some((value) => value === 'mcp_servers.dida365.default_tools_approval_mode="prompt"'));
  assert.ok(args.some((value) => value === 'mcp_servers.dida365.url="https://mcp.dida365.com"'));
  assert.ok(args.some((value) => value.includes('ethere_supervised_tasks_get.approval_mode="approve"')));
  assert.ok(args.some((value) => value.includes('ethere_reminder_create.approval_mode="approve"')));
  assert.ok(args.some((value) => value.includes('ethere_space_post_create.approval_mode="approve"')));
  assert.ok(args.some((value) => value.includes('ethere_space_post_update.approval_mode="approve"')));
});

test('Ethere MCP cannot silently fall back to a different data directory', () => {
  assert.throws(() => buildEthereMcpConfigArgs(), /同一数据目录/);
});
