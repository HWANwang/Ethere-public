const TOOLS = new Set(['ethere_study_plan_create', 'ethere_study_plan_get', 'ethere_study_plan_update']);
const ACTIONS = {
  ethere_study_plan_create: 'created',
  ethere_study_plan_get: 'opened',
  ethere_study_plan_update: 'updated',
};

export function studyCardFromTool(item = {}) {
  if (item.server !== 'ethere_tools' || !TOOLS.has(item.tool)) return null;
  if (item.tool === 'ethere_study_plan_update' && item.arguments?.action === 'checkpoint') return null;
  const failed = item.status !== 'completed' || Boolean(item.error);
  if (failed) return { content: '学习计划操作失败', status: 'failed' };
  const result = resultData(item.result);
  const plan = result?.plan || {};
  const args = item.arguments || {};
  const title = String(plan.title || args.title || '').trim().slice(0, 80);
  const planId = String(plan.id || args.planId || '').trim().slice(0, 80);
  if (!title && !planId) return null;
  const lessons = Array.isArray(plan.lessons) ? plan.lessons : Array.isArray(args.lessons) ? args.lessons : [];
  const current = lessons.find((lesson) => lesson?.id && lesson.id === plan.currentLessonId)
    || (item.tool === 'ethere_study_plan_create' ? lessons[0] : null);
  const card = {
    kind: 'study-plan', action: ACTIONS[item.tool], planId, title: title || '学习计划',
    currentLesson: String(typeof current === 'string' ? current : current?.title || '').slice(0, 100),
    completedCount: lessons.filter((lesson) => lesson?.status === 'done').length,
    lessonCount: lessons.length,
  };
  const label = card.action === 'created' ? '已创建' : card.action === 'opened' ? '继续学习' : '已更新';
  return { content: `${label}学习计划 · ${card.title}`, status: 'completed', card };
}

function resultData(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (Array.isArray(value)) return value.map(resultData).find((item) => item?.plan) || null;
  if (!value || typeof value !== 'object') return null;
  if (value.plan) return value;
  if (Array.isArray(value.content)) return resultData(value.content);
  if (typeof value.text === 'string') return resultData(value.text);
  return null;
}
