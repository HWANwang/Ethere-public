import assert from 'node:assert/strict';
import test from 'node:test';
import { sortRemindersForDisplay } from '../web/reminder-sort.js';

test('completed reminders stay below active and cancelled reminders', () => {
  const input = [
    { id: 'completed-early', status: 'completed' },
    { id: 'scheduled-first', status: 'scheduled' },
    { id: 'cancelled', status: 'cancelled' },
    { id: 'scheduled-second', status: 'scheduled' },
    { id: 'completed-late', status: 'completed' },
  ];

  assert.deepEqual(
    sortRemindersForDisplay(input).map((item) => item.id),
    ['scheduled-first', 'scheduled-second', 'cancelled', 'completed-early', 'completed-late'],
  );
  assert.equal(input[0].id, 'completed-early');
});
