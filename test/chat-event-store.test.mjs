import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatEventStore } from '../server/chat-event-store.mjs';

test('chat event store assigns cursors, deduplicates IDs, and reloads missed messages', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-events-test-'));
  const store = new ChatEventStore({ dataRoot });
  const first = await store.append({ id: 'message-0001', role: 'user', content: '第一条' });
  const duplicate = await store.append({ id: 'message-0001', role: 'user', content: '不应覆盖' });
  const second = await store.append({ id: 'message-0002', role: 'assistant', content: '第二条' });

  assert.equal(first.seq, 1);
  assert.deepEqual(duplicate, first);
  assert.equal(second.seq, 2);

  const restored = new ChatEventStore({ dataRoot });
  const result = await restored.listAfter(1);
  assert.equal(result.cursor, 2);
  assert.deepEqual(result.events.map((event) => event.content), ['第二条']);
});

test('chat event store imports legacy JSON once, preserves it, and continues in SQLite', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-events-migration-test-'));
  const state = join(dataRoot, 'state');
  await mkdir(state);
  const legacyFile = join(state, 'chat-events.json');
  const original = JSON.stringify({ version: 1, events: [
    { seq: 4, id: 'old-user', role: 'user', content: '旧消息', createdAt: '2026-10-30T01:00:00.000Z', source: 'chat', replyTo: '', status: 'completed' },
    { seq: 7, id: 'old-reply', role: 'assistant', content: '旧回复', createdAt: '2026-10-30T01:01:00.000Z', source: 'chat', replyTo: 'old-user', status: 'completed', turnComplete: true },
  ] });
  await writeFile(legacyFile, original);
  const store = new ChatEventStore({ dataRoot });
  assert.deepEqual((await store.listAfter(0)).events.map((event) => event.seq), [4, 7]);
  assert.equal((await store.append({ id: 'new-user', role: 'user', content: '新消息' })).seq, 8);
  assert.equal(await readFile(legacyFile, 'utf8'), original);
  const restored = new ChatEventStore({ dataRoot });
  assert.deepEqual((await restored.listAfter(0)).events.map((event) => event.id), ['old-user', 'old-reply', 'new-user']);
});

test('chat event store preserves local activity events', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-events-test-'));
  const store = new ChatEventStore({ dataRoot });
  const event = await store.append({ id: 'activity-0001', role: 'activity', content: '已完成上下文压缩', source: 'compaction' });
  assert.equal(event.role, 'activity');
  assert.equal(event.source, 'compaction');
});

test('phone usage notice remains a non-message event in live chat and history', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-events-notice-test-'));
  const store = new ChatEventStore({ dataRoot });
  await store.append({ id: 'notice-1', role: 'notice', source: 'phone-usage', content: '刚刚看了看你的手机使用情况' });
  const restored = new ChatEventStore({ dataRoot });
  const live = await restored.listAfter(0);
  const history = await restored.listHistory();
  assert.equal(live.events[0].role, 'notice');
  assert.equal(live.events[0].source, 'phone-usage');
  assert.equal(history.events[0].role, 'notice');
});

test('visible call and popup notices survive reopening chat while silent receipts stay hidden', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-device-notice-test-'));
  const store = new ChatEventStore({ dataRoot });
  await store.append({ id: 'call-start', role: 'notice', source: 'voice-call', content: '你给 Ethere 打了电话' });
  await store.append({ id: 'popup-visible', role: 'notice', source: 'device-action', content: 'Ethere 弹出了一条提示' });
  await store.append({ id: 'silent-receipt', role: 'notice', source: 'device-action', content: '' });
  await store.append({ id: 'device-action-result-legacy', role: 'notice', source: 'device-action', content: '设备动作已处理' });
  const history = await new ChatEventStore({ dataRoot }).listHistory();
  assert.deepEqual(history.events.map((event) => event.id), ['call-start', 'popup-visible']);
});

