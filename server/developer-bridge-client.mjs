import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class DeveloperBridgeClient {
  constructor({ dataRoot, baseUrl = 'http://127.0.0.1:4174', fetcher = fetch }) {
    if (!dataRoot) throw new Error('开发代理桥客户端需要显式 ETHERE_DATA_DIR');
    this.tokenFile = join(dataRoot, 'runtime', 'developer-bridge-token');
    this.baseUrl = baseUrl;
    this.fetcher = fetcher;
  }

  async request(method, path, payload) {
    const token = (await readFile(this.tokenFile, 'utf8')).trim();
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      method, headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || `开发代理桥 HTTP ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return data;
  }

  create(args) { return this.request('POST', '/tasks', args); }
  get(id) { return this.request('GET', `/tasks/${encodeURIComponent(id)}`); }
  list() { return this.request('GET', '/tasks'); }
  send(id, instruction) { return this.request('POST', `/tasks/${encodeURIComponent(id)}/send`, { instruction }); }
  cancel(id) { return this.request('POST', `/tasks/${encodeURIComponent(id)}/cancel`, {}); }
  pendingEvents() { return this.request('GET', '/events'); }
  acknowledgeEvent(id) { return this.request('POST', `/events/${encodeURIComponent(id)}/ack`, {}); }
}
