import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatService } from '../server/chat-service.mjs';
import { ConfigStore } from '../server/config-store.mjs';
import { MemoryNodeStore } from '../server/memory-node-store.mjs';
import { UnifiedMemoryStore } from '../server/unified-memory-store.mjs';

test('two threads load the same shared core memory, persona and operations without copying them', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-shared-instructions-'));
  const configStore = new ConfigStore({ dataRoot });
  const nodes = new MemoryNodeStore({ dataRoot });
  const memoryStore = new UnifiedMemoryStore({ dataRoot, memoryNodeStore: nodes });
  await memoryStore.initialize();
  await configStore.writeDocument('persona', '共同的人设');
  await configStore.writeDocument('operations', '共同的操作规则');
  await memoryStore.create({ title: '共同的核心记忆', contentMarkdown: '这是一条跨线程共享的记忆。' });

  const starts = [];
  const turns = [];
  const client = {
    async initialize() {},
    onMessage(listener) { this.listener = listener; return () => { this.listener = null; }; },
    async request(method, params) {
      if (method === 'thread/start') {
        starts.push(params);
        return { thread: { id: `thread-${starts.length}` } };
      }
      if (method === 'turn/start') {
        turns.push(params);
        queueMicrotask(() => this.listener?.({ method: 'turn/completed', params: {
          threadId: params.threadId, turn: { id: 'turn-1', status: 'completed' },
        } }));
        return { turn: { id: 'turn-1' } };
      }
      if (method === 'thread/compact/start') {
        queueMicrotask(() => this.listener?.({ method: 'item/completed', params: {
          threadId: params.threadId, item: { id: 'compact-1', type: 'contextCompaction' },
        } }));
      }
      return {};
    },
  };
  const service = new ChatService({ client, dataRoot, configStore, memoryStore, memoryNodeStore: nodes });
  await service.sendText('第一条');
  await service.startNewThread();
  await service.sendText('第二条');
  await service.compactThread();

  assert.equal(starts.length, 2);
  for (const start of starts) {
    assert.match(start.developerInstructions, /共同的人设/);
    assert.match(start.developerInstructions, /共同的操作规则/);
    assert.match(start.developerInstructions, /共同的核心记忆/);
  }
  const afterCompaction = turns.at(-1).input[0].text;
  assert.match(afterCompaction, /共同的人设/);
  assert.match(afterCompaction, /共同的操作规则/);
  assert.match(afterCompaction, /共同的核心记忆/);
  assert.equal((await memoryStore.list()).activeCount, 1);
  assert.equal((await configStore.readDocument('persona')).text, '共同的人设');
  assert.equal((await configStore.readDocument('operations')).text, '共同的操作规则');
  assert.equal(JSON.parse(await readFile(join(dataRoot, 'state', 'chat-session.json'), 'utf8')).threadId, 'thread-2');
  assert.equal(await readFile(join(dataRoot, 'config', 'documents', 'persona.md'), 'utf8'), '共同的人设');
  nodes.database.close();
});
