import { homedir, tmpdir } from 'node:os';
import { join, resolve, normalize } from 'node:path';

export function resolveDataRoot(env = process.env) {
  if (env.ETHERE_DATA_DIR) return env.ETHERE_DATA_DIR;
  if (process.platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'Ethere', 'data');
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, 'ethere');
  const home = homedir();
  return home ? join(home, '.local', 'share', 'ethere') : join(tmpdir(), 'ethere-data');
}

export function resolveProjectDataRoot(projectRoot, env = process.env) {
  const expected = resolve(projectRoot, 'local-data');
  if (env.ETHERE_DATA_DIR) {
    const actual = resolve(env.ETHERE_DATA_DIR);
    const equal = process.platform === 'win32'
      ? normalize(actual).toLowerCase() === normalize(expected).toLowerCase()
      : actual === expected;
    if (!equal) throw new Error(`ETHERE_DATA_DIR 与当前项目不一致：${actual}；预期 ${expected}`);
  }
  return expected;
}
