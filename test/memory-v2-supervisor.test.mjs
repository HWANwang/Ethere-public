import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnedListener, assertMemoryLabIdentity } from '../server/memory-v2-ownership.mjs';

test('memory supervisor refuses an orphaned or foreign port listener', () => {
  assert.throws(() => assertOwnedListener({ port: 8180, childPid: undefined, listenerPid: 41200 }), /不属于当前监督器/);
  assert.throws(() => assertOwnedListener({ port: 8180, childPid: 100, listenerPid: 200 }), /不属于当前监督器/);
  assert.doesNotThrow(() => assertOwnedListener({ port: 8180, childPid: 100, listenerPid: 100 }));
});

test('memory lab listener must match process, shared runtime directory and embedding model', () => {
  const dataDir = 'C:/ethere/memory-lab/runtime';
  const health = { pid: 200, dataDir, embeddingModel: 'bge-base-zh-v1.5-q8' };
  const base = { childPid: 200, listenerPid: 200, health, dataDir, model: 'bge-base-zh-v1.5-q8' };
  assert.doesNotThrow(() => assertMemoryLabIdentity(base));
  assert.throws(() => assertMemoryLabIdentity({ ...base, childPid: undefined }), /不属于当前监督器/);
  assert.throws(() => assertMemoryLabIdentity({ ...base, health: { ...health, pid: 201 } }), /进程身份/);
  assert.throws(() => assertMemoryLabIdentity({ ...base, health: { ...health, dataDir: 'C:/other/runtime' } }), /数据目录/);
  assert.throws(() => assertMemoryLabIdentity({ ...base, health: { ...health, embeddingModel: 'wrong' } }), /embedding 模型/);
});
