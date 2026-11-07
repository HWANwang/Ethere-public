import { fileURLToPath } from 'node:url';
import { TIMELINE_MCP_TOOL_NAMES } from './timeline-mcp-tools.mjs';
import { MEMORY_MCP_TOOL_NAMES } from './memory-mcp-tools.mjs';
import { MEMORY_V2_MCP_TOOL_NAMES } from './memory-v2-mcp-tools.mjs';
import { TASK_MCP_TOOL_NAMES } from './task-mcp-tools.mjs';
import { REMINDER_MCP_TOOL_NAMES } from './reminder-mcp-tools.mjs';
import { SPACE_MCP_TOOL_NAMES } from './space-mcp-tools.mjs';
import { PHONE_USAGE_MCP_TOOL_NAMES } from './phone-usage-mcp-tools.mjs';
import { DEVELOPER_TASK_MCP_TOOL_NAMES } from './developer-task-mcp-tools.mjs';

export function buildEthereMcpConfigArgs({
  command = process.execPath,
  serverScript = fileURLToPath(new URL('./ethere-mcp-server.mjs', import.meta.url)),
  apiBase = 'http://127.0.0.1:4173',
  dataRoot,
  bridgeBaseUrl = 'http://127.0.0.1:4174',
} = {}) {
  if (!dataRoot) throw new Error('Ethere MCP 必须与主服务使用同一数据目录');
  const name = 'ethere_tools';
  const args = [
    '-c', `mcp_servers.${name}.command=${tomlString(command)}`,
    '-c', `mcp_servers.${name}.args=[${tomlString(serverScript)}]`,
    '-c', `mcp_servers.${name}.env={ETHERE_API_BASE=${tomlString(apiBase)},ETHERE_DATA_DIR=${tomlString(dataRoot)},ETHERE_DEVELOPER_BRIDGE_BASE=${tomlString(bridgeBaseUrl)}}`,
    '-c', `mcp_servers.${name}.default_tools_approval_mode="approve"`,
    '-c', 'mcp_servers.dida365.url="https://mcp.dida365.com"',
    '-c', 'mcp_servers.dida365.enabled_tools=["list_projects","filter_tasks","get_task_by_id","create_task","update_task","complete_task"]',
    '-c', 'mcp_servers.dida365.default_tools_approval_mode="prompt"',
  ];
  for (const toolName of [...TIMELINE_MCP_TOOL_NAMES, ...MEMORY_MCP_TOOL_NAMES, ...MEMORY_V2_MCP_TOOL_NAMES, ...TASK_MCP_TOOL_NAMES, ...REMINDER_MCP_TOOL_NAMES, ...SPACE_MCP_TOOL_NAMES, ...PHONE_USAGE_MCP_TOOL_NAMES, ...DEVELOPER_TASK_MCP_TOOL_NAMES]) {
    args.push('-c', `mcp_servers.${name}.tools.${toolName}.approval_mode="approve"`);
  }
  return args;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}
