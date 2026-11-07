import assert from 'node:assert/strict';
import test from 'node:test';
import { clearUnreadThroughLatest, unreadSince } from '../web/chat-unread.js';

test('reaching latest by reading clears skipped completed messages but keeps a streaming reply unread', () => {
  const unread = new Set(['old-long-reply', 'approval', 'still-streaming']);
  const changed = clearUnreadThroughLatest(unread, [
    { id: 'old-long-reply', status: 'completed' },
    { id: 'approval', status: 'pending' },
    { id: 'still-streaming', status: 'streaming' },
  ]);
  assert.equal(changed, true);
  assert.deepEqual([...unread], ['still-streaming']);
  assert.equal(clearUnreadThroughLatest(unread, [{ id: 'still-streaming', status: 'streaming' }]), false);
});

test('returning from another page only reveals messages received while away', () => {
  assert.deepEqual([...unreadSince(new Set(['old-21:25']), new Set(['old-21:25']))], []);
  assert.deepEqual([...unreadSince(new Set(['old-21:25', 'new']), new Set(['old-21:25']))], ['new']);
});
