import test from 'node:test';
import assert from 'node:assert/strict';
import { contextualRecallQuery } from '../src/recall-query.mjs';
import { topicalSupport } from '../src/auto-injection.mjs';

test('保留用户原话，聚焦末尾问题，只引用当时已发生的对话', () => {
  const query='我在整理旅行照片。你优化了一下记忆召回，现在能找到相关经历吗？';
  const at='2026-11-07T02:00:00.000Z';
  const result=contextualRecallQuery(query,[
    { seq:1,role:'user',content:'记忆库的召回排序还不准',createdAt:'2026-11-07T01:00:00.000Z' },
    { seq:2,role:'assistant',content:'上次的电影还想继续看吗',createdAt:'2026-11-07T01:30:00.000Z' },
    { seq:3,role:'user',content:'未来才会发生的记忆库消息',createdAt:'2026-11-07T03:00:00.000Z' },
  ],at);
  assert.equal(result.raw,query);
  assert.match(result.focus,/记忆召回/);
  assert.deepEqual(result.contextSeq,[1]);
  assert.doesNotMatch(result.contextQuery,/未来/);
});

test('领域词匹配比泛化的更新时间词更有锚点', () => {
  assert.ok(topicalSupport('技术面试怎么样','技术面试怎么样','','用户通过技术面试第一轮') > 0);
  assert.equal(topicalSupport('视频更新后没有了','视频更新后没有了','','按她更新后的决定调整'),0);
});