test('chat event store keeps a quote separate from turn replyTo across reloads', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-events-quote-test-'));
  const store = new ChatEventStore({ dataRoot });
  await store.append({ id: 'assistant-source-0001', role: 'assistant', content: '先休息一下。' });
  await store.append({ id: 'user-quote-0001', role: 'user', content: '好', quote: { sourceMessageId: 'assistant-source-0001', sourceRole: 'assistant', text: '先休息一下。' } });
  const restored = new ChatEventStore({ dataRoot });
  const quoted = await restored.getById('user-quote-0001');
  assert.deepEqual(quoted.quote, { sourceMessageId: 'assistant-source-0001', sourceRole: 'assistant', text: '先休息一下。' });
  assert.equal(quoted.replyTo, '');
});

test('study plan card survives chat event reload', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-study-card-test-'));
  const store = new ChatEventStore({ dataRoot });
  await store.append({ id: 'study-card-1', role: 'activity', source: 'mcp', content: '已创建学习计划', card: {
    kind: 'study-plan', action: 'created', planId: 'plan-1', title: '语用学', currentLesson: '语言与语境', completedCount: 0, lessonCount: 3,
  } });
  const restored = await new ChatEventStore({ dataRoot }).getById('study-card-1');
  assert.equal(restored.card.kind, 'study-plan');
  assert.equal(restored.card.currentLesson, '语言与语境');
});

test('chat event store persists the final segment marker for one notification per turn', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-events-test-'));
  const store = new ChatEventStore({ dataRoot });
  await store.append({ id: 'reply-a', role: 'assistant', content: '先查一下', replyTo: 'user-a' });
  await store.append({ id: 'tool-a', role: 'activity', content: '已调用工具', replyTo: 'user-a' });
  await store.append({ id: 'reply-b', role: 'assistant', content: '查到了', replyTo: 'user-a', turnComplete: true });
  const restored = new ChatEventStore({ dataRoot });
  const result = await restored.listAfter(0);
  assert.deepEqual(result.events.map((event) => event.turnComplete), [false, false, true]);
});

test('chat event store preserves settings activity events', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-events-test-'));
  const store = new ChatEventStore({ dataRoot });
  const event = await store.append({ id: 'activity-0002', role: 'activity', content: '已切换对话模型', source: 'settings' });
  assert.equal(event.source, 'settings');
});

test('chat event store persists approval payloads and republishes their resolution with a new cursor', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-events-test-'));
  const store = new ChatEventStore({ dataRoot });
  const pending = await store.append({
    id: 'approval-0001', role: 'activity', content: '建议新增二级分类 · 散步', source: 'mcp', status: 'pending',
    approval: { kind: 'timeline-category-create', status: 'pending', proposal: { level: 'secondary', name: '散步', parentCategoryId: 'life', reason: '会重复出现' } },
  });
  const resolved = await store.update(pending.id, {
    content: '已采用分类建议 · 散步', status: 'completed',
    approval: { ...pending.approval, status: 'accepted', resolvedAt: '2026-10-29T08:00:00.000Z', categoryId: 'life', subcategoryId: 'walking' },
  });
  assert.ok(resolved.seq > pending.seq);
  assert.equal(resolved.approval.status, 'accepted');
  assert.deepEqual((await store.listAfter(pending.seq)).events.map((event) => event.id), ['approval-0001']);
});

