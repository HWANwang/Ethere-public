import { createServer } from 'node:http';

export function createDeveloperBridgeServer({ manager, token }) {
  if (!manager || !token) throw new Error('开发代理桥缺少管理器或本机令牌');
  return createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    try {
      if (url.pathname === '/health' && request.method === 'GET') return json(response, 200, { connected: true });
      if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: 'unauthorized' });
      if (url.pathname === '/tasks' && request.method === 'POST') return json(response, 202, await manager.create(await body(request)));
      if (url.pathname === '/tasks' && request.method === 'GET') return json(response, 200, { tasks: await manager.list(), allowedRoots: manager.allowedRoots });
      const task = url.pathname.match(/^\/tasks\/([0-9a-f-]+)$/iu);
      if (task && request.method === 'GET') return json(response, 200, await manager.get(task[1]));
      const send = url.pathname.match(/^\/tasks\/([0-9a-f-]+)\/send$/iu);
      if (send && request.method === 'POST') return json(response, 202, await manager.send(send[1], (await body(request)).instruction));
      const cancel = url.pathname.match(/^\/tasks\/([0-9a-f-]+)\/cancel$/iu);
      if (cancel && request.method === 'POST') return json(response, 200, await manager.cancel(cancel[1]));
      if (url.pathname === '/events' && request.method === 'GET') return json(response, 200, { events: await manager.pendingEvents() });
      const ack = url.pathname.match(/^\/events\/([^/]+)\/ack$/u);
      if (ack && request.method === 'POST') return json(response, 200, { acknowledged: await manager.acknowledgeEvent(decodeURIComponent(ack[1])) });
      return json(response, 404, { error: 'not found' });
    } catch (error) {
      return json(response, error?.statusCode || 500, { error: error?.message || 'internal error' });
    }
  });
}

async function body(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk.toString();
    if (text.length > 64_000) { const error = new Error('请求过大'); error.statusCode = 413; throw error; }
  }
  try { return JSON.parse(text || '{}'); }
  catch { const error = new Error('请求不是 JSON'); error.statusCode = 400; throw error; }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
