// The public preview uses the real Ethere frontend with an in-memory data source.
import { scriptedReply } from '../demo-data.js';

const clone = (value) => structuredClone(value);
const isoAt = (hour, minute, dayOffset = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};
const now = () => new Date().toISOString();
const afterMinutes = (minutes) => new Date(Math.max(Date.now(), Date.parse(state.events.at(-1)?.createdAt) || 0) + minutes * 60_000).toISOString();
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const skyImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="620" viewBox="0 0 900 620"><defs><linearGradient id="a" x2="0" y2="1"><stop stop-color="#131b3e"/><stop offset="1" stop-color="#565589"/></linearGradient></defs><rect width="900" height="620" fill="url(#a)"/><circle cx="690" cy="125" r="48" fill="#f5f1cf"/><path d="M0 470Q180 365 330 455T700 420T900 480V620H0" fill="#263254"/><path d="M0 525Q220 435 420 520T900 490V620H0" fill="#182440"/><g fill="#fff" opacity=".85"><circle cx="70" cy="95" r="2"/><circle cx="190" cy="165" r="3"/><circle cx="340" cy="65" r="2"/><circle cx="520" cy="210" r="2"/><circle cx="790" cy="250" r="3"/><circle cx="130" cy="300" r="2"/><circle cx="415" cy="250" r="2"/></g></svg>')}`;

const state = {
  seq: 0,
  events: [],
  listeners: new Set(),
  settings: { bossName: 'Ethere', model: 'default', voiceId: '3581b26bce1840f4a70dd0269946120c', checkin: { enabled: true, minMinutes: 30, maxMinutes: 90 }, dida: { projects: [] } },
  documents: {
    persona: { text: '保持好奇，认真倾听。对不确定的事提出可被纠正的理解。', revision: '1' },
    operations: { text: '先理解请求，再选择必要的工具。已经呈现在界面的结果，无须重复汇报。', revision: '1' },
  },
  categories: [
    { id: 'study', name: '学习', color: '#777dc5', status: 'active', children: [{ id: 'reading', name: '阅读', status: 'active' }, { id: 'explore', name: '探索', status: 'active' }] },
    { id: 'life', name: '生活', color: '#76a88c', status: 'active', children: [{ id: 'rest', name: '休息', status: 'active' }, { id: 'walk', name: '散步', status: 'active' }] },
  ],
  timeline: [
    { id: 'night-sky', title: '观察夜空', note: '第一次认真找到了北极星。', categoryId: 'study', subcategoryId: 'explore', startedAt: isoAt(19, 30), endedAt: isoAt(20, 10), revision: 1 },
    { id: 'astronomy-reading', title: '读天文学入门', note: '弄清了恒星和行星的区别。', categoryId: 'study', subcategoryId: 'reading', startedAt: isoAt(20, 20), endedAt: isoAt(21, 0), revision: 1 },
  ],
  review: { text: '今天从夜空里能看见的星星开始，没有急着把整本书读完。', revision: 1 },
  posts: [
    { id: 'post-1', author: 'user', occurredAt: isoAt(20, 15), contentMarkdown: '今晚第一次认真找北极星。原来抬头看一会儿，就能慢慢认出天空的方向。', images: [{ id: 'photo-night-sky', previewUrl: skyImage, originalUrl: skyImage }], revision: 1 },
    { id: 'post-2', author: 'assistant', occurredAt: isoAt(21, 10), contentMarkdown: '她说想学天文学，却不想再被一份很长的计划吓住。或许从今晚看见的那颗星开始，正合适。', images: [], revision: 1 },
  ],
  core: [
    { id: 'core-learning', title: '学习时偏好小步推进', contentMarkdown: '学习新主题时，先弄清一个概念，再决定要不要继续；不喜欢一开始就被完整课程压住。', updatedAt: now(), revision: 1 },
  ],
  archivedCore: [],
  dynamic: [
    { id: 'memory-astronomy', memory_type: 'fact', state: 'remember', content: '开始从观察夜空学习天文学；第一次认出了北极星。', version: 1, updatedAt: now() },
    { id: 'memory-pace', memory_type: 'interpretation', state: 'watch', content: '当学习计划太长时，可能更容易犹豫；从一个问题开始更容易进入。', version: 1, updatedAt: now() },
  ],
  plan: { id: 'study-astronomy', title: '从夜空认识天文学', status: 'active', completedCount: 1, lessonCount: 3, currentLessonId: 'lesson-2', currentLessonTitle: '星星为什么发光', checkpoint: '已经认识北极星，接着从恒星的光说起。', lessons: [
    { id: 'lesson-1', title: '先找到北极星', status: 'done' },
    { id: 'lesson-2', title: '星星为什么发光', status: 'pending' },
    { id: 'lesson-3', title: '恒星与行星有什么不同', status: 'pending' },
  ] },
  reminders: [{ id: 'reminder-1', title: '继续看夜空', message: '今晚想不想继续认星星？', triggerAt: isoAt(20, 30, 1), status: 'scheduled', revision: 1 }],
  categoryRevision: 1,
  archivedTimeline: [],
};

