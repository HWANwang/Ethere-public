import { resolve } from 'node:path';

export function assertOwnedListener({ port, childPid, listenerPid }) {
  if (!Number.isInteger(childPid) || childPid <= 0 || listenerPid !== childPid) {
    throw new Error(`端口 ${port} 不属于当前监督器启动的子进程`);
  }
}

export function assertMemoryLabIdentity({ childPid, listenerPid, health, dataDir, model }) {
  assertOwnedListener({ port: 4191, childPid, listenerPid });
  if (health?.pid !== childPid || !health?.dataDir ||
      resolve(health.dataDir).toLowerCase() !== resolve(dataDir).toLowerCase() ||
      health.embeddingModel !== model) {
    throw new Error('4191 的进程身份、数据目录或 embedding 模型与当前项目不符');
  }
}
