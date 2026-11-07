import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../docs/', import.meta.url));
const port = Number(process.env.DEMO_PORT || 4300);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    return response.end();
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400); return response.end(); }
  const target = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  const inside = relative(root, target);
  if (inside.startsWith('..') || isAbsolute(inside) || !Object.hasOwn(mime, extname(target))) {
    response.writeHead(404);
    return response.end();
  }
  try {
    const body = await readFile(target);
    response.writeHead(200, { 'Content-Type': mime[extname(target)], 'Cache-Control': 'no-store' });
    return response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404);
    return response.end();
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Ethere offline demo: http://127.0.0.1:${port}/`);
});
