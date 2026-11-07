import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpaceMcpTools } from '../server/space-mcp-tools.mjs';

test('space MCP reads compact posts and only writes assistant posts through bounded endpoints', async () => {
  const requests = [];
  const tools = createSpaceMcpTools({ apiBase: 'http://ethere.test', async fetchImpl(url, options = {}) {
    requests.push({ url: String(url), options });
    return { ok: true, async json() { return { posts: [], post: { id: 'p1', author: 'assistant' } }; } };
  } });
  assert.deepEqual(tools.list().map((tool) => tool.name), ['ethere_space_recent_get', 'ethere_space_post_create', 'ethere_space_post_update']);
  await tools.call('ethere_space_recent_get', { author: 'all', limit: 5 });
  await tools.call('ethere_space_post_create', { contentMarkdown: '观察' });
  await tools.call('ethere_space_post_update', { postId: 'p1', baseRevision: 1, contentMarkdown: '重写' });
  assert.match(requests[0].url, /compact=true/);
  assert.match(requests[1].url, /space\/posts\/assistant$/);
  assert.match(requests[2].url, /space\/posts\/p1\/assistant$/);
  assert.match(tools.list()[1].description, /作者由服务器固定为 assistant/);
});
