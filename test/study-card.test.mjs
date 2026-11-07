import test from 'node:test';
import assert from 'node:assert/strict';
import { studyCardFromTool } from '../server/study-card.mjs';

const plan = { id: 'plan-1', title: '学习语用学', currentLessonId: 'lesson-2', lessons: [
  { id: 'lesson-1', title: '语言与语境', status: 'done' },
  { id: 'lesson-2', title: '会话含义', status: 'pending' },
] };
const result = [{ type: 'text', text: JSON.stringify({ ok: true, plan }) }];

test('study create, open, and revision produce a visible plan card', () => {
  for (const [tool, action] of [
    ['ethere_study_plan_create', 'created'], ['ethere_study_plan_get', 'opened'], ['ethere_study_plan_update', 'updated'],
  ]) {
    const activity = studyCardFromTool({ server: 'ethere_tools', tool, status: 'completed', result, arguments: { action: 'revise_outline' } });
    assert.equal(activity.card.action, action);
    assert.equal(activity.card.title, '学习语用学');
    assert.equal(activity.card.currentLesson, '会话含义');
    assert.equal(activity.card.completedCount, 1);
  }
});

test('checkpoint does not flood chat with cards and failed writes do not show success', () => {
  assert.equal(studyCardFromTool({ server: 'ethere_tools', tool: 'ethere_study_plan_update', status: 'completed', arguments: { action: 'checkpoint' }, result }), null);
  assert.deepEqual(studyCardFromTool({ server: 'ethere_tools', tool: 'ethere_study_plan_create', status: 'failed', error: 'not saved' }), { content: '学习计划操作失败', status: 'failed' });
});
