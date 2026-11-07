import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesSpacePost } from '../web/space-filter.js';

const today = '2026-10-29';
const mineToday = { author: 'user', date: '2026-10-29' };
const assistantYesterday = { author: 'assistant', date: '2026-10-28' };

test('space author filter separates user and assistant while all includes both', () => {
  assert.equal(matchesSpacePost(mineToday, { author: 'user', time: 'all' }, today), true);
  assert.equal(matchesSpacePost(assistantYesterday, { author: 'user', time: 'all' }, today), false);
  assert.equal(matchesSpacePost(assistantYesterday, { author: 'assistant', time: 'all' }, today), true);
  assert.equal(matchesSpacePost(mineToday, { author: 'all', time: 'all' }, today), true);
});

test('recent-day filters include today and exclude the boundary day', () => {
  const filters = { author: 'all', time: '7' };
  assert.equal(matchesSpacePost({ author: 'user', date: '2026-10-23' }, filters, today), true);
  assert.equal(matchesSpacePost({ author: 'user', date: '2026-10-22' }, filters, today), false);
  assert.equal(matchesSpacePost({ author: 'user', date: '2026-10-30' }, filters, today), false);
});

test('custom range is inclusive and combines with the author filter', () => {
  const filters = { author: 'assistant', time: 'custom', start: '2026-10-24', end: '2026-10-28' };
  assert.equal(matchesSpacePost({ author: 'assistant', date: '2026-10-24' }, filters, today), true);
  assert.equal(matchesSpacePost({ author: 'assistant', date: '2026-10-28' }, filters, today), true);
  assert.equal(matchesSpacePost({ author: 'user', date: '2026-10-26' }, filters, today), false);
  assert.equal(matchesSpacePost({ author: 'assistant', date: '2026-10-29' }, filters, today), false);
});