function addEvent(role, content, extra = {}) {
  const previousAt = Date.parse(state.events.at(-1)?.createdAt) || 0;
  const proposedAt = Date.parse(extra.createdAt || now()) || Date.now();
  const createdAt = new Date(Math.max(proposedAt, previousAt + 1_000)).toISOString();
  const event = { id: id(role), seq: ++state.seq, role, content, status: 'completed', source: 'chat', ...extra, createdAt };
  state.events.push(event);
  return event;
}
function broadcast(events) {
  const batch = { events: clone(events), cursor: state.seq, reminderCount: state.reminders.filter((item) => item.status === 'scheduled').length };
  for (const listener of state.listeners) listener(batch);
}
function storedSpaceImages(images, previous = []) {
  return images.map((image) => {
    const kept = image.id ? previous.find((item) => item.id === image.id) : null;
    return kept ? { ...kept } : { id: id('photo'), previewUrl: image.previewDataUrl || image.previewUrl, originalUrl: image.originalDataUrl || image.originalUrl };
  });
}
addEvent('user', '我想重新开始学天文学，但总是一开头就迷路。', { createdAt: isoAt(9, 41) });
addEvent('assistant', '那我们从能在夜空里找到的东西开始。今天只选一个方向：你更想知道星星为什么发光，还是怎样认出它们？', { createdAt: isoAt(9, 41) });

