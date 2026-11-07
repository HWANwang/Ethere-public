import test from 'node:test';
import assert from 'node:assert/strict';
import { appendSharedText, sharedFileKind, sharedTextForComposer } from '../web/shared-content.js';

test('shared link text becomes only the link, preserving an existing draft', () => {
  assert.equal(sharedTextForComposer('这篇文章 https://mp.weixin.qq.com/s/test ，快看看'), 'https://mp.weixin.qq.com/s/test');
  assert.equal(appendSharedText('我想聊聊', '标题 https://example.com/a'), '我想聊聊\nhttps://example.com/a');
  assert.equal(appendSharedText('https://example.com/a', '标题 https://example.com/a'), 'https://example.com/a');
  assert.equal(sharedTextForComposer('只分享一段文字'), '只分享一段文字');
});

test('shared attachments reuse existing image and document support', () => {
  assert.equal(sharedFileKind({ name: 'photo.jpg', mime: 'image/jpeg' }), 'image');
  assert.equal(sharedFileKind({ name: 'note.md', mime: 'application/octet-stream' }), 'file');
  assert.equal(sharedFileKind({ name: 'bill.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'unsupported');
});
