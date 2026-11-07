import { mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const required = ['__zp_stoken__', 'wt2', 'wbg', 'zp_at'];

export function bossCookies(cookies = []) {
  const selected = cookies.filter((cookie) => cookie && /(^|\.)zhipin\.com$/i.test(String(cookie.domain || ''))
    && typeof cookie.name === 'string' && typeof cookie.value === 'string');
  const values = Object.fromEntries(selected.map(({ name, value }) => [name, value]));
  return { values, missing: required.filter((name) => !values[name]) };
}

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function browserVersion(debugPort, fetchImpl) {
  const response = await fetchImpl(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('BOSS 专用浏览器未连接');
  return response.json();
}

export async function ensureBossBrowser({ dataRoot, debugPort = 9229, fetchImpl = fetch, edgePath = EDGE_PATH, launch = spawn } = {}) {
  try { return await browserVersion(debugPort, fetchImpl); } catch { /* 专用窗口未启动时再打开。 */ }
  if (process.platform !== 'win32' || !existsSync(edgePath)) throw new Error('BOSS 专用浏览器未启动；请打开专用 Edge 窗口');
  const profile = join(dataRoot, 'integrations', 'boss-cli', 'browser-profile');
  await mkdir(profile, { recursive: true });
  const child = launch(edgePath, [
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`,
    '--new-window', 'https://www.zhipin.com/web/geek/jobs',
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref?.();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(400);
    try { return await browserVersion(debugPort, fetchImpl); } catch { /* 等待浏览器开放调试端口。 */ }
  }
  throw new Error('BOSS 专用浏览器未能启动；请在专用 Edge 窗口检查登录状态');
}

export async function importBossSession({ dataRoot, debugPort = 9229, fetchImpl = fetch, Socket = WebSocket, launchIfMissing = false } = {}) {
  if (!dataRoot) throw new Error('必须显式指定 ETHERE_DATA_DIR');
  const version = launchIfMissing
    ? await ensureBossBrowser({ dataRoot, debugPort, fetchImpl })
    : await browserVersion(debugPort, fetchImpl);
  const targets = await fetchImpl(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(3000) }).then((response) => response.json());
  const pages = targets.filter((target) => target.type === 'page' && /^https:\/\/([\w-]+\.)?zhipin\.com\//i.test(target.url || ''));
  if (pages.some((page) => /\/web\/passport\/zp\/verify\.html|\/web\/user\/safe|\/web\/user\/login/i.test(page.url || ''))
    && !pages.some((page) => /\/web\/geek\/jobs(?:[/?#]|$)/i.test(page.url || ''))) {
    throw new Error('BOSS 专用浏览器正在安全验证；请在已打开的窗口完成一次页面验证，不要反复扫码');
  }
  const address = String(version.webSocketDebuggerUrl || '');
  if (!address.startsWith(`ws://127.0.0.1:${debugPort}/`) && !address.startsWith(`ws://localhost:${debugPort}/`)) {
    throw new Error('专用浏览器调试端口不匹配');
  }
  const socket = new Socket(address);
  const cookies = await new Promise((resolveCookies, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('读取 BOSS 登录状态超时')); }, 5000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' })));
    socket.addEventListener('message', (event) => {
      try {
        const result = JSON.parse(event.data);
        if (result.id !== 1) return;
        clearTimeout(timer);
        if (result.error) reject(new Error('专用浏览器拒绝读取登录状态'));
        else resolveCookies(result.result?.cookies || []);
      } catch (error) { clearTimeout(timer); reject(error); }
    });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接专用浏览器')); });
  });
  const { values, missing } = bossCookies(cookies);
  if (missing.length) { socket.close(); throw new Error(`BOSS 网页尚未完成登录（缺少 ${missing.join('、')}）；请在专用窗口完成验证后重试`); }
  const directory = join(dataRoot, 'integrations', 'boss-cli');
  const file = join(directory, 'credential.json');
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify({ cookies: values, saved_at: Date.now() / 1000 }), { mode: 0o600 });
  await rename(temporary, file);
  socket.close();
  return { saved: true, cookieCount: Object.keys(values).length };
}

export async function reloadBossPage({ debugPort = 9229, fetchImpl = fetch, Socket = WebSocket } = {}) {
  const targets = await fetchImpl(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(3000) }).then((response) => response.json());
  const page = targets.find((target) => target.type === 'page'
    && /^https:\/\/([\w-]+\.)?zhipin\.com\//i.test(target.url || '')
    && target.webSocketDebuggerUrl);
  if (!page) throw new Error('BOSS 专用浏览器没有打开职位页');
  const socket = new Socket(page.webSocketDebuggerUrl);
  await new Promise((resolveReload, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('刷新 BOSS 页面超时')); }, 5000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: false } })));
    socket.addEventListener('message', (event) => {
      const result = JSON.parse(event.data);
      if (result.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (result.error) reject(new Error('BOSS 页面刷新失败'));
      else resolveReload();
    });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接 BOSS 专用页面')); });
  });
  await wait(1500);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await importBossSession({ dataRoot: process.env.ETHERE_DATA_DIR });
    console.log(`BOSS 专用登录已保存（${result.cookieCount} 项登录信息）。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