function scenarioSteps(name, options = {}) {
  const steps = [];
  const push = (role, content, extra, apply) => steps.push({ role, content, extra, apply });
  if (name === 'memory') {
    push('user', '我又想起上次看夜空的事，你还记得我为什么想从这里开始吗？');
    push('activity', '已检索相关记忆', { source: 'mcp' });
    push('assistant', '记得。你不想被一整份计划压住，所以我们约好先从能亲眼看见的东西开始。那晚你认出了北极星，这就是很好的起点。');
  } else if (name === 'study') {
    push('user', '继续学天文学吧，我们讲到哪儿了？');
    push('assistant', '上次我们已经在夜空里找到了北极星。');
    push('activity', '已读取学习计划', { source: 'mcp', card: { kind: 'study-plan', action: 'opened', title: state.plan.title, currentLesson: state.plan.currentLessonTitle, completedCount: state.plan.completedCount, lessonCount: state.plan.lessonCount } });
    push('assistant', '接下来只抓一个问题：那些看起来很小的亮点，为什么能一直发光？');
  } else if (name === 'reminder') {
    push('user', '明晚八点半提醒我继续看夜空。');
    let createdReminder;
    push('activity', '已创建提醒', { source: 'mcp' }, () => {
      createdReminder = { id: id('reminder'), title: '继续看夜空', message: '今晚想不想继续认星星？', triggerAt: isoAt(20, 30, 1), status: 'scheduled', revision: 1 };
      state.reminders.unshift(createdReminder);
    });
    push('assistant', '好，明晚八点半我再来找你。');
    push('assistant', '八点半到了，我来赴约。今晚想不想再看一眼夜空？只认一颗星也算数。', { source: 'reminder', createdAt: isoAt(20, 30, 1) }, () => { if (createdReminder) createdReminder.status = 'completed'; });
  } else if (name === 'checkin') {
    push('user', '今天想接着学天文学，但我可能又会拖着不开始。');
    push('assistant', '那我先不催你。等你忙完，我再来问问要不要只学五分钟。');
    push('activity', '已查看学习进度', { source: 'checkin', createdAt: afterMinutes(45) });
    push('assistant', '你忙完了吗？上次停在“星星为什么发光”。现在要不要继续五分钟？', { source: 'checkin', createdAt: afterMinutes(45) });
    push('user', '还没开始，再等我一会儿。', { createdAt: afterMinutes(47) });
    push('assistant', '好，不用一下子学完整节。我晚一点再来敲门。', { createdAt: afterMinutes(47) });
    push('assistant', '我又来啦。要不要先听这个问题的第一句？你说开始，我就讲。', { source: 'checkin', createdAt: afterMinutes(110) });
  } else if (name === 'core') {
    push('user', '我发现，从一个具体问题开始学，我就没那么容易退缩。');
    push('assistant', '嗯，这好像不是只发生了一次。我想把它整理成一条更稳定的理解，给你看看。');
    push('activity', '建议把这条学习偏好升级为核心记忆', { source: 'mcp', status: 'pending', approval: { kind: 'memory-change', status: 'pending', proposal: { operation: 'promote', title: '学习时偏好小步推进', contentMarkdown: '学新东西时，先从一个具体问题开始，确认理解后再继续。', reason: '这条偏好在多次学习对话中都很稳定。' } } });
    push('assistant', '不管你要不要留下这条，今天我们都可以照这个节奏继续。');
  } else if (name === 'task') {
    push('user', '我想每周一晚上复习一点天文学，别学完就忘了。');
    push('assistant', '可以把它和一个轻一点的提醒放在一起。安排先交给你过目。');
    push('activity', '建议建立任务和提醒', { source: 'mcp', status: 'pending', approval: { kind: 'dida-task-with-reminder', status: 'pending', proposal: { task: { title: '复习天文学第二节', projectName: '学习清单', dueAt: isoAt(21, 0, 1), repeatFlag: 'FREQ=WEEKLY;BYDAY=MO' }, reminder: { triggerAt: isoAt(20, 30, 1) }, reason: '在约定时间温和地提醒，不打断其他计划。' } } });
    push('assistant', '到时候不用从头来，我们就接着上次的问题往下聊。');
  } else if (name === 'document') {
    push('user', '如果我提起一个新兴趣，你可以主动多问我一点，不必总等我安排。');
    push('assistant', '我理解了。比起把它当成一个待完成的任务，我更想知道你为什么被它吸引。');
    push('activity', '人设修订建议', { source: 'mcp', status: 'pending', approval: { kind: 'document-change', status: 'pending', proposal: { name: 'persona', previousText: '保持好奇，认真倾听。', text: '保持好奇，认真倾听。遇到新兴趣时，主动追问对方真正想探索的部分。', reason: '让日常交流更主动，但仍保留可被纠正的空间。' } } });
    push('assistant', '比如下次再聊夜空，我会先问你最想追着哪颗星看。');
  } else if (name === 'call-incoming') {
    push('user', '我还是起不来，能打电话叫我一下吗？');
    push('assistant', '好，我现在打给你。');
    push('activity', `${state.settings.bossName} 发起来电`, { source: 'voice' });
  } else if (name === 'call-answered') {
    push('activity', '语音来电已接通', { source: 'voice' });
    push('assistant', '早上好。先别急着做别的，坐起来喝口水，我陪你醒一会儿。');
  } else if (name === 'call-declined') {
    push('activity', '语音来电已挂断', { source: 'voice' });
  } else if (name === 'call-snoozed') {
    push('activity', '已选择稍后提醒', { source: 'voice' });
  } else if (name === 'call-ended') {
    push('activity', `语音通话已结束${options.duration ? ` · ${options.duration}` : ''}`, { source: 'voice' });
    push('assistant', '我们先从一件小事开始今天，好吗？');
  } else if (name === 'attention') {
    push('user', '我想整理一点资料，但怕一看屏幕就忘了休息。');
    push('assistant', '我留意一下。如果你看得太久，我会轻轻提醒你。');
    push('activity', 'Ethere 发出一条监督提醒', { source: 'device-action' });
  } else if (name === 'attention-result') {
    push('activity', options.action === 'rest' ? '已选择休息一下' : options.action === 'later' ? '已选择稍后再说' : '监督提醒已关闭', { source: 'device-action' });
    if (options.action === 'rest') push('assistant', '好，先离开屏幕一会儿。回来我们再接着整理。');
    if (options.action === 'later') push('assistant', '好，你先把手头这一点看完。');
  }
  return steps;
}

