import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Only pass children created by this supervisor. Windows child.kill() does not
// stop descendants such as cmd.exe -> codex app-server, which can keep a thread writer.
export async function stopOwnedProcessTree(child, { platform = process.platform, run = execFileAsync } = {}) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  if (platform !== 'win32') {
    child.kill();
    return;
  }
  try {
    await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
  } catch (error) {
    if (child.exitCode != null || child.signalCode != null) return;
    throw new Error(`无法停止看门狗启动的进程树 PID ${child.pid}: ${error.message}`, { cause: error });
  }
}