test('chat event store preserves Dida task approval details', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-events-test-'));
  const store = new ChatEventStore({ dataRoot });
  const pending = await store.append({
    id: 'approval-task-0001', role: 'activity', content: '建议新建滴答任务 · 写测试', source: 'mcp', status: 'pending',
    approval: { kind: 'dida-task-change', status: 'pending', proposal: { operation: 'create', projectId: 'p1', projectName: '监督清单', title: '写测试', dueAt: '2026-10-30T10:00:00+08:00', repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1', reason: '用户想安排这件事' } },
  });
  assert.equal(pending.approval.kind, 'dida-task-change');
  assert.equal(pending.approval.proposal.projectName, '监督清单');
  assert.equal(pending.approval.proposal.dueAt, '2026-10-30T10:00:00+08:00');
  assert.equal(pending.approval.proposal.repeatFlag, 'RRULE:FREQ=DAILY;INTERVAL=1');
});

test('chat event store returns all assistant segments and MCP activities for a reply', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-chat-events-test-'));
  const store = new ChatEventStore({ dataRoot });
  await store.append({ id: 'user-tool', role: 'user', content: '记一下' });
  await store.append({ id: 'reply-tool', role: 'assistant', content: '我先记。', replyTo: 'user-tool' });
  await store.append({ id: 'activity-tool', role: 'activity', content: '已记录时间线', source: 'mcp', replyTo: 'user-tool' });
  await store.append({ id: 'reply-tool-2', role: 'assistant', content: '记好了。', replyTo: 'user-tool' });
  assert.deepEqual((await store.listRepliesTo('user-tool')).map((event) => event.id), ['reply-tool', 'activity-tool', 'reply-tool-2']);
});

test('chat event store repairs a browser cursor that is ahead of the server', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-events-test-'));
  const store = new ChatEventStore({ dataRoot });
  await store.append({ id: 'message-0001', role: 'assistant', content: '主动来看看你。', source: 'checkin' });
  const result = await store.listAfter(99);
  assert.equal(result.reset, true);
  assert.equal(result.cursor, 1);
  assert.deepEqual(result.events.map((event) => event.id), ['message-0001']);
});

test('chat event store publishes appended and revised events to SSE subscribers', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-events-test-'));
  const store = new ChatEventStore({ dataRoot });
  const published = [];
  const unsubscribe = store.subscribe((event) => published.push(event));
  const first = await store.append({ id: 'live-1', role: 'assistant', content: '我来看看你。', source: 'checkin' });
  const revised = await store.update(first.id, { content: '我来陪陪你。' });
  unsubscribe();
  await store.append({ id: 'live-2', role: 'assistant', content: '不应继续推送' });
  assert.deepEqual(published.map((event) => event.content), ['我来看看你。', '我来陪陪你。']);
  assert.ok(revised.seq > first.seq);
});

test('chat history pages backward and locates the first message of a Beijing date', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-events-test-'));
  const store = new ChatEventStore({ dataRoot });
  await store.append({ id: 'late-28', role: 'user', content: '二十八日晚', createdAt: '2026-10-28T15:59:00.000Z' });
  await store.append({ id: 'early-29', role: 'assistant', content: '二十九日零点', createdAt: '2026-10-28T16:01:00.000Z' });
  await store.append({ id: 'later-29', role: 'user', content: '二十九日上午', createdAt: '2026-10-29T02:00:00.000Z' });
  await store.append({ id: 'on-30', role: 'assistant', content: '三十日', createdAt: '2026-10-29T16:01:00.000Z' });

  const recent = await store.listHistory({ limit: 2 });
  assert.deepEqual(recent.events.map((event) => event.id), ['later-29', 'on-30']);
  assert.equal(recent.hasMore, true);
  const older = await store.listHistory({ before: recent.before, limit: 2 });
  assert.deepEqual(older.events.map((event) => event.id), ['late-28', 'early-29']);

  const firstDatePage = await store.listHistory({ date: '2026-10-29', limit: 1 });
  assert.deepEqual(firstDatePage.events.map((event) => event.id), ['early-29']);
  assert.equal(firstDatePage.hasMore, true);
  const nextDatePage = await store.listHistory({ date: '2026-10-29', after: firstDatePage.after, limit: 1 });
  assert.deepEqual(nextDatePage.events.map((event) => event.id), ['later-29']);
  assert.equal(nextDatePage.hasMore, false);

  const exactSearch = await store.listHistory({ query: '十九日零点' });
  assert.deepEqual(exactSearch.events.map((event) => event.id), ['early-29']);
  const noFuzzySearch = await store.listHistory({ query: '十九零点' });
  assert.equal(noFuzzySearch.events.length, 0);
});
