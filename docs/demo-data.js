export const SCRIPTED_SCENARIOS = Object.freeze([
  {
    id: 'reminder',
    matches: ['提醒', '明晚'],
    reply: '你希望明晚几点继续？我们可以先选一个容易开始的小目标。',
  },
  {
    id: 'memory',
    matches: ['记忆', '回忆', '偏好', '记住'],
    reply: '我记得你更喜欢一次弄清一个概念，再决定是否继续。那这次也慢慢来。',
  },
  {
    id: 'learning',
    matches: ['学习', '课', '天文', '星星', '计划'],
    reply: '好，我们把第一节缩到一个能立刻开始的问题：抬头看到的星星为什么会发光？如果你愿意，我会从恒星内部发生的事讲起。',
  },
]);

export function scriptedReply(input) {
  const query = String(input ?? '').trim();
  const scenario = SCRIPTED_SCENARIOS.find(({ matches }) => matches.some((word) => query.includes(word)));
  return scenario ?? {
    id: 'general',
    reply: '我在听。你想从哪里说起？',
  };
}
