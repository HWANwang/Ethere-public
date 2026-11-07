import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class PhoneUsageDiagnostics {
  constructor({ dataRoot, now = () => new Date() }) {
    this.file = join(dataRoot, 'logs', 'phone-usage.jsonl');
    this.now = now;
    this.pending = Promise.resolve();
  }

  record(stage, details = {}) {
    const line = `${JSON.stringify({
      at: this.now().toISOString(),
      stage,
      requestId: String(details.requestId || ''),
      lookbackMinutes: Number(details.lookbackMinutes) || 0,
      channelConnected: details.channelConnected === true,
      error: String(details.error || '').slice(0, 300),
    })}\n`;
    this.pending = this.pending.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, line, 'utf8');
    });
    return this.pending;
  }
}
