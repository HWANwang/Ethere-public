import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../server/config-store.mjs';
import { createDocumentMcpTools } from '../server/document-mcp-tools.mjs';

test('model can only propose a document revision against the exact current version', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-document-mcp-test-'));
  const store = new ConfigStore({ dataRoot });
  const current = await store.writeDocument('persona', '原来的人设');
  const tools = createDocumentMcpTools({ configStore: store });
  const proposal = await tools.call('ethere_document_propose', { name: 'persona', baseRevision: current.revision, previousText: current.text, text: '新的人设', reason: '用户明确同意' });
  assert.equal(proposal.pendingApproval, true);
  assert.equal((await store.readDocument('persona')).text, '原来的人设');
  await assert.rejects(tools.call('ethere_document_propose', { name: 'persona', baseRevision: current.revision, previousText: '篡改原文', text: '新的人设', reason: '不应通过' }), /原文与当前版本不一致/);
});