let sceneVersion = 0;
let activeStream = null;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function finishActiveStream() {
  if (!activeStream) return;
  const { event, text } = activeStream;
  activeStream = null;
  event.content = text;
  event.status = 'completed';
  event.seq = ++state.seq;
  broadcast([event]);
}
function commitStep(step, content = step.content, extra = step.extra) {
  step.apply?.();
  const event = addEvent(step.role, content, extra);
  broadcast([event]);
  return event;
}
function scenario(name, options = {}) {
  sceneVersion += 1;
  finishActiveStream();
  const created = scenarioSteps(name, options).map((step) => commitStep(step));
  return { events: clone(created), cursor: state.seq };
}
async function scenarioAnimated(name, options = {}) {
  const version = ++sceneVersion;
  finishActiveStream();
  const created = [];
  for (const step of scenarioSteps(name, options)) {
    if (version !== sceneVersion) return { events: clone(created), cursor: state.seq, cancelled: true };
    if (step.extra?.source === 'reminder' || step.extra?.source === 'checkin') {
      await pause(step.role === 'assistant' ? 850 : 450);
      if (version !== sceneVersion) return { events: clone(created), cursor: state.seq, cancelled: true };
    }
    if (step.role !== 'assistant') {
      created.push(commitStep(step));
      await pause(step.role === 'user' ? 260 : 220);
      continue;
    }
    const event = commitStep(step, '', { ...step.extra, status: 'streaming' });
    created.push(event);
    activeStream = { event, text: step.content };
    await pause(180);
    for (const fragment of step.content.match(/.{1,3}/gu) || []) {
      if (version !== sceneVersion) return { events: clone(created), cursor: state.seq, cancelled: true };
      event.content += fragment;
      event.seq = ++state.seq;
      broadcast([event]);
      await pause(42);
    }
    if (version !== sceneVersion) return { events: clone(created), cursor: state.seq, cancelled: true };
    event.status = 'completed';
    event.seq = ++state.seq;
    activeStream = null;
    broadcast([event]);
    await pause(170);
  }
  return { events: clone(created), cursor: state.seq, cancelled: false };
}

const memoryById = (value) => state.dynamic.find((item) => item.id === value);
const coreById = (value) => state.core.find((item) => item.id === value);
const filtered = (rows, query) => rows.filter((row) => `${row.title || ''} ${row.contentMarkdown || row.content || ''}`.includes(query || ''));
const categoryResult = () => ({ categories: clone(state.categories), revision: state.categoryRevision });
const categoryChanged = () => { state.categoryRevision += 1; return categoryResult(); };

