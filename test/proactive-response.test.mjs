import assert from 'node:assert/strict';
import test from 'node:test';
import { proactiveVisibleText, SILENT_REPLY } from '../server/proactive-response.mjs';

test('proactive replies hide a final silence decision even after internal tool work', () => {
  assert.equal(proactiveVisibleText({ text: SILENT_REPLY, status: 'completed' }), '');
  assert.equal(proactiveVisibleText({
    text: `我先检查一下。\n${SILENT_REPLY}`,
    timeline: [
      { type: 'assistant', text: '我先检查一下。' },
      { type: 'activity', content: '已修改提醒' },
      { type: 'assistant', text: SILENT_REPLY },
    ],
  }), '');
  assert.equal(proactiveVisibleText({ text: '我先检查一下。', timeline: [{ type: 'assistant', text: '我先检查一下。' }, { type: 'activity' }] }), '');
  assert.equal(proactiveVisibleText({ text: '来看看你。', status: 'completed' }), '来看看你。');
});