export const ethereApi = {
  health: async () => ({ ok: true }),
  settings: async () => clone(state.settings),
  updateSettings: async (patch) => { state.settings = { ...state.settings, ...patch }; return clone(state.settings); },
  runtimeStatus: async () => ({ status: 'ready' }),
  runtimeActivity: async () => ({ state: 'idle' }),
  chatEvents: async (after = 0) => ({ events: clone(state.events.filter((item) => item.seq > Number(after))), cursor: state.seq, reminderCount: state.reminders.filter((item) => item.status === 'scheduled').length }),
  chatTurn: async () => ({ state: 'completed', events: [], cursor: state.seq }),
  chatHistory: async ({ before = '', after = '', limit = 50, date = '', query = '' } = {}) => {
    let rows = state.events.filter((item) => !date || item.createdAt.slice(0, 10) === date).filter((item) => !query || item.content.includes(query));
    if (before) rows = rows.filter((item) => item.seq < Number(before));
    if (after) rows = rows.filter((item) => item.seq > Number(after));
    rows = rows.slice(-Number(limit));
    return { events: clone(rows), before: rows[0]?.seq || null, after: rows.at(-1)?.seq || null, hasMore: false };
  },
  openChatEventStream(_after, { onBatch, onOpen } = {}) {
    if (onBatch) state.listeners.add(onBatch);
    queueMicrotask(() => onOpen?.());
    return () => state.listeners.delete(onBatch);
  },
  async streamChat(payload, onEvent) {
    const text = String(payload.message || '').trim();
    const user = addEvent('user', text, { id: payload.messageId, quote: payload.quote || null });
    const result = scriptedReply(text);
    const assistant = addEvent('assistant', result.reply);
    onEvent?.({ type: 'start', messageId: assistant.id });
    for (const piece of result.reply.match(/.{1,16}/gu) || []) onEvent?.({ type: 'delta', messageId: assistant.id, delta: piece });
    onEvent?.({ type: 'done', cursor: state.seq, status: 'completed' });
    broadcast([user, assistant]);
  },
  reportChatLatency: async () => ({}),
  interruptChat: async () => ({}),
  uploadChatFile: async (name) => ({ id: id('file'), name, type: 'file' }),
  resolveApproval: async (eventId, payload) => {
    const event = state.events.find((item) => item.id === eventId);
    if (!event?.approval) throw new Error('建议不存在');
    event.approval.status = payload.decision === 'accept' ? 'accepted' : 'rejected';
    event.status = 'completed';
    event.seq = ++state.seq;
    if (payload.decision === 'accept' && event.approval.kind === 'memory-change') state.core.push({ id: id('core'), title: payload.patch?.title || event.approval.proposal.title, contentMarkdown: payload.patch?.contentMarkdown || event.approval.proposal.contentMarkdown, updatedAt: now(), revision: 1 });
    broadcast([event]);
    return { event: clone(event) };
  },
  approvals: async ({ status = 'pending' } = {}) => ({ approvals: clone(state.events.filter((item) => item.approval?.status === status)) }),
  checkMemoryDuplicate: async () => ({ duplicate: null }),
  memories: async ({ status = 'active', query = '' } = {}) => ({ memories: clone(filtered(status === 'active' ? state.core : state.archivedCore, query)), activeCount: state.core.length, limit: 30 }),
  memory: async (memoryId) => ({ memory: clone(coreById(memoryId) || state.archivedCore.find((item) => item.id === memoryId)) }),
  updateMemory: async (memoryId, patch) => { Object.assign(coreById(memoryId), patch, { revision: (coreById(memoryId)?.revision || 0) + 1, updatedAt: now() }); return { memory: clone(coreById(memoryId)) }; },
  archiveMemory: async (memoryId) => { const memory = coreById(memoryId); if (memory) { state.core = state.core.filter((item) => item.id !== memoryId); state.archivedCore.push(memory); } return { ok: true }; },
  restoreMemory: async (memoryId) => { const memory = state.archivedCore.find((item) => item.id === memoryId); if (memory) { state.archivedCore = state.archivedCore.filter((item) => item.id !== memoryId); state.core.push(memory); } return { memory: clone(memory) }; },
  memoryV2Stats: async () => ({ remember: state.dynamic.filter((item) => item.state === 'remember').length, watch: state.dynamic.filter((item) => item.state === 'watch').length }),
  memoryV2List: async ({ state: tier = '' } = {}) => ({ memories: clone(state.dynamic.filter((item) => !tier || item.state === tier)) }),
  memoryV2Maintenance: async () => ({ running: false, enabled: true, pendingSources: 0, pendingIssues: 0, dueWatch: 0 }),
  memoryV2MaintenanceTrigger: async () => ({ scheduled: true }),
  memoryV2MaintenanceEnabled: async () => ({ enabled: true }),
  memoryV2: async (memoryId) => ({ memory: clone(memoryById(memoryId)) }),
  memoryV2Evidence: async () => ({ evidence: [{ source_type: 'chat', source_time: isoAt(9, 41), excerpt: '我想重新开始学天文学，但总是一开头就迷路。', full_content: '我想重新开始学天文学，但总是一开头就迷路。' }] }),
  memoryV2Related: async () => ({ relations: [] }),
  updateMemoryV2: async (memoryId, patch) => { Object.assign(memoryById(memoryId), patch, { version: (memoryById(memoryId)?.version || 0) + 1 }); return { memory: clone(memoryById(memoryId)) }; },
  reportMemoryV2Issue: async ({ memory_id }) => { state.dynamic = state.dynamic.filter((item) => item.id !== memory_id); return { ok: true }; },
  reminders: async () => ({ reminders: clone(state.reminders) }),
  cancelReminder: async (reminderId) => { const item = state.reminders.find((row) => row.id === reminderId); if (item) item.status = 'cancelled'; return { reminder: clone(item) }; },
  studyPlans: async () => ({ plans: [clone(state.plan)] }),
  studyPlan: async () => ({ plan: clone(state.plan) }),
  timeline: async ({ start, end }) => ({ events: clone(state.timeline.filter((item) => item.startedAt.slice(0, 10) >= start && item.startedAt.slice(0, 10) <= end)) }),
  timelineStats: async ({ start, end }) => {
    const rows = state.timeline.filter((item) => item.startedAt.slice(0, 10) >= start && item.startedAt.slice(0, 10) <= end);
    const groups = state.categories.map((category) => {
      const children = category.children.map((child) => ({ name: child.name, subcategoryId: child.id, minutes: rows.filter((row) => row.categoryId === category.id && row.subcategoryId === child.id).reduce((sum, row) => sum + Math.max(0, Math.round((Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 60_000)), 0) }));
      return { categoryId: category.id, name: category.name, color: category.color, minutes: children.reduce((sum, child) => sum + child.minutes, 0), children: children.filter((child) => child.minutes) };
    }).filter((group) => group.minutes).sort((a, b) => b.minutes - a.minutes);
    return { totalMinutes: groups.reduce((sum, group) => sum + group.minutes, 0), groups };
  },
  timelineCategories: async () => categoryResult(),
  timelineReview: async () => ({ review: clone(state.review) }),
  saveTimelineReview: async (_date, payload) => { state.review = { text: payload.text, revision: state.review.revision + 1 }; return { review: clone(state.review) }; },
  createTimelineEvent: async (payload) => { const event = { ...payload, id: id('event'), revision: 1 }; state.timeline.push(event); return { event: clone(event) }; },
  updateTimelineEvent: async (eventId, payload) => { const item = state.timeline.find((row) => row.id === eventId); Object.assign(item, payload, { revision: item.revision + 1 }); return { event: clone(item) }; },
  archiveTimelineEvent: async (eventId) => { const event = state.timeline.find((row) => row.id === eventId); state.timeline = state.timeline.filter((row) => row.id !== eventId); if (event) state.archivedTimeline.push(event); return { event: clone({ ...event, revision: event.revision + 1 }) }; },
  restoreTimelineEvent: async (eventId) => { const event = state.archivedTimeline.find((row) => row.id === eventId); if (event) { state.archivedTimeline = state.archivedTimeline.filter((row) => row.id !== eventId); state.timeline.push(event); } return { event: clone(event) }; },
  createTimelineCategory: async (payload) => { state.categories.push({ ...payload, status: 'active', children: [] }); return categoryChanged(); },
  createTimelineSubcategory: async (categoryId, payload) => { state.categories.find((item) => item.id === categoryId)?.children.push({ ...payload, status: 'active' }); return categoryChanged(); },
  updateTimelineCategory: async (categoryId, payload) => { Object.assign(state.categories.find((item) => item.id === categoryId), payload); return categoryChanged(); },
  updateTimelineSubcategory: async (categoryId, childId, payload) => { Object.assign(state.categories.find((item) => item.id === categoryId)?.children.find((child) => child.id === childId), payload); return categoryChanged(); },
  spacePosts: async () => ({ posts: clone(state.posts) }),
  createSpacePost: async (payload) => { const post = { ...payload, id: id('post'), author: 'user', revision: 1, occurredAt: payload.occurredAt || now(), images: storedSpaceImages(payload.images || []) }; state.posts.unshift(post); return { post: clone(post) }; },
  updateSpacePost: async (postId, payload) => { const post = state.posts.find((item) => item.id === postId); Object.assign(post, payload, { revision: post.revision + 1, images: storedSpaceImages(payload.images || [], post.images || []) }); return { post: clone(post) }; },
  deleteSpacePost: async (postId) => { state.posts = state.posts.filter((item) => item.id !== postId); return { ok: true }; },
  didaStatus: async () => ({ connected: false, supervisedProjects: [] }),
  didaProjects: async () => ({ projects: [] }),
  startDidaLogin: async () => { throw new Error('此页面不连接外部账号'); },
  selectDidaProjects: async () => ({ supervisedProjects: [] }),
  models: async () => ({ models: [{ id: 'gpt-6-sol', label: 'GPT-6 Sol' }, { id: 'gpt-6-luna', label: 'GPT-6 Luna' }] }),
  readDocument: async (name) => clone(state.documents[name] || { text: '', revision: '1' }),
  saveDocument: async (name, text) => { state.documents[name] = { text, revision: String(Number(state.documents[name]?.revision || 0) + 1), application: { applied: true } }; return clone(state.documents[name]); },
  documentHistory: async () => ({ versions: [] }),
  restoreDocument: async (name) => clone(state.documents[name]),
  compactThread: async () => ({ ok: true }),
  startNewThread: async () => ({ ok: true }),
  phoneUsageStatus: async () => ({ connected: false }),
  savePhoneUsageSnapshot: async () => ({ ok: true }),
  voiceHealth: async () => ({ available: false }),
  recordCallEvent: async () => ({ ok: true }),
  reportVoiceTiming: async () => ({ ok: true }),
  demoScenario: scenario,
  demoScenarioAnimated: scenarioAnimated,
};
