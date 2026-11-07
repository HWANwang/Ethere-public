import { createChatStore } from './chat-store.js';
import { clearUnreadThroughLatest, unreadSince } from './chat-unread.js';
import { ethereApi } from './companion-api.js';
import { renderSettingsShell, renderSpaceShell, renderTimelineShell } from './companion-views.js';
import { matchesSpacePost } from './space-filter.js';
import { markdownMarkup } from './markdown.js';
import { createMemoryUi } from './memory-ui.js';
import { sortRemindersForDisplay } from './reminder-sort.js';
import { appendSharedText, sharedFileKind } from './shared-content.js';
import { createVoiceCall } from './voice-call.js';
import { saveChatPhotoOriginal, loadChatPhotoOriginal, removeChatPhotoOriginal } from './chat-photo-store.js';
import { createDivinationSheet } from './divination-sheet.js';

const VOICE_OPTIONS = [
  { id: '3581b26bce1840f4a70dd0269946120c', label: '默认音色' },
  { id: '341cfd4c96c04c14a93cfef439e02714', label: '青年' },
  { id: '1bba004267fc49dd9c1192ba36195cd8', label: '少年' },
  { id: '74b14e03c1a64fbdb50a2377afd79042', label: '自然' },
];
const DEFAULT_VOICE_ID = VOICE_OPTIONS[0].id;
const voiceLabel = (id) => VOICE_OPTIONS.find((voice) => voice.id === id)?.label || VOICE_OPTIONS[0].label;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const storage = window.localStorage;
const nativePermissions = window.Capacitor?.Plugins?.EtherePermissions || window.EthereAndroidPermissions || null;
const nativeAndroidViewport = window.Capacitor?.getPlatform?.() === 'android';
if (nativeAndroidViewport) document.documentElement.dataset.nativeAndroid = 'true';
const chatStore = createChatStore(storage);
const panels = $$('[data-view-panel]');
const shell = $('[data-app-shell]');
const list = $('[data-message-list]');
const jumpLatestButton = $('[data-jump-latest]');
const form = $('[data-composer]');
const input = $('[data-message-input]');
const sendButton = $('[data-send]');
const typing = $('[data-typing]');
const imageInput = $('[data-image-input]');
const fileInput = $('[data-file-input]');
const attachmentActions = $('[data-attachment-actions]');
const attachmentPreview = $('[data-attachment-preview]');
const quotePreview = $('[data-quote-preview]');
const quoteAction = $('[data-quote-action]');
const pageTitle = $('[data-page-title]');
const backButton = $('[data-back]');
const spaceButton = $('[data-open-space]');
const settingsButton = $('[data-open-settings]');
const timelineButton = $('[data-open-timeline]');
const spaceAddButton = $('[data-space-add]');
const categoriesButton = $('[data-open-categories]');
const toast = $('[data-toast]');
const FILE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M8 13h8M8 17h8"/></svg>';

$('[data-view-panel="timeline"]').innerHTML = renderTimelineShell();
$('[data-view-panel="space"]').innerHTML = renderSpaceShell();
$('[data-view-panel="settings"]').innerHTML = renderSettingsShell();

createMemoryUi({ api: ethereApi, showToast, enterSubpage, leaveSubpage });

let messages = chatStore.read();
const enteringMessageIds = new Set();
// v2 could retain a fully read, tall message forever. Rebase once on the last
// synced event cursor; events arriving after that cursor remain unread.
const UNREAD_STATE_KEY = 'ethere.unread-state.v3';
const unreadState = readJson(UNREAD_STATE_KEY, null);
const unreadMessageIds = new Set(Array.isArray(unreadState?.ids) ? unreadState.ids : []);
let unreadBaselineCursor = Math.max(0, Number(unreadState?.baselineCursor) || 0);
let unreadTrackingNeedsBaseline = unreadState === null;
const activeTextStreams = new Set();
let pendingUnreadReveal = true;
let readGestureStart = null;
let readGestureUntil = 0;
let lastChatScrollTop = 0;
let unreadAtChatExit = new Set(unreadMessageIds);
let unreadAtBackground = new Set(unreadMessageIds);
let currentTurnWasBackgrounded = false;
let chatLayoutReady = false;
let forceLatestScroll = false;
let currentView = 'chat';
let connected = false;
let pendingAttachments = [];
let quoteDraft = null;
let quoteCandidate = null;
let quotePressTimer = 0;
let quotePressStart = null;
let chatCursor = Math.max(0, Number(storage.getItem('ethere.chat-cursor')) || 0);
let notificationCursor = Math.max(chatCursor, Number(storage.getItem('ethere.notification-cursor')) || 0);
let nativeNotificationStream = false;
let sharedContentLoading = false;
let sharedContentPending = false;
let closeChatEventStream = null;
let currentChatRequest = null;
let chatSendLoopRunning = false;
let voiceCallController = null;
let divinationSheetController = null;
const pendingChatSends = [];
let pendingSpaceImages = [];
let spaceImagesPreparing = false;
let spaceEditorSession = 0;
let spacePosts = [];
let editingSpacePost = null;
let spaceActionPost = null;
let toastTimer = 0;
let bossName = storage.getItem('ethere.boss-name')?.trim() || 'Ethere';
let activeRange = 'day';
let timelineDate = new Date();
let customRangeStart = new Date();
let customRangeEnd = new Date();
let pickerMonth = new Date(timelineDate.getFullYear(), timelineDate.getMonth(), 1);
let pickerMode = 'day';
let pendingPeriodDate = new Date(timelineDate);
let pendingCustomStart = null;
let pendingCustomEnd = null;
let customPickerStep = 'start';
let spaceCustomStart = null;
let spaceCustomEnd = null;
let spacePendingStart = null;
let spacePendingEnd = null;
let spaceCustomStep = 'start';
let spacePickerMonth = new Date(timelineDate.getFullYear(), timelineDate.getMonth(), 1);
let historyEvents = [];
let historyBefore = null;
let historyAfter = null;
let historyHasMore = false;
let historyDate = '';
let historySearch = '';
let historyPickerMonth = new Date();
let historySearchTimer = 0;
let timelineEvents = [];
let timelineStats = { totalMinutes: 0, groups: [] };
let timelineCategories = [];
let timelineCategoryRevision = 0;
let timelineReview = null;
let timelineLoadToken = 0;
let editingTimelineEvent = null;
let timelineDraftCategoryId = '';
let timelineDraftSubcategoryId = '';
let toastAction = null;
const expandedRankingCategories = new Set();
let dayStatsExpanded = false;
let eventTimeTarget = 'start';
let categoryEditTarget = null;
let categoryEditColor = '#7079D1';
let approvalEditMessageId = '';
let approvalDraft = null;
const CATEGORY_COLORS = [
  '#7079D1', '#5E87D8', '#5A9DB5', '#719C87',
  '#78A86B', '#C0A04D', '#D49A5B', '#D77D62',
  '#D392A8', '#B77AB5', '#8A78C2', '#9398A5',
];
let eventTimeHour = 9;
let eventTimeMinute = 0;
const eventTimeScrollTimers = { hour: 0, minute: 0 };

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function readJson(key, fallback) { try { return JSON.parse(storage.getItem(key)) ?? fallback; } catch { return fallback; } }
function writeJson(key, value) { storage.setItem(key, JSON.stringify(value)); }
function isoDate(date) { const y = date.getFullYear(); const m = String(date.getMonth() + 1).padStart(2, '0'); const d = String(date.getDate()).padStart(2, '0'); return `${y}-${m}-${d}`; }
function dateFromIso(value) { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(date, days) { const next = new Date(date); next.setDate(next.getDate() + days); return next; }
function currentTime() { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }
function eventClock(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(date); }
function twoDigits(value) { return String(value).padStart(2, '0'); }
function formatDate(date) { return `${date.getFullYear()}.${twoDigits(date.getMonth() + 1)}.${twoDigits(date.getDate())}`; }
function formatMonth(date) { return `${date.getFullYear()}.${twoDigits(date.getMonth() + 1)}`; }
function formatDateRange(start, end) { return `${formatDate(start)} — ${formatDate(end)}`; }
function showToast(message, duration = 2200, action = null) { window.clearTimeout(toastTimer); toastAction = action; toast.innerHTML = `<span>${escapeHtml(message)}</span>${action ? `<button type="button" data-toast-action>${escapeHtml(action.label)}</button>` : ''}`; toast.hidden = false; requestAnimationFrame(() => toast.classList.add('is-visible')); toastTimer = window.setTimeout(() => { toast.classList.remove('is-visible'); window.setTimeout(() => { toast.hidden = true; toastAction = null; }, 180); }, duration); }
function mutationId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`; }
function paragraphMarkup(value) { return String(value || '').split(/\n+/).filter((part) => part.trim()).map((part) => `<p>${escapeHtml(part.trim())}</p>`).join(''); }
function beijingDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function shiftDateKey(key, days) { const date = new Date(`${key}T12:00:00+08:00`); date.setUTCDate(date.getUTCDate() + days); return beijingDateKey(date); }
function dayDividerLabel(key) {
  const today = beijingDateKey(new Date());
  if (key === today) return '今天';
  if (key === shiftDateKey(today, -1)) return '昨天';
  const [year, month, day] = key.split('-');
  return `${year}.${month}.${day}`;
}
function messageDateKey(message) { return beijingDateKey(message.occurredAt || ''); }
function quoteMarkup(quote) {
  if (!quote?.text) return '';
  const author = quote.sourceRole === 'user' ? '我' : '助手';
  return `<div class="message-quote" aria-label="引用${author}的消息"><span class="message-quote__text">${escapeHtml(quote.text)}</span></div>`;
}
function renderQuotePreview() {
  quotePreview.hidden = !quoteDraft;
  if (!quoteDraft) return;
  $('[data-quote-text]').textContent = quoteDraft.text;
}
function hideQuoteAction() { quoteAction.hidden = true; quoteCandidate = null; }
function showQuoteAction(message, text, rect) {
  if (!message || !['user', 'assistant'].includes(message.role) || !text?.trim()) return;
  quoteCandidate = { sourceMessageId: message.id, sourceRole: message.role, text: text.trim() };
  const bounds = rect || list.getBoundingClientRect();
  quoteAction.style.left = `${Math.max(48, Math.min(window.innerWidth - 48, bounds.left + bounds.width / 2))}px`;
  quoteAction.style.top = `${Math.max(8, Math.min(window.innerHeight - 56, bounds.top - 48))}px`;
  quoteAction.hidden = false;
}
function selectedQuoteCandidate() {
  const selection = window.getSelection();
  const text = selection?.toString().trim();
  if (!text || selection.isCollapsed || !selection.rangeCount) return null;
  const anchorElement = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode?.parentElement;
  const anchor = anchorElement?.closest('.bubble-content');
  if (!anchor || !anchor.contains(selection.focusNode)) return null;
  const message = messages.find((item) => item.id === anchor.closest('[data-message-id]')?.dataset.messageId);
  if (!message || message.status === 'streaming' || message.status === 'sending' || message.status === 'failed' || message.id === 'welcome') return null;
  return { message, text, rect: selection.getRangeAt(0).getBoundingClientRect() };
}

function approvalMarkup(message) {
  const approval = message.approval;
  if (!approval) return '';
  const proposal = approval.proposal || {};
  if (approval.kind === 'memory-change') {
    const duplicate = ['create', 'promote'].includes(proposal.operation) ? (proposal.duplicateCandidate || message.memoryDuplicateCandidate) : null;
    const operationLabel = proposal.operation === 'update' ? '更新' : proposal.operation === 'promote' ? '升级核心记忆' : duplicate ? '覆盖' : '新增';
    const duplicateHint = duplicate?.title ? `<div class="approval-card__target">将更新“${escapeHtml(duplicate.title)}”</div>` : '';
    const actions = approval.status === 'pending'
      ? `<div class="approval-card__actions"><button type="button" data-approval-accept="${escapeHtml(message.id)}">采用</button><button type="button" data-approval-edit="${escapeHtml(message.id)}">修改</button><button type="button" data-approval-reject="${escapeHtml(message.id)}">暂不</button></div>`
      : `<small>${approval.status === 'accepted' ? '已采用' : '暂未采用'}</small>`;
    return `<article class="approval-card approval-card--memory${duplicate ? ' is-duplicate' : ''}" data-message-id="${escapeHtml(message.id)}"><header><span>记忆建议</span><em>${operationLabel}</em></header><strong>${escapeHtml(proposal.title || '')}</strong>${duplicateHint}<div class="approval-card__memory">${markdownMarkup(proposal.contentMarkdown || '')}</div><p>${escapeHtml(proposal.reason || '')}</p>${actions}</article>`;
  }
  if (approval.kind === 'document-change') {
    const label = proposal.name === 'persona' ? '人设' : '工具使用规则';
    const actions = approval.status === 'pending'
      ? `<div class="approval-card__actions approval-card__actions--two"><button type="button" data-approval-accept="${escapeHtml(message.id)}">采用修改</button><button type="button" data-approval-reject="${escapeHtml(message.id)}">暂不</button></div>`
      : `<small>${approval.status === 'accepted' ? approval.application?.applied ? '已采用并应用' : '已采用 · 当前线程待刷新' : '暂未采用'}</small>`;
    return `<article class="approval-card approval-card--document" data-message-id="${escapeHtml(message.id)}"><header><span>${label}修订</span><em>待确认</em></header><p>${escapeHtml(proposal.reason || '')}</p>${documentDiffMarkup(proposal.previousText || '', proposal.text || '')}${actions}</article>`;
  }
  if (approval.kind === 'dida-task-with-reminder') {
    const task = proposal.task || {};
    const reminder = proposal.reminder || {};
    const state = approval.status;
    const stateLabel = ({ pending: '待审批', 'task-creating': '建任务中', 'task-created': '提醒未建', 'task-uncertain': '需核实', accepted: '已完成', rejected: '暂未采用' })[state] || state;
    const action = state === 'pending'
      ? `<div class="approval-card__actions approval-card__actions--two"><button type="button" data-approval-accept="${escapeHtml(message.id)}">一起创建</button><button type="button" data-approval-reject="${escapeHtml(message.id)}">暂不</button></div>`
      : state === 'task-created'
        ? `<div class="approval-card__actions approval-card__actions--two"><button type="button" data-approval-accept="${escapeHtml(message.id)}">重试关联提醒</button></div>`
        : state === 'task-uncertain'
          ? '<small>请先到滴答核实，不会自动重复建任务</small>'
          : state === 'task-creating'
            ? '<small>处理中；若长时间不变，请到滴答核实</small>'
            : '';
    const detail = reminder.triggerAt ? formatTaskApprovalTime(reminder.triggerAt) : '';
    return `<article class="approval-card approval-card--task-combo" data-message-id="${escapeHtml(message.id)}"><header><span>任务＋提醒</span><em>${escapeHtml(stateLabel)}</em></header><strong>${escapeHtml(task.title || '未命名任务')}</strong><div class="approval-card__combo-row"><span>清单</span><p>${escapeHtml(task.projectName || '监督清单')}${task.dueAt ? ` · 截止 ${escapeHtml(formatTaskApprovalTime(task.dueAt))}` : ''}</p></div>${task.repeatFlag ? `<div class="approval-card__combo-row"><span>任务重复</span><p>${escapeHtml(formatTaskRepeat(task.repeatFlag))}</p></div>` : ''}<div class="approval-card__combo-row"><span>提醒</span><p>${escapeHtml(detail)}${reminder.repeatMinutes ? ` · 每 ${Number(reminder.repeatMinutes)} 分钟复查` : ''}</p></div>${approval.lastError ? `<p class="approval-card__combo-error">${escapeHtml(approval.lastError)}</p>` : ''}${proposal.reason ? `<p class="approval-card__combo-reason">${escapeHtml(proposal.reason)}</p>` : ''}${action}</article>`;
  }
  if (approval.kind === 'dida-task-change') {
    const operationLabel = proposal.operation === 'update' ? '修改' : '新建';
    const title = proposal.title || proposal.taskTitle || '未命名任务';
    const details = [
      proposal.projectName,
      isClearedTaskDate(proposal.startAt) ? '清除开始日期' : proposal.startAt ? `开始 ${formatTaskApprovalTime(proposal.startAt)}` : '',
      isClearedTaskDate(proposal.dueAt) ? '清除截止日期' : proposal.dueAt ? `截止 ${formatTaskApprovalTime(proposal.dueAt)}` : '',
      proposal.priority !== undefined ? `优先级 ${['无', '低', '', '中', '', '高'][Number(proposal.priority)] || '无'}` : '',
      proposal.repeatFlag === null ? '取消重复' : proposal.repeatFlag ? `任务重复 · ${formatTaskRepeat(proposal.repeatFlag)}` : '',
    ].filter(Boolean);
    const actions = approval.status === 'pending'
      ? `<div class="approval-card__actions approval-card__actions--two"><button type="button" data-approval-accept="${escapeHtml(message.id)}">采用</button><button type="button" data-approval-reject="${escapeHtml(message.id)}">暂不</button></div>`
      : `<small>${approval.status === 'accepted' ? '已采用' : '暂未采用'}</small>`;
    return `<article class="approval-card approval-card--task" data-message-id="${escapeHtml(message.id)}"><header><span>滴答任务建议</span><em>${operationLabel}</em></header><strong>${escapeHtml(title)}</strong>${details.length ? `<div class="approval-card__meta">${details.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}${proposal.content ? `<div class="approval-card__task-content">${markdownMarkup(proposal.content)}</div>` : ''}<p>${escapeHtml(proposal.reason || '')}</p>${actions}</article>`;
  }
  if (approval.kind !== 'timeline-category-create') return '';
  const parent = timelineCategories.find((item) => item.id === proposal.parentCategoryId);
  const kind = proposal.level === 'primary' ? '一级分类' : `二级分类${parent ? ` · ${parent.name}` : ''}`;
  const actions = approval.status === 'pending'
    ? `<div class="approval-card__actions"><button type="button" data-approval-accept="${escapeHtml(message.id)}">采用</button><button type="button" data-approval-edit="${escapeHtml(message.id)}">修改</button><button type="button" data-approval-reject="${escapeHtml(message.id)}">暂不</button></div>`
    : `<small>${approval.status === 'accepted' ? '已采用' : '暂未采用'}</small>`;
  return `<article class="approval-card" data-message-id="${escapeHtml(message.id)}"><header><span>事件标签建议</span><em>${escapeHtml(kind)}</em></header><strong>${escapeHtml(proposal.name || '')}</strong><p>${escapeHtml(proposal.reason || '')}</p>${actions}</article>`;
}

function studyCardMarkup(card, messageId) {
  const label = card.action === 'created' ? '已创建' : card.action === 'opened' ? '继续学习' : '已更新';
  const progress = card.lessonCount ? `${card.completedCount}/${card.lessonCount} 节` : '';
  const lesson = card.currentLesson ? `<p>${escapeHtml(card.currentLesson)}</p>` : '';
  return `<article class="study-chat-card" data-message-id="${escapeHtml(messageId)}"><header><span>学习计划</span><small>${label}</small></header><strong>${escapeHtml(card.title)}</strong>${lesson}${progress ? `<footer>${escapeHtml(progress)}</footer>` : ''}</article>`;
}

function documentDiffMarkup(before, after) {
  const oldParts = String(before).trim().split(/\n\s*\n/).filter(Boolean);
  const newParts = String(after).trim().split(/\n\s*\n/).filter(Boolean);
  while (oldParts.length && newParts.length && oldParts[0] === newParts[0]) { oldParts.shift(); newParts.shift(); }
  while (oldParts.length && newParts.length && oldParts.at(-1) === newParts.at(-1)) { oldParts.pop(); newParts.pop(); }
  const changedOld = oldParts.join('\n\n');
  const changedNew = newParts.join('\n\n');
  return `<div class="approval-document-diff"><div><strong>改前</strong><p>${escapeHtml(changedOld || '无')}</p></div><div><strong>改后</strong><p>${escapeHtml(changedNew || '无')}</p></div></div>`;
}

function formatTaskApprovalTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
function formatTaskRepeat(value) {
  const flag = String(value || '');
  const interval = Number(flag.match(/INTERVAL=(\d+)/u)?.[1] || 1);
  if (flag.includes('FREQ=DAILY')) return interval === 1 ? '每天' : `每 ${interval} 天`;
  if (flag.includes('FREQ=WEEKLY')) {
    const days = flag.match(/BYDAY=([A-Z,]+)/u)?.[1]?.split(',').map((day) => ({ MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六', SU: '日' })[day]).filter(Boolean).join('、');
    return `${interval === 1 ? '每周' : `每 ${interval} 周`}${days ? ` · 周${days}` : ''}`;
  }
  if (flag.includes('FREQ=MONTHLY')) return `${interval === 1 ? '每月' : `每 ${interval} 个月`} · ${flag.includes('BYMONTHDAY=-1') ? '最后一天' : `${flag.match(/BYMONTHDAY=(\d+)/u)?.[1] || '?'} 日`}`;
  if (flag.includes('FREQ=YEARLY')) return `${interval === 1 ? '每年' : `每 ${interval} 年`} · ${flag.match(/BYMONTH=(\d+)/u)?.[1] || '?'} 月 ${flag.match(/BYMONTHDAY=(\d+)/u)?.[1] || '?'} 日`;
  return '按滴答规则重复';
}
function isClearedTaskDate(value) {
  return value === null || (typeof value === 'string' && value.startsWith('1970-01-01T') && Date.parse(value) === 0);
}

function syncQuoteWidths() {
  for (const quote of list.querySelectorAll('.message-quote')) {
    const bubble = quote.nextElementSibling;
    if (bubble?.classList.contains('bubble') && bubble.offsetWidth > 0) quote.style.width = `${bubble.offsetWidth}px`;
  }
}

function renderMessages() {
  const followLatest = !chatLayoutReady || list.scrollHeight <= list.clientHeight || isAtLatest();
  const visibleAnchor = followLatest ? null : [...list.querySelectorAll('[data-message-id]')].find((node) => node.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
  const anchorId = visibleAnchor?.dataset.messageId;
  const anchorOffset = visibleAnchor ? visibleAnchor.getBoundingClientRect().top - list.getBoundingClientRect().top : 0;
  let previousDate = '';
  list.innerHTML = messages.map((message) => {
    const dateKey = messageDateKey(message);
    const divider = dateKey && dateKey !== previousDate ? `<div class="message-day-divider"><span>${dayDividerLabel(dateKey)}</span></div>` : '';
    if (dateKey) previousDate = dateKey;
    const entering = enteringMessageIds.has(message.id) ? ' is-entering' : '';
    if (message.role === 'activity' || message.role === 'notice') return `${divider}${message.approval ? approvalMarkup(message) : message.card?.kind === 'study-plan' ? studyCardMarkup(message.card, message.id) : `<article class="message-activity${message.role === 'notice' ? ' message-activity--notice' : ''}${message.status === 'failed' ? ' is-failed' : ''}${entering}" data-message-id="${escapeHtml(message.id)}"><time>${escapeHtml(message.createdAt)}</time><span>${escapeHtml(message.content)}</span></article>`}`;
    const mine = message.role === 'user';
    const attachments = Array.isArray(message.attachments) ? message.attachments : message.attachment ? [message.attachment] : [];
    const images = attachments.filter((attachment) => attachment?.type === 'image' && attachment.dataUrl?.startsWith('data:image/'));
    const image = images.length ? `<div class="message-images">${images.map((attachment, index) => `<button class="message-image-button" type="button" data-chat-photo="${index}" aria-label="放大第 ${index + 1} 张聊天图片"><img class="message-image" src="${escapeHtml(attachment.dataUrl)}" alt=""></button>`).join('')}</div>` : '';
    const files = attachments.filter((attachment) => attachment?.type === 'file');
    const fileMarkup = files.length ? `<div class="message-files">${files.map((file) => `<div class="message-file">${FILE_ICON}<span>${escapeHtml(file.name)}</span></div>`).join('')}</div>` : '';
    const paragraphs = markdownMarkup(message.content);
    const sending = message.status === 'sending' ? '<span>发送中</span>' : '';
    const failed = message.status === 'failed' ? `<button type="button" data-retry-message="${escapeHtml(message.id)}">发送失败 · 重试</button>` : '';
    const interrupted = !mine && message.status === 'interrupted' ? '<span>已被新消息打断</span>' : '';
    const copy = message.content ? `<button class="message-copy" type="button" data-copy-message="${escapeHtml(message.id)}" aria-label="复制消息" title="复制消息"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button>` : '';
    const sourceClass = message.source === 'checkin' ? ' message--checkin' : message.source === 'reminder' ? ' message--reminder' : '';
    return `${divider}<article class="message ${mine ? 'message--mine' : ''}${sourceClass}${entering}" data-role="${message.role}" data-message-id="${escapeHtml(message.id)}"><div class="message__body">${quoteMarkup(message.quote)}<div class="bubble">${image}${fileMarkup}<div class="bubble-content">${paragraphs}</div></div><div class="message__meta"><time class="message__time">${escapeHtml(message.createdAt)}</time>${sending}${failed}${interrupted}${copy}</div></div></article>`;
  }).join('');
  syncQuoteWidths();
  enteringMessageIds.clear();
  requestAnimationFrame(() => {
    chatLayoutReady = true;
    const previousScrollTop = list.scrollTop;
    if (forceLatestScroll || followLatest) list.scrollTop = list.scrollHeight;
    else if (anchorId) {
      const anchor = [...list.querySelectorAll('[data-message-id]')].find((node) => node.dataset.messageId === anchorId);
      if (anchor) list.scrollTop += anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - anchorOffset;
    }
    if (Math.abs(list.scrollTop - previousScrollTop) > 1) lastChatScrollTop = list.scrollTop;
    refreshJumpLatest();
    markVisibleUnread();
  });
}

function isAtLatest() { return list.scrollHeight - list.clientHeight - list.scrollTop < 42; }
function refreshJumpLatest() { jumpLatestButton.hidden = currentView !== 'chat' || isAtLatest(); }
function scrollToLatest({ markRead = false } = {}) {
  forceLatestScroll = true;
  readGestureUntil = 0;
  list.scrollTop = list.scrollHeight;
  lastChatScrollTop = list.scrollTop;
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; lastChatScrollTop = list.scrollTop; forceLatestScroll = false; refreshJumpLatest(); if (markRead && clearUnreadThroughLatest(unreadMessageIds, messages)) saveUnreadMessages(); markVisibleUnread(); });
}
function saveUnreadMessages() { writeJson(UNREAD_STATE_KEY, { ids: [...unreadMessageIds], baselineCursor: unreadBaselineCursor }); }
function isUnreadCandidate(message) { return (message.role === 'assistant' && message.id !== 'welcome') || (message.role === 'activity' && message.approval?.status === 'pending'); }
function markVisibleUnread(passedSinceScrollTop = null) {
  if (pendingUnreadReveal || document.hidden || currentView !== 'chat' || !unreadMessageIds.size) return;
  const viewport = list.getBoundingClientRect();
  let changed = false;
  if (passedSinceScrollTop !== null && isAtLatest()) {
    // 主动滑到末尾就是读完当前已完成的消息；中途重绘也不应留下旧未读锚点。
    changed = clearUnreadThroughLatest(unreadMessageIds, messages);
  }
  for (const node of list.querySelectorAll('[data-message-id]')) {
    const id = node.dataset.messageId;
    if (!unreadMessageIds.has(id)) continue;
    const message = messages.find((item) => item.id === id);
    const rect = node.getBoundingClientRect();
    const passedByReading = passedSinceScrollTop !== null && rect.bottom + list.scrollTop - viewport.top >= passedSinceScrollTop;
    if (!message || message.status === 'streaming' || rect.bottom > viewport.bottom - 2 || (rect.bottom <= viewport.top && !passedByReading)) continue;
    unreadMessageIds.delete(id);
    changed = true;
  }
  if (changed) saveUnreadMessages();
}
function revealFirstUnread(candidates = unreadMessageIds) {
  requestAnimationFrame(() => {
    const first = currentView === 'chat' ? messages.find((message) => candidates.has(message.id) && unreadMessageIds.has(message.id)) : null;
    const node = first && [...list.querySelectorAll('[data-message-id]')].find((item) => item.dataset.messageId === first.id);
    if (node) list.scrollTop += node.getBoundingClientRect().top - list.getBoundingClientRect().top - 8;
    lastChatScrollTop = list.scrollTop;
    readGestureUntil = 0;
    pendingUnreadReveal = false;
    refreshJumpLatest();
    markVisibleUnread();
  });
}
function syncNativeChatVisibility() {
  void nativePermissions?.setChatVisible?.({ visible: currentView === 'chat' && !document.hidden }).catch(() => {});
}
function clearNativeDeliveredNotifications() {
  void nativePermissions?.clearDeliveredNotifications?.().catch(() => {});
}
function openChatFromNotification() {
  void nativePermissions?.consumeOpenChatIntent?.().catch(() => {});
  if (currentView !== 'chat') { setView('chat'); return; }
  pendingUnreadReveal = true;
  void syncChatEvents().catch(() => {}).finally(revealFirstUnread);
}
window.EthereOpenChatFromNotification = openChatFromNotification;

function syncBossName() {
  $$('[data-boss-name]').forEach((node) => { node.textContent = bossName; });
  $('[data-boss-name-input]').value = bossName;
  if (currentView === 'chat') pageTitle.textContent = bossName;
  divinationSheetController?.refresh();
  if (nativePermissions?.updateAssistantName) {
    void nativePermissions.updateAssistantName({ name: bossName }).catch(() => {});
  }
  renderMessages();
}

function setView(view) {
  if (!['chat', 'timeline', 'space', 'settings'].includes(view)) return;
  if (view !== 'chat') divinationSheetController?.close();
  hideQuoteAction();
  const previousView = currentView;
  currentView = view;
  if (previousView === 'chat' && view !== 'chat') {
    if (isAtLatest() && clearUnreadThroughLatest(unreadMessageIds, messages)) saveUnreadMessages();
    unreadAtChatExit = new Set(unreadMessageIds);
    currentTurnWasBackgrounded = true;
    for (const stream of activeTextStreams) { stream.instant = true; stream.flush(); }
  }
  panels.forEach((panel) => { const active = panel.dataset.viewPanel === view; panel.hidden = !active; panel.classList.toggle('is-active', active); });
  if (view === 'chat') requestAnimationFrame(syncQuoteWidths);
  const activePanel = panels.find((panel) => panel.dataset.viewPanel === view);
  if (previousView !== view && activePanel?.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const positions = { space: -1, chat: 0, timeline: 1, settings: 1 };
    const offset = positions[view] > positions[previousView] ? 22 : -22;
    [$('.topbar'), activePanel].forEach((element) => element?.animate([
      { opacity: 0.4, transform: `translate3d(${offset}px,0,0)` },
      { opacity: 1, transform: 'translate3d(0,0,0)' },
    ], { duration: 220, easing: 'cubic-bezier(.22,.8,.32,1)' }));
  }
  const chat = view === 'chat';
  backButton.hidden = chat; spaceButton.hidden = !chat; timelineButton.hidden = !chat;
  spaceAddButton.hidden = view !== 'space' || !$('[data-space-editor]').hidden;
  categoriesButton.hidden = view !== 'timeline';
  settingsButton.disabled = !chat; settingsButton.classList.toggle('identity--plain', !chat);
  $('[data-header-connection]').hidden = !chat;
  pageTitle.textContent = view === 'timeline' ? '时间轴' : view === 'space' ? '空间' : view === 'settings' ? '设置' : bossName;
  shell.dataset.view = view;
  syncNativeChatVisibility();
  if (chat && previousView !== 'chat') {
    pendingUnreadReveal = true;
    void syncChatEvents().catch(() => {}).finally(() => revealFirstUnread(unreadSince(unreadMessageIds, unreadAtChatExit)));
  }
  refreshJumpLatest();
  if (view === 'space') {
    requestAnimationFrame(() => refreshSpaceClamps($('[data-view-panel="space"]')));
    if (connected) void loadSpacePosts();
  }
  if (view === 'settings') {
    void refreshPermissionStatus();
    if (connected) void refreshReminderCount().catch(() => {});
  }
}

function setConnectionState(value) {
  connected = value;
  $$('[data-connection-dot]').forEach((dot) => dot.classList.toggle('is-online', value));
  $$('[data-connection-label]').forEach((label) => { label.textContent = value ? '已连接' : '未连接'; });
}

function resizeComposer() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 112)}px`; sendButton.disabled = !input.value.trim() && !pendingAttachments.length; }
function prepareImage(file, { maxEdge = 1600, quality = .82 } = {}) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = reject; reader.onload = () => { const image = new Image(); image.onerror = reject; image.onload = () => { const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight)); const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale)); const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height); resolve({ type: 'image', name: file.name, dataUrl: canvas.toDataURL('image/jpeg', quality) }); }; image.src = String(reader.result); }; reader.readAsDataURL(file); });
}
async function prepareChatImage(file) {
  const [preview, originalPhotoId] = await Promise.all([
    prepareImage(file),
    saveChatPhotoOriginal(file).catch(() => null),
  ]);
  return { ...preview, originalPhotoId };
}
function renderAttachment() { attachmentPreview.hidden = !pendingAttachments.length; attachmentPreview.innerHTML = pendingAttachments.map((attachment, index) => attachment.type === 'file' ? `<div class="attachment-preview__file">${FILE_ICON}<span>${escapeHtml(attachment.name)}</span><button type="button" data-remove-attachment="${index}" aria-label="移除文件 ${escapeHtml(attachment.name)}">×</button></div>` : `<div class="attachment-preview__item"><button class="attachment-preview__open" type="button" data-chat-draft-photo="${index}" aria-label="放大第 ${index + 1} 张待发送图片"><img src="${escapeHtml(attachment.dataUrl)}" alt=""></button><button type="button" data-remove-attachment="${index}" aria-label="移除第 ${index + 1} 张图片">×</button></div>`).join(''); resizeComposer(); }
function appendMessage(role, content, attachments = [], id = '', extra = {}) { const messageId = id || `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`; if (messages.some((message) => message.id === messageId)) return messageId; const occurredAt = new Date().toISOString(); const message = { id: messageId, role, content, createdAt: eventClock(occurredAt), occurredAt, attachments, ...extra }; messages = chatStore.append(message, messages); if (isUnreadCandidate(message)) { unreadMessageIds.add(messageId); saveUnreadMessages(); } if (currentView === 'chat' && !document.hidden) enteringMessageIds.add(messageId); renderMessages(); return messageId; }
function patchMessage(id, patch) { messages = messages.map((message) => message.id === id ? { ...message, ...patch } : message); chatStore.write(messages); renderMessages(); }
function updateMessage(id, content) {
  const message = messages.find((item) => item.id === id);
  if (!message || message.status === 'completed' || message.status === 'interrupted') return;
  message.content = content;
  const node = [...list.querySelectorAll('[data-message-id]')].find((item) => item.dataset.messageId === id);
  const contentNode = node?.querySelector('.bubble-content');
  if (!contentNode) { chatStore.write(messages); renderMessages(); return; }
  const followLatest = forceLatestScroll || isAtLatest();
  contentNode.innerHTML = markdownMarkup(content);
  if (followLatest) list.scrollTop = list.scrollHeight;
  refreshJumpLatest();
}

function storeChatCursor(cursor) { chatCursor = Math.max(chatCursor, Number(cursor) || 0); storage.setItem('ethere.chat-cursor', String(chatCursor)); }
function storeNotificationCursor(cursor) { notificationCursor = Math.max(notificationCursor, Number(cursor) || 0); storage.setItem('ethere.notification-cursor', String(notificationCursor)); }
function nativeStatusValue(value) { return typeof value === 'string' ? value : value?.status || 'unavailable'; }
async function showNativeNotification(event) {
  const memoryNotice = event.role === 'notice' && event.source === 'memory';
  if (!nativePermissions?.showNotification || !document.hidden) return;
  if (!memoryNotice && (event.role !== 'assistant'
    || !(['checkin', 'reminder', 'space'].includes(event.source) || event.source === 'chat' && event.turnComplete))) return;
  try {
    await nativePermissions.showNotification({
      id: Math.max(1, Number(event.seq) || Date.now() % 2_000_000_000),
      eventCursor: Math.max(0, Number(event.seq) || 0),
      messageId: String(event.id || ''),
      title: memoryNotice ? '记忆已更新' : event.source === 'space' ? '空间有了新回复' : event.source === 'reminder' ? '提醒' : bossName,
      body: String(event.content || '').slice(0, 2_000),
    });
  } catch { /* 未授权时仍保留聊天事件。 */ }
}
async function startNativeNotificationStream() {
  const start = nativePermissions?.startNotificationStream || nativePermissions?.startNotificationPolling;
  if (!start) return;
  try {
    await start.call(nativePermissions, { after: chatCursor, serverUrl: window.location.origin });
    nativeNotificationStream = true;
  } catch { nativeNotificationStream = false; }
}
function eventTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? currentTime() : eventClock(date); }
async function syncChatEvents() {
  const result = await ethereApi.chatEvents(chatCursor);
  await applyChatEventBatch(result);
}
async function reconcileChatTurn(messageId) {
  const turn = await ethereApi.chatTurn(messageId);
  if (turn.state === 'completed') await applyChatEventBatch(turn);
  return turn.state;
}
async function reconcileUnfinishedMessages() {
  if (currentChatRequest) return;
  for (const message of messages.filter((item) => item.role === 'user' && item.status === 'sending')) {
    try {
      const state = await reconcileChatTurn(message.id);
      if (state === 'missing' || state === 'accepted') patchMessage(message.id, { status: 'failed' });
    } catch { break; }
  }
}
async function applyChatEventBatch(result) {
  if (Number.isInteger(result.reminderCount)) {
    setReminderCount(result.reminderCount);
    if (!$('[data-reminder-manager]').hidden) void loadReminders({ showLoading: false });
  }
  if (!(result.events || []).length && !result.reset) return;
  if (unreadTrackingNeedsBaseline) {
    unreadBaselineCursor = chatCursor;
    if (!unreadBaselineCursor) {
      const latest = await ethereApi.chatHistory({ limit: 1 }).catch(() => null);
      unreadBaselineCursor = Math.max(Number(latest?.events?.at(-1)?.seq) || 0, Number(result.cursor) || 0);
    }
    unreadTrackingNeedsBaseline = false;
    saveUnreadMessages();
  }
  if (result.reset) {
    chatCursor = 0;
    storage.setItem('ethere.chat-cursor', '0');
    unreadMessageIds.clear();
    unreadBaselineCursor = 0;
    saveUnreadMessages();
  }
  let changed = false;
  let unreadChanged = false;
  let spaceChanged = false;
  let timelineChanged = false;
  for (const event of result.events || []) {
    if (event.role === 'notice' && event.source === 'device-action' && (event.id?.startsWith('device-action-result-') || !event.content)) {
      storeNotificationCursor(event.seq);
      storeChatCursor(event.seq);
      continue;
    }
    const shouldNotify = Number(event.seq) > notificationCursor;
    const existing = messages.find((message) => message.id === event.id);
    if (existing) {
      if (!existing.occurredAt && event.createdAt) { existing.occurredAt = event.createdAt; existing.createdAt = eventTime(event.createdAt); changed = true; }
      if (['assistant', 'activity'].includes(event.role) && event.content && existing.content !== event.content) { existing.content = event.content; changed = true; }
      if (['assistant', 'activity'].includes(event.role) && (existing.status !== event.status || existing.source !== event.source)) { existing.status = event.status; existing.source = event.source; changed = true; }
      if (event.role === 'activity' && JSON.stringify(existing.approval || null) !== JSON.stringify(event.approval || null)) {
        if (Number(event.seq) > unreadBaselineCursor && event.approval?.status === 'pending' && !existing.approval) { unreadMessageIds.add(event.id); unreadChanged = true; }
        existing.approval = event.approval || null; changed = true;
      }
      if (event.role === 'activity' && JSON.stringify(existing.card || null) !== JSON.stringify(event.card || null)) { existing.card = event.card || null; changed = true; }
      if (event.role === 'user' && existing.status !== 'completed') { existing.status = 'completed'; changed = true; }
      if (event.role === 'user' && JSON.stringify(existing.quote || null) !== JSON.stringify(event.quote || null)) { existing.quote = event.quote || null; changed = true; }
    } else {
      const message = { id: event.id, role: event.role, content: event.content, createdAt: eventTime(event.createdAt), occurredAt: event.createdAt, attachments: event.files?.map((file) => ({ ...file, type: 'file' })) || [], status: event.status, source: event.source, approval: event.approval || null, card: event.card || null, quote: event.quote || null };
      messages.push(message);
      if (Number(event.seq) > unreadBaselineCursor && isUnreadCandidate(message)) { unreadMessageIds.add(event.id); unreadChanged = true; }
      if (currentView === 'chat' && !document.hidden && !pendingUnreadReveal) enteringMessageIds.add(event.id);
      changed = true;
    }
    if (event.role === 'activity' && ['已写入空间', '已更新空间动态'].includes(event.content)) spaceChanged = true;
    if (event.role === 'activity' && isTimelineWriteActivity(event.content)) timelineChanged = true;
    if (shouldNotify && (event.role !== 'notice' || event.source === 'memory')) void showNativeNotification(event);
    storeNotificationCursor(event.seq);
    storeChatCursor(event.seq);
  }
  storeChatCursor(result.cursor);
  if (unreadChanged) saveUnreadMessages();
  if (changed) { chatStore.write(messages); renderMessages(); }
  if (spaceChanged) await loadSpacePosts().catch(() => {});
  if (timelineChanged && currentView === 'timeline') renderTimeline();
  await hydrateMemoryApprovalDuplicates();
}
function startChatEventStream() {
  closeChatEventStream?.();
  closeChatEventStream = ethereApi.openChatEventStream(chatCursor, {
    onOpen: () => setConnectionState(true),
    onBatch: (result) => { void applyChatEventBatch(result).catch(() => {}); },
    // EventSource 会自行重连；低频同步负责发现长时间断连并补齐游标。
    onError: () => {},
  });
}

class SmoothTextStream {
  constructor(messageId, onFirstVisible = null) {
    this.messageId = messageId;
    this.text = '';
    this.queue = '';
    this.timer = 0;
    this.waiters = [];
    this.instant = false;
    this.onFirstVisible = onFirstVisible;
  }
  #markVisible() { if (this.onFirstVisible) { this.onFirstVisible(); this.onFirstVisible = null; } }
  push(value) {
    if (this.instant || document.hidden) { this.text += this.queue + value; this.queue = ''; updateMessage(this.messageId, this.text); this.#markVisible(); return; }
    this.queue += value;
    this.#schedule();
  }
  flush() {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = 0;
    if (this.queue) { this.text += this.queue; this.queue = ''; updateMessage(this.messageId, this.text); this.#markVisible(); }
    this.waiters.splice(0).forEach((resolve) => resolve());
  }
  drain() {
    if (!this.queue && !this.timer) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  #schedule() {
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      const count = Math.max(2, Math.min(20, Math.ceil(this.queue.length / 24)));
      this.text += this.queue.slice(0, count);
      this.queue = this.queue.slice(count);
      updateMessage(this.messageId, this.text);
      this.#markVisible();
      if (this.queue) this.#schedule();
      else this.waiters.splice(0).forEach((resolve) => resolve());
    }, 12);
  }
}

async function hydrateMemoryApprovalDuplicates() {
  const candidates = messages.filter((message) => message.approval?.kind === 'memory-change'
    && message.approval.status === 'pending'
    && message.approval.proposal?.operation === 'create'
    && !message.approval.proposal.duplicateCandidate
    && message.memoryDuplicateChecked !== true);
  if (!candidates.length) return;
  let changed = false;
  await Promise.all(candidates.map(async (message) => {
    const proposal = message.approval.proposal;
    try {
      const result = await ethereApi.checkMemoryDuplicate({ title: proposal.title, contentMarkdown: proposal.contentMarkdown });
      message.memoryDuplicateCandidate = result.duplicate || null;
      message.memoryDuplicateChecked = true;
      changed = true;
    } catch { /* 断线时保留原卡片，下次同步后再检查。 */ }
  }));
  if (changed) { chatStore.write(messages); renderMessages(); }
}

async function hydrateRecentMessageTimes() {
  const missing = new Set(messages.filter((message) => message.id !== 'welcome' && !message.occurredAt).map((message) => message.id));
  if (!missing.size) return;
  const result = await ethereApi.chatHistory({ limit: 200 });
  let changed = false;
  for (const event of result.events || []) {
    if (!missing.has(event.id) || !event.createdAt) continue;
    const message = messages.find((item) => item.id === event.id);
    if (!message) continue;
    message.occurredAt = event.createdAt;
    message.createdAt = eventTime(event.createdAt);
    changed = true;
  }
  if (changed) { chatStore.write(messages); renderMessages(); }
}

function renderChatHistory() {
  const historyList = $('[data-chat-history-list]');
  let previousDate = '';
  historyList.innerHTML = historyEvents.length ? historyEvents.map((event) => {
    const dateKey = beijingDateKey(event.createdAt);
    const divider = dateKey && dateKey !== previousDate ? `<div class="history-day-divider"><span>${dayDividerLabel(dateKey)}</span></div>` : '';
    if (dateKey) previousDate = dateKey;
    const time = eventClock(event.createdAt);
    if (event.role === 'activity' || event.role === 'notice') return `${divider}<article class="history-activity"><time>${escapeHtml(time)}</time><span>${escapeHtml(event.content)}</span></article>`;
    const imageNote = event.imageCount ? `<small>〔${event.imageCount} 张图片〕</small>` : '';
    const copy = event.content ? `<button type="button" data-copy-history="${escapeHtml(event.id)}" aria-label="复制聊天记录"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button>` : '';
    return `${divider}<article class="history-message${event.role === 'user' ? ' history-message--mine' : ''}"><div>${quoteMarkup(event.quote)}${markdownMarkup(event.content)}${imageNote}</div><footer><time>${escapeHtml(time)}</time>${copy}</footer></article>`;
  }).join('') : `<p class="history-empty">${historySearch ? '没有包含这个关键词的聊天记录' : historyDate ? '这一天没有聊天记录' : '还没有聊天记录'}</p>`;
  const moreButton = $('[data-load-older-history]');
  moreButton.hidden = !historyHasMore;
  moreButton.textContent = historyDate ? '加载更多' : '加载更早';
}

async function resolveChatApproval(messageId, decision, patch = null, options = {}) {
  const message = messages.find((item) => item.id === messageId);
  if (!message?.approval || (message.approval.status !== 'pending'
    && !(message.approval.kind === 'dida-task-with-reminder' && message.approval.status === 'task-created' && decision === 'accept'))) return;
  try {
    const result = await ethereApi.resolveApproval(messageId, { decision, ...(patch ? { patch } : {}), ...options }, message.approval.kind === 'memory-change' ? 120_000 : 8000);
    patchMessage(messageId, {
      content: result.event.content,
      status: result.event.status,
      approval: result.event.approval,
    });
    storeChatCursor(result.event.seq);
    if (decision === 'accept' && message.approval.kind === 'timeline-category-create') {
      const taxonomy = await ethereApi.timelineCategories({ includeInactive: true });
      timelineCategories = taxonomy.categories || [];
      timelineCategoryRevision = taxonomy.revision || 0;
      showToast('已新增分类');
    } else if (decision === 'accept' && message.approval.kind === 'dida-task-change') {
      showToast('已写入滴答清单');
    } else if (decision === 'accept' && message.approval.kind === 'dida-task-with-reminder') {
      showToast(result.event.approval?.status === 'accepted' ? '任务和提醒已建立' : '请查看组合审批卡片的结果');
    } else if (decision === 'accept') {
      showToast('已更新记忆');
    }
    return true;
  } catch (error) {
    showToast(error.message || '审批失败');
    return false;
  }
}

function renderApprovalEditSheet() {
  if (!approvalDraft) return;
  $$('[data-approval-level-option]').forEach((button) => button.classList.toggle('is-active', button.dataset.approvalLevelOption === approvalDraft.level));
  $('[data-approval-name]').value = approvalDraft.name || '';
  $('[data-approval-parent-field]').hidden = approvalDraft.level !== 'secondary';
  $('[data-approval-color-field]').hidden = approvalDraft.level !== 'primary';
  const activeParents = timelineCategories.filter((item) => item.status === 'active' && item.id !== 'uncategorized');
  if (approvalDraft.level === 'secondary' && !activeParents.some((item) => item.id === approvalDraft.parentCategoryId)) approvalDraft.parentCategoryId = activeParents[0]?.id || '';
  $('[data-approval-parent-options]').innerHTML = activeParents.map((category) => `<button class="${category.id === approvalDraft.parentCategoryId ? 'is-active' : ''}" type="button" data-approval-parent="${escapeHtml(category.id)}"><i style="--choice-color:${escapeHtml(category.color)}"></i>${escapeHtml(category.name)}</button>`).join('');
  $('[data-approval-color-options]').innerHTML = CATEGORY_COLORS.map((color) => `<button class="${color === approvalDraft.color ? 'is-active' : ''}" type="button" data-approval-color="${color}" style="--choice-color:${color}" aria-label="选择颜色 ${color}"></button>`).join('');
}

async function openApprovalEdit(messageId) {
  const message = messages.find((item) => item.id === messageId);
  if (!message?.approval || message.approval.status !== 'pending') return;
  if (message.approval.kind === 'memory-change') {
    approvalEditMessageId = messageId;
    approvalDraft = { ...message.approval.proposal };
    $('[data-memory-approval-title]').value = approvalDraft.title || '';
    $('[data-memory-approval-content]').value = approvalDraft.contentMarkdown || '';
    let duplicate = approvalDraft.duplicateCandidate || null;
    if (approvalDraft.operation === 'create') {
      try {
        const result = await ethereApi.checkMemoryDuplicate({ title: approvalDraft.title, contentMarkdown: approvalDraft.contentMarkdown });
        duplicate = result.duplicate;
      } catch { /* 保留工具生成建议时附带的检测结果。 */ }
    }
    const separateRow = $('[data-memory-approval-separate-row]');
    separateRow.hidden = approvalDraft.operation !== 'create' || !duplicate;
    $('[data-memory-approval-separate-label]').textContent = duplicate?.title
      ? `检测到与“${duplicate.title}”相似，仍作为新主题保存`
      : '检测到相似记忆，仍作为新主题保存';
    $('[data-memory-approval-separate]').checked = false;
    $('[data-memory-approval-edit-sheet]').hidden = false;
    return;
  }
  try {
    const taxonomy = await ethereApi.timelineCategories({ includeInactive: true });
    timelineCategories = taxonomy.categories || [];
    timelineCategoryRevision = taxonomy.revision || 0;
  } catch (error) {
    return showToast(error.message || '分类读取失败');
  }
  approvalEditMessageId = messageId;
  approvalDraft = { color: '#7079D1', ...message.approval.proposal };
  renderApprovalEditSheet();
  $('[data-approval-edit-sheet]').hidden = false;
}

function closeApprovalEdit() {
  $('[data-approval-edit-sheet]').hidden = true;
  $('[data-memory-approval-edit-sheet]').hidden = true;
  approvalEditMessageId = '';
  approvalDraft = null;
}

async function loadChatHistory({ reset = false } = {}) {
  if (!connected) return showToast('电脑端未连接，无法读取聊天记录');
  const historyList = $('[data-chat-history-list]');
  const moreButton = $('[data-load-older-history]');
  if (reset) {
    historyEvents = [];
    historyBefore = null;
    historyAfter = null;
    historyHasMore = false;
    historyList.innerHTML = '<p class="history-empty">正在读取…</p>';
  }
  moreButton.disabled = true;
  try {
    const result = await ethereApi.chatHistory({
      before: historyDate || reset ? '' : historyBefore,
      after: historyDate && !reset ? historyAfter : '',
      limit: 50,
      date: historyDate,
      query: historySearch,
    });
    const incoming = result.events || [];
    const known = new Set(historyEvents.map((event) => event.id));
    historyEvents = reset ? incoming : historyDate
      ? [...historyEvents, ...incoming.filter((event) => !known.has(event.id))]
      : [...incoming.filter((event) => !known.has(event.id)), ...historyEvents];
    historyBefore = result.before;
    historyAfter = result.after;
    historyHasMore = result.hasMore === true;
    renderChatHistory();
  } catch (error) {
    historyList.innerHTML = '<p class="history-empty">聊天记录读取失败</p>';
    showToast(error.message);
    if (!error.status) setConnectionState(false);
  } finally {
    moreButton.disabled = false;
  }
}

function renderHistoryDatePicker() {
  const selected = historyDate ? dateFromIso(historyDate) : null;
  $('[data-history-date-body]').innerHTML = `${historyDate ? '<div class="picker-utility"><button type="button" data-clear-history-date>清除日期</button></div>' : ''}${calendarMarkup('history', historyPickerMonth, selected, selected)}`;
}

async function runChatSendLoop() {
  if (chatSendLoopRunning) return;
  chatSendLoopRunning = true;
  while (pendingChatSends.length) {
    currentTurnWasBackgrounded = document.hidden;
    const payload = pendingChatSends.shift();
    const timingStartedAt = performance.now();
    const chatTiming = { messageId: payload.messageId, platform: nativeAndroidViewport ? 'android' : 'web', firstResponseMs: null, firstDeltaMs: null, firstVisibleMs: null, doneMs: null, failed: false };
    let replyId = '';
    let reply = '';
    const replyIds = new Set();
    const streams = new Map();
    let finalStatus = 'completed';
    let spaceChanged = false;
    let timelineChanged = false;
    typing.hidden = false;
    try {
      const request = ethereApi.streamChat(payload, (streamEvent) => {
        if (streamEvent.type === 'start') {
          if (chatTiming.firstResponseMs == null) chatTiming.firstResponseMs = Math.round(performance.now() - timingStartedAt);
          replyId = streamEvent.messageId || replyId;
          reply = '';
        }
        if (streamEvent.type === 'segment') {
          replyId = streamEvent.messageId || '';
          reply = '';
        }
        if (streamEvent.type === 'activity' && streamEvent.content) {
          appendMessage('activity', streamEvent.content, [], streamEvent.messageId, {
            status: streamEvent.status || 'completed', source: 'mcp', approval: streamEvent.approval || null, card: streamEvent.card || null,
          });
          if (['已写入空间', '已更新空间动态'].includes(streamEvent.content)) spaceChanged = true;
          if (isTimelineWriteActivity(streamEvent.content)) timelineChanged = true;
        }
        if (streamEvent.type === 'delta' && streamEvent.delta) {
          payload.voiceCallbacks?.onDelta?.(streamEvent.delta);
          if (chatTiming.firstDeltaMs == null) chatTiming.firstDeltaMs = Math.round(performance.now() - timingStartedAt);
          if (!replyId) replyId = appendMessage('assistant', '', [], '', { status: 'streaming' });
          else appendMessage('assistant', '', [], replyId, { status: 'streaming' });
          replyIds.add(replyId);
          if (!streams.has(replyId)) { const stream = new SmoothTextStream(replyId, () => { if (chatTiming.firstVisibleMs == null) chatTiming.firstVisibleMs = Math.round(performance.now() - timingStartedAt); }); stream.instant = currentTurnWasBackgrounded; streams.set(replyId, stream); activeTextStreams.add(stream); }
          streams.get(replyId).push(streamEvent.delta);
        }
        if (streamEvent.type === 'done') {
          chatTiming.doneMs = Math.round(performance.now() - timingStartedAt);
          storeChatCursor(streamEvent.cursor);
          patchMessage(payload.messageId, { status: 'completed' });
          finalStatus = streamEvent.status || 'completed';
        }
      });
      currentChatRequest = request;
      await request;
      await Promise.all([...streams.values()].map((stream) => stream.drain()));
      payload.voiceCallbacks?.onDone?.();
      for (const id of replyIds) patchMessage(id, { status: finalStatus });
      if (spaceChanged) await loadSpacePosts();
      if (timelineChanged && currentView === 'timeline') renderTimeline();
      setConnectionState(true);
    } catch (error) {
      payload.voiceCallbacks?.onError?.(error);
      chatTiming.failed = true;
      for (const stream of streams.values()) stream.flush();
      let state = 'unknown';
      try { state = await reconcileChatTurn(payload.messageId); } catch { /* 断网时稍后再核对，不能当作发送失败。 */ }
      if (state === 'completed') setConnectionState(true);
      else if (state === 'missing' || state === 'accepted') { patchMessage(payload.messageId, { status: 'failed' }); showToast(error.message || '发送失败'); }
      else { patchMessage(payload.messageId, { status: 'sending' }); showToast('连接中断，稍后会核对并补齐回复'); }
      if (state === 'unknown') setConnectionState(false);
    } finally {
      void ethereApi.reportChatLatency(chatTiming).catch(() => {});
      for (const stream of streams.values()) activeTextStreams.delete(stream);
      currentChatRequest = null;
      await syncChatEvents().catch(() => {});
    }
  }
  chatSendLoopRunning = false;
  typing.hidden = true;
  resizeComposer();
}

function startOfWeek(date) { return addDays(date, -((date.getDay() + 6) % 7)); }
function isoWeekInfo(date) {
  const start = startOfWeek(date);
  const thursday = addDays(start, 3);
  const year = thursday.getFullYear();
  const first = startOfWeek(new Date(year, 0, 4));
  return { year, week: 1 + Math.round((start - first) / (7 * 86_400_000)), start, end: addDays(start, 6) };
}
function weekLabelMarkup(date) { const info = isoWeekInfo(date); return `<strong>${info.year} 年第 ${info.week} 周</strong><small>${formatDateRange(info.start, info.end)}</small>`; }
function timelineBounds() {
  if (activeRange === 'day') return [timelineDate, timelineDate];
  if (activeRange === 'week') { const start = startOfWeek(timelineDate); return [start, addDays(start, 6)]; }
  if (activeRange === 'month') return [new Date(timelineDate.getFullYear(), timelineDate.getMonth(), 1), new Date(timelineDate.getFullYear(), timelineDate.getMonth() + 1, 0)];
  return customRangeStart <= customRangeEnd ? [customRangeStart, customRangeEnd] : [customRangeEnd, customRangeStart];
}
function durationLabel(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value < 60) return `${value}m`;
  return value % 60 ? `${Math.floor(value / 60)}h${value % 60}m` : `${value / 60}h`;
}
function timelineTaxonomy() {
  const parents = new Map();
  const children = new Map();
  timelineCategories.forEach((category) => {
    parents.set(category.id, category);
    category.children.forEach((child) => children.set(`${category.id}/${child.id}`, child));
  });
  return { parents, children };
}
function eventMinutes(event) { return Math.max(0, Math.round((Date.parse(event.endedAt) - Date.parse(event.startedAt)) / 60_000)); }
function renderRanking(stats = timelineStats) {
  const rows = stats.groups || [];
  const max = rows[0]?.minutes || 1;
  $('[data-ranking-list]').innerHTML = rows.length ? rows.map((group, index) => {
    const expanded = expandedRankingCategories.has(group.categoryId);
    const children = group.children || [];
    const childMax = children[0]?.minutes || 1;
    return `<article class="ranking-row${expanded ? ' is-expanded' : ''}" data-ranking-category="${escapeHtml(group.categoryId)}"><button class="ranking-row__toggle" type="button" data-ranking-toggle="${escapeHtml(group.categoryId)}" aria-expanded="${expanded}"><strong>${index + 1}</strong><div><span>${escapeHtml(group.name)}</span><i><b style="width:${Math.round(group.minutes / max * 100)}%;background:${escapeHtml(group.color)}"></b></i></div><time>${durationLabel(group.minutes)}</time><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg></button><div class="ranking-children"${expanded ? '' : ' hidden'}>${children.map((child) => `<div><span>${escapeHtml(child.name)}</span><i><b style="width:${Math.round(child.minutes / childMax * 100)}%;background:${escapeHtml(group.color)}"></b></i><time>${durationLabel(child.minutes)}</time></div>`).join('')}</div></article>`;
  }).join('') : '<p class="empty-state">这段时间还没有记录</p>';
  $('[data-ranking-total]').textContent = `已记录 ${durationLabel(stats.totalMinutes || 0)}`;
}
function renderCategoryBrowser() {
  $('[data-category-list]').innerHTML = timelineCategories.length ? timelineCategories.map((category) => `<article class="category-browser__group${category.status === 'inactive' ? ' is-inactive' : ''}" style="--category-color:${escapeHtml(category.color)}"><button class="category-browser__head" type="button" data-edit-category="${escapeHtml(category.id)}"><i aria-hidden="true"></i><span><strong>${escapeHtml(category.name)}</strong>${category.status === 'inactive' ? '<em>已停用</em>' : ''}</span></button><div class="category-browser__children">${category.children.map((child) => `<button class="category-browser__child${child.status === 'inactive' ? ' is-inactive' : ''}" type="button" data-edit-category="${escapeHtml(category.id)}" data-edit-subcategory="${escapeHtml(child.id)}"><span><b>${escapeHtml(child.name)}</b>${child.status === 'inactive' ? '<em>已停用</em>' : ''}</span></button>`).join('')}</div>${category.status === 'active' ? `<button class="category-browser__add-child" type="button" data-add-subcategory="${escapeHtml(category.id)}">＋ 新增</button>` : ''}</article>`).join('') : '<p class="empty-state">还没有分类</p>';
}
function categoryStableId(prefix) { return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase(); }
async function loadTimelineCategories() {
  const result = await ethereApi.timelineCategories({ includeInactive: true });
  timelineCategories = result.categories || [];
  timelineCategoryRevision = result.revision || 0;
  renderCategoryBrowser();
  return result;
}
function closeCategoryEdit() { $('[data-category-edit-sheet]').hidden = true; categoryEditTarget = null; }
function openCategoryEdit(mode, categoryId = '', subcategoryId = '') {
  const category = timelineCategories.find((item) => item.id === categoryId);
  const subcategory = category?.children.find((item) => item.id === subcategoryId);
  categoryEditTarget = { mode, categoryId, subcategoryId };
  const titles = { addCategory: '新增一级分类', addSubcategory: '新增二级分类', editCategory: '编辑一级分类', editSubcategory: '编辑二级分类' };
  $('[data-category-edit-title]').textContent = titles[mode];
  $('[data-category-edit-name]').value = mode === 'editCategory' ? category?.name || '' : mode === 'editSubcategory' ? subcategory?.name || '' : '';
  const parentLabel = $('[data-category-edit-parent]');
  parentLabel.hidden = !['addSubcategory', 'editSubcategory'].includes(mode);
  parentLabel.textContent = category ? `一级分类 · ${category.name}` : '';
  const colorField = $('[data-category-color-field]');
  colorField.hidden = !['addCategory', 'editCategory'].includes(mode);
  categoryEditColor = mode === 'addCategory' ? CATEGORY_COLORS[timelineCategories.length % CATEGORY_COLORS.length] : category?.color || CATEGORY_COLORS[0];
  $('[data-category-color-options]').innerHTML = CATEGORY_COLORS.map((color) => `<button class="${color === categoryEditColor ? 'is-active' : ''}" type="button" data-category-color="${color}" style="--choice-color:${color}" aria-label="选择颜色 ${color}"></button>`).join('');
  const statusButton = $('[data-category-status-action]');
  const target = mode === 'editCategory' ? category : mode === 'editSubcategory' ? subcategory : null;
  statusButton.hidden = !target || categoryId === 'uncategorized';
  statusButton.textContent = target?.status === 'inactive' ? '重新启用' : '停用分类';
  statusButton.classList.toggle('is-restore', target?.status === 'inactive');
  $('[data-category-edit-sheet]').hidden = false;
  requestAnimationFrame(() => $('[data-category-edit-name]').focus());
}
function applyCategoryMutation(result) {
  timelineCategories = result.categories || [];
  timelineCategoryRevision = result.revision || timelineCategoryRevision;
  renderCategoryBrowser();
  renderTimelineData();
}
async function handleCategoryMutation(run) {
  if (!connected) return showToast('电脑端未连接，无法保存');
  try {
    applyCategoryMutation(await run());
    closeCategoryEdit();
    showToast('已保存');
  } catch (error) {
    if (error.status === 409) {
      await loadTimelineCategories().catch(() => {});
      closeCategoryEdit();
      return showToast('分类已在其他位置更新，请重新操作');
    }
    showToast(error.message || '保存失败');
    if (!error.status) setConnectionState(false);
  }
}
function refreshReviewClamp() {
  const copy = $('[data-review-text]');
  const button = $('[data-review-expand]');
  if (!copy || !button || activeRange !== 'day') return;
  copy.classList.add('is-collapsed');
  button.textContent = '展开';
  button.hidden = copy.scrollHeight <= copy.clientHeight + 2;
}
function renderTimelineData() {
  const [start, end] = timelineBounds();
  const { parents, children } = timelineTaxonomy();
  $('[data-period-label]').innerHTML = activeRange === 'week' ? weekLabelMarkup(start)
    : `<strong>${activeRange === 'day' ? formatDate(start) : activeRange === 'month' ? formatMonth(start) : formatDateRange(start, end)}</strong>`;
  $$('[data-period-step]').forEach((button) => { button.hidden = activeRange === 'custom'; });
  const dayStart = Date.parse(`${isoDate(start)}T00:00:00+08:00`);
  const dayEnd = dayStart + 24 * 60 * 60_000;
  $('.distribution-bar').innerHTML = activeRange === 'day' ? timelineEvents.map((event) => {
    const segmentStart = Math.max(dayStart, Date.parse(event.startedAt));
    const segmentEnd = Math.min(dayEnd, Date.parse(event.endedAt));
    if (segmentEnd <= segmentStart) return '';
    const category = parents.get(event.categoryId);
    const left = (segmentStart - dayStart) / (dayEnd - dayStart) * 100;
    const width = (segmentEnd - segmentStart) / (dayEnd - dayStart) * 100;
    return `<i class="timeline-segment" style="left:${left}%;width:${width}%;--segment-color:${escapeHtml(category?.color || '#9398A5')}" title="${escapeHtml(event.title)}"></i>`;
  }).join('') : '';
  $('.distribution-legend').innerHTML = (timelineStats.groups || []).map((group) => `<i class="dot" style="background:${escapeHtml(group.color)}"></i>${escapeHtml(group.name)} ${durationLabel(group.minutes)}`).join(' ') || '尚未记录';
  $('.distribution-bar').setAttribute('aria-label', timelineStats.totalMinutes ? `已记录 ${timelineStats.totalMinutes} 分钟` : '尚未记录');
  $('[data-timeline-events]').innerHTML = timelineEvents.length ? timelineEvents.map((event) => {
    const category = parents.get(event.categoryId);
    const subcategory = children.get(`${event.categoryId}/${event.subcategoryId}`);
    return `<article class="timeline-entry" data-edit-timeline-event="${escapeHtml(event.id)}" role="button" tabindex="0"><time>${escapeHtml(eventClock(event.startedAt))}<small>${durationLabel(eventMinutes(event))}</small></time><div><span class="category-path"><b>${escapeHtml(category?.name || event.categoryId)}</b><i>${escapeHtml(subcategory?.name || event.subcategoryId)}</i></span><h4>${escapeHtml(event.title)}</h4>${event.note ? `<div class="timeline-note">${markdownMarkup(event.note)}</div>` : ''}</div></article>`;
  }).join('') : '<p class="empty-state">这一天还没有记录</p>';
  $('[data-review-text]').innerHTML = markdownMarkup(timelineReview?.text || '还没有写当日回顾。');
  $('[data-ranking-title]').textContent = '时间排行';
  renderRanking();
  const dayView = activeRange === 'day';
  $('[data-timeline-mode="events"]').hidden = !dayView;
  $('[data-timeline-mode="stats"]').hidden = dayView && !dayStatsExpanded;
  $('[data-distribution-toggle]').classList.toggle('is-stats', dayView && dayStatsExpanded);
  $('[data-distribution-toggle]').setAttribute('aria-expanded', String(dayView && dayStatsExpanded));
  $$('[data-day-only]').forEach((node) => { node.hidden = activeRange !== 'day'; });
  $('[data-add-timeline-event]').hidden = activeRange !== 'day';
  requestAnimationFrame(refreshReviewClamp);
}
function isTimelineWriteActivity(content = '') {
  return content.startsWith('已记录时间线') || ['已更新时间线', '已从时间线移除记录', '已写入当日回顾'].includes(content);
}
function renderTimeline() {
  const [start, end] = timelineBounds();
  if (!connected) {
    timelineEvents = [];
    timelineStats = { totalMinutes: 0, groups: [] };
    timelineReview = null;
    renderTimelineData();
    return;
  }
  const token = ++timelineLoadToken;
  $('[data-timeline-events]').innerHTML = '<p class="empty-state">正在读取…</p>';
  Promise.all([
    ethereApi.timeline({ start: isoDate(start), end: isoDate(end) }),
    ethereApi.timelineStats({ start: isoDate(start), end: isoDate(end) }),
    ethereApi.timelineCategories({ includeInactive: true }),
    activeRange === 'day' ? ethereApi.timelineReview(isoDate(start)) : Promise.resolve({ review: null }),
  ]).then(([timeline, stats, taxonomy, review]) => {
    if (token !== timelineLoadToken) return;
    timelineEvents = timeline.events || [];
    timelineStats = stats || { totalMinutes: 0, groups: [] };
    timelineCategories = taxonomy.categories || [];
    timelineCategoryRevision = taxonomy.revision || 0;
    timelineReview = review.review || null;
    renderTimelineData();
    renderCategoryBrowser();
  }).catch((error) => {
    if (token !== timelineLoadToken) return;
    timelineEvents = [];
    timelineStats = { totalMinutes: 0, groups: [] };
    timelineReview = null;
    renderTimelineData();
    showToast(error.message || '时间轴读取失败');
    if (!error.status) setConnectionState(false);
  });
}

function stepPeriod(direction) { const delta = activeRange === 'week' ? direction * 7 : direction; timelineDate = activeRange === 'month' ? new Date(timelineDate.getFullYear(), timelineDate.getMonth() + direction, 1) : addDays(timelineDate, delta); renderTimeline(); }

function isCurrentPeriod(mode = activeRange, selectedDate = timelineDate) {
  const today = new Date();
  if (mode === 'day') return isoDate(selectedDate) === isoDate(today);
  if (mode === 'week') return isoDate(startOfWeek(selectedDate)) === isoDate(startOfWeek(today));
  if (mode === 'month') return selectedDate.getFullYear() === today.getFullYear() && selectedDate.getMonth() === today.getMonth();
  return false;
}

function pickerUtilityMarkup() {
  if (pickerMode === 'custom' || isCurrentPeriod(pickerMode, pendingPeriodDate)) return '';
  const label = pickerMode === 'week' ? '回到本周' : pickerMode === 'month' ? '回到本月' : '回到今天';
  return `<div class="picker-utility"><button type="button" data-picker-return-current>${label}</button></div>`;
}

function calendarMarkup(owner, month, start = null, end = null, minimum = null) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const offset = (first.getDay() + 6) % 7;
  const days = Array.from({ length: offset }, () => '<i></i>');
  for (let day = 1; day <= last.getDate(); day += 1) {
    const date = new Date(month.getFullYear(), month.getMonth(), day);
    const value = isoDate(date);
    const selected = start && value === isoDate(start);
    const ending = end && value === isoDate(end);
    const between = start && end && date > start && date < end;
    const disabled = minimum && date < minimum;
    days.push(`<button type="button" class="${selected || ending ? 'is-selected' : ''}${between ? ' is-between' : ''}" data-${owner}-date="${value}"${disabled ? ' disabled' : ''}>${day}</button>`);
  }
  return `<div class="calendar-head"><button type="button" data-${owner}-month-step="-1" aria-label="上个月">‹</button><strong>${formatMonth(month)}</strong><button type="button" data-${owner}-month-step="1" aria-label="下个月">›</button></div><div class="calendar-week"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div><div class="calendar-grid">${days.join('')}</div>`;
}

function periodWheelItem(mode, value, active) {
  if (mode === 'week') {
    return `<button type="button" class="${active ? 'is-active' : ''}" data-picker-week="${isoDate(value)}">${weekLabelMarkup(value)}</button>`;
  }
  return `<button type="button" class="${active ? 'is-active' : ''}" data-picker-month="${isoDate(value)}"><strong>${formatMonth(value)}</strong></button>`;
}

function extendPeriodWheel(wheel, direction) {
  const attribute = pickerMode === 'week' ? 'data-picker-week' : 'data-picker-month';
  const items = [...wheel.querySelectorAll(`[${attribute}]`)];
  if (!items.length || wheel.dataset.extending) return;
  wheel.dataset.extending = 'true';
  const edge = dateFromIso((direction < 0 ? items[0] : items.at(-1)).getAttribute(attribute));
  const beforeHeight = wheel.scrollHeight;
  const fragment = document.createDocumentFragment();
  for (let index = 1; index <= 24; index += 1) {
    const value = pickerMode === 'week' ? addDays(edge, direction * index * 7) : new Date(edge.getFullYear(), edge.getMonth() + direction * index, 1);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = periodWheelItem(pickerMode, value, false);
    if (direction < 0) fragment.prepend(wrapper.firstElementChild); else fragment.append(wrapper.firstElementChild);
  }
  if (direction < 0) { wheel.prepend(fragment); wheel.scrollTop += wheel.scrollHeight - beforeHeight; } else wheel.append(fragment);
  delete wheel.dataset.extending;
}

function bindInfinitePeriodWheel(body) {
  const wheel = body.querySelector('.period-wheel');
  if (!wheel) return;
  wheel.addEventListener('scroll', () => {
    if (wheel.scrollTop < 90) extendPeriodWheel(wheel, -1);
    if (wheel.scrollHeight - wheel.scrollTop - wheel.clientHeight < 90) extendPeriodWheel(wheel, 1);
    const attribute = pickerMode === 'week' ? 'data-picker-week' : 'data-picker-month';
    const options = [...wheel.querySelectorAll(`[${attribute}]`)];
    const center = wheel.scrollTop + wheel.clientHeight / 2;
    const nearest = options.reduce((best, option) => !best || Math.abs(option.offsetTop + option.offsetHeight / 2 - center) < Math.abs(best.offsetTop + best.offsetHeight / 2 - center) ? option : best, null);
    if (nearest) {
      options.forEach((option) => option.classList.toggle('is-active', option === nearest));
      pendingPeriodDate = dateFromIso(nearest.getAttribute(attribute));
    }
  }, { passive: true });
}

function renderPeriodPicker() {
  const body = $('[data-period-picker-body]');
  if (pickerMode === 'week') {
    const center = startOfWeek(pendingPeriodDate);
    body.innerHTML = `${pickerUtilityMarkup()}<div class="period-wheel-wrap"><div class="period-wheel">${Array.from({ length: 49 }, (_, index) => addDays(center, (index - 24) * 7)).map((start) => periodWheelItem('week', start, isoDate(start) === isoDate(center))).join('')}</div></div><button class="sheet-primary" type="button" data-apply-period>确定</button>`;
  } else if (pickerMode === 'month') {
    const center = new Date(pendingPeriodDate.getFullYear(), pendingPeriodDate.getMonth(), 1);
    body.innerHTML = `${pickerUtilityMarkup()}<div class="period-wheel-wrap"><div class="period-wheel">${Array.from({ length: 49 }, (_, index) => new Date(center.getFullYear(), center.getMonth() + index - 24, 1)).map((month) => periodWheelItem('month', month, month.getFullYear() === center.getFullYear() && month.getMonth() === center.getMonth())).join('')}</div></div><button class="sheet-primary" type="button" data-apply-period>确定</button>`;
  } else if (pickerMode === 'custom') {
    const activeDate = customPickerStep === 'start' ? pendingCustomStart : pendingCustomEnd;
    const minimum = customPickerStep === 'end' ? pendingCustomStart : null;
    const actionDisabled = customPickerStep === 'start' ? !pendingCustomStart : !pendingCustomEnd;
    body.innerHTML = `<div class="custom-picker-progress"><div class="${customPickerStep === 'start' ? 'is-active' : ''}"><span>开始日期</span><strong>${pendingCustomStart ? formatDate(pendingCustomStart) : '请选择'}</strong></div><i>→</i><div class="${customPickerStep === 'end' ? 'is-active' : ''}"><span>结束日期</span><strong>${pendingCustomEnd ? formatDate(pendingCustomEnd) : '请选择'}</strong></div></div>${calendarMarkup('picker', pickerMonth, activeDate, null, minimum)}<button class="sheet-primary" type="button" data-custom-picker-next${actionDisabled ? ' disabled' : ''}>${customPickerStep === 'start' ? '下一步' : '完成'}</button>`;
  } else {
    body.innerHTML = `${pickerUtilityMarkup()}${calendarMarkup('picker', pickerMonth, timelineDate, timelineDate)}`;
  }
  bindInfinitePeriodWheel(body);
  requestAnimationFrame(() => { const wheel = body.querySelector('.period-wheel'); const active = wheel?.querySelector('.is-active'); if (wheel && active) wheel.scrollTop = active.offsetTop - wheel.clientHeight / 2 + active.offsetHeight / 2; });
}

function openPeriodPicker(mode = activeRange) {
  pickerMode = mode;
  pendingPeriodDate = new Date(timelineDate);
  pickerMonth = new Date(timelineDate.getFullYear(), timelineDate.getMonth(), 1);
  if (mode === 'custom') { pendingCustomStart = null; pendingCustomEnd = null; customPickerStep = 'start'; }
  renderPeriodPicker();
  $('[data-period-picker]').hidden = false;
}
function closePeriodPicker() { $('[data-period-picker]').hidden = true; }

function renderSpaceCustomPicker() {
  const activeDate = spaceCustomStep === 'start' ? spacePendingStart : spacePendingEnd;
  const minimum = spaceCustomStep === 'end' ? spacePendingStart : null;
  const actionDisabled = spaceCustomStep === 'start' ? !spacePendingStart : !spacePendingEnd;
  $('[data-space-time-body]').innerHTML = `<div class="custom-picker-progress"><div class="${spaceCustomStep === 'start' ? 'is-active' : ''}"><span>开始日期</span><strong>${spacePendingStart ? formatDate(spacePendingStart) : '请选择'}</strong></div><i>→</i><div class="${spaceCustomStep === 'end' ? 'is-active' : ''}"><span>结束日期</span><strong>${spacePendingEnd ? formatDate(spacePendingEnd) : '请选择'}</strong></div></div>${calendarMarkup('space', spacePickerMonth, activeDate, null, minimum)}<button class="sheet-primary" type="button" data-space-custom-next${actionDisabled ? ' disabled' : ''}>${spaceCustomStep === 'start' ? '下一步' : '完成'}</button>`;
}

let spaceActorFilter = 'all';
let spaceDayFilter = 'all';
function applySpaceFilters() {
  renderSpacePosts();
}

function spaceTimeOptionsMarkup() {
  const options = [['all', '全部时间'], ['7', '最近 7 天'], ['30', '最近 30 天'], ['custom', '自定义']];
  return `<div class="time-filter-list">${options.map(([value, label]) => `<button class="${spaceDayFilter === value ? 'is-active' : ''}" type="button" data-space-days="${value}">${label}${spaceDayFilter === value ? '<span aria-hidden="true">✓</span>' : ''}</button>`).join('')}</div>`;
}

function enterSubpage() { shell.classList.add('subpage-open'); }
function leaveSubpage() { shell.classList.remove('subpage-open'); }
function handleAppBack() {
  if (voiceCallController?.isOpen()) { if (!voiceCallController.closeAudioPicker()) void voiceCallController.end(); return true; }
  if (!$('[data-space-lightbox]').hidden) { closeSpaceLightbox(); return true; }
  const sheetBackdrop = $('.bottom-sheet:not([hidden]) .sheet-backdrop');
  if (sheetBackdrop) { sheetBackdrop.click(); return true; }
  // Nested subpages remain mounted underneath the current one. Close the
  // frontmost visible editor first, not the first one in DOM order.
  const inlineBack = [...document.querySelectorAll('.inline-editor:not([hidden]) button[aria-label="返回"]')].at(-1);
  if (inlineBack) { inlineBack.click(); return true; }
  if (!$('[data-space-editor]').hidden) { closeSpaceEditor(); return true; }
  if (currentView !== 'chat') { setView('chat'); return true; }
  return false;
}
window.EthereHandleBack = handleAppBack;
function beijingTimeValue(value) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}
function eventCategoryLabel(categoryId, subcategoryId) {
  const parent = timelineCategories.find((item) => item.id === categoryId);
  const child = parent?.children.find((item) => item.id === subcategoryId);
  return parent && child ? `${parent.name} · ${child.name}` : '请选择';
}
function setTimelineDraftCategory(categoryId, subcategoryId) {
  timelineDraftCategoryId = categoryId;
  timelineDraftSubcategoryId = subcategoryId;
  $('[data-event-category-label]').textContent = eventCategoryLabel(categoryId, subcategoryId);
}
function syncTimelineTimeLabels() {
  const start = $('[data-timeline-event-start]').value;
  const end = $('[data-timeline-event-end]').value;
  const nextDay = Number($('[data-timeline-event-end-day]').value) > 0;
  $('[data-event-start-label]').textContent = start || '--:--';
  $('[data-event-end-label]').textContent = end || '--:--';
  $('[data-event-end-day]').textContent = nextDay ? '次日' : '当日';
}
function syncEventTimeDayLabel() {
  $('[data-event-time-day]').textContent = eventTimeTarget === 'end' && eventTimeHour >= 24 ? '次日' : '当日';
}
function eventTimeOptions(kind) {
  const values = kind === 'hour'
    ? Array.from({ length: eventTimeTarget === 'end' ? 48 : 24 }, (_, value) => value)
    : Array.from({ length: 60 }, (_, value) => value);
  const selected = kind === 'hour' ? eventTimeHour : eventTimeMinute;
  return values.map((value) => `<button class="${value === selected ? 'is-active' : ''}" type="button" data-event-time-${kind}="${value}">${twoDigits(kind === 'hour' ? value % 24 : value)}</button>`).join('');
}
function centerEventTimeOption(wheel, selector) {
  const option = $(selector, wheel);
  if (option) wheel.scrollTop = option.offsetTop - (wheel.clientHeight - option.offsetHeight) / 2;
}
function renderEventTimePicker() {
  const hourWheel = $('[data-event-hour-wheel]');
  const minuteWheel = $('[data-event-minute-wheel]');
  $('[data-event-time-title]').textContent = eventTimeTarget === 'start' ? '开始时间' : '结束时间';
  hourWheel.innerHTML = eventTimeOptions('hour');
  minuteWheel.innerHTML = eventTimeOptions('minute');
  syncEventTimeDayLabel();
  requestAnimationFrame(() => {
    centerEventTimeOption(hourWheel, `[data-event-time-hour="${eventTimeHour}"]`);
    centerEventTimeOption(minuteWheel, `[data-event-time-minute="${eventTimeMinute}"]`);
  });
}
function openEventTimePicker(target) {
  eventTimeTarget = target;
  const value = $(`[data-timeline-event-${target}]`).value || '00:00';
  const [hour, minute] = value.split(':').map(Number);
  eventTimeHour = hour + (target === 'end' && Number($('[data-timeline-event-end-day]').value) > 0 ? 24 : 0);
  eventTimeMinute = minute;
  $('[data-event-time-sheet]').hidden = false;
  renderEventTimePicker();
}
function closeEventTimePicker() { $('[data-event-time-sheet]').hidden = true; }
function updateEventTimeFromWheel(wheel, kind) {
  const center = wheel.scrollTop + wheel.clientHeight / 2;
  const options = $$(`[data-event-time-${kind}]`, wheel);
  const nearest = options.reduce((best, option) => Math.abs(option.offsetTop + option.offsetHeight / 2 - center) < Math.abs(best.offsetTop + best.offsetHeight / 2 - center) ? option : best, options[0]);
  if (!nearest) return;
  const value = Number(nearest.dataset[`eventTime${kind[0].toUpperCase()}${kind.slice(1)}`]);
  if (kind === 'hour') eventTimeHour = value; else eventTimeMinute = value;
  options.forEach((option) => option.classList.toggle('is-active', option === nearest));
  syncEventTimeDayLabel();
  window.clearTimeout(eventTimeScrollTimers[kind]);
  eventTimeScrollTimers[kind] = window.setTimeout(() => centerEventTimeOption(wheel, `[data-event-time-${kind}="${value}"]`), 90);
}
function openTimelineEventEditor(event = null) {
  if (activeRange !== 'day') return;
  editingTimelineEvent = event;
  const selectedDate = isoDate(timelineDate);
  const now = new Date();
  const defaultStart = isoDate(now) === selectedDate ? `${twoDigits(now.getHours())}:${twoDigits(Math.floor(now.getMinutes() / 5) * 5)}` : '09:00';
  const [defaultHour, defaultMinute] = defaultStart.split(':').map(Number);
  const defaultEndTotal = defaultHour * 60 + defaultMinute + 30;
  const defaultEnd = `${twoDigits(Math.floor(defaultEndTotal / 60) % 24)}:${twoDigits(defaultEndTotal % 60)}`;
  $('[data-timeline-event-title]').textContent = event ? '编辑时间' : '记录时间';
  $('[data-timeline-event-date]').textContent = formatDate(timelineDate);
  $('[data-timeline-event-name]').value = event?.title || '';
  $('[data-timeline-event-start]').value = event ? beijingTimeValue(event.startedAt) : defaultStart;
  $('[data-timeline-event-end]').value = event ? beijingTimeValue(event.endedAt) : defaultEnd;
  $('[data-timeline-event-end-day]').value = event ? Number(beijingDateKey(event.endedAt) !== beijingDateKey(event.startedAt)) : Number(defaultEndTotal >= 1440);
  syncTimelineTimeLabels();
  $('[data-timeline-event-note]').value = event?.note || '';
  $('[data-delete-timeline-event]').hidden = !event;
  const defaultParent = timelineCategories.find((item) => item.status === 'active' && item.children.some((child) => child.status === 'active'));
  const defaultChild = defaultParent?.children.find((child) => child.status === 'active');
  setTimelineDraftCategory(event?.categoryId || defaultParent?.id || '', event?.subcategoryId || defaultChild?.id || '');
  $('[data-timeline-event-editor]').hidden = false;
  enterSubpage();
}
function closeTimelineEventEditor() { $('[data-timeline-event-editor]').hidden = true; leaveSubpage(); editingTimelineEvent = null; }
function timelineDateTime(date, time, nextDay = false) { const key = nextDay ? shiftDateKey(date, 1) : date; return `${key}T${time}:00+08:00`; }
function renderEventCategoryOptions() {
  $('[data-event-category-options]').innerHTML = timelineCategories.filter((category) => category.status === 'active').map((category) => `<section><strong style="--category-color:${escapeHtml(category.color)}">${escapeHtml(category.name)}</strong>${category.children.filter((child) => child.status === 'active').map((child) => `<button type="button" data-event-category="${escapeHtml(category.id)}" data-event-subcategory="${escapeHtml(child.id)}" class="${category.id === timelineDraftCategoryId && child.id === timelineDraftSubcategoryId ? 'is-active' : ''}">${escapeHtml(child.name)}</button>`).join('')}</section>`).join('');
}
async function saveTimelineEvent() {
  if (!connected) return showToast('电脑端未连接，无法保存');
  const date = isoDate(timelineDate);
  const title = $('[data-timeline-event-name]').value.trim();
  const start = $('[data-timeline-event-start]').value;
  const end = $('[data-timeline-event-end]').value;
  if (!title || !start || !end) return showToast('请填写标题和时间');
  if (!timelineDraftCategoryId || !timelineDraftSubcategoryId) return showToast('请选择分类');
  const payload = { title, note: $('[data-timeline-event-note]').value.trim(), startedAt: timelineDateTime(date, start), endedAt: timelineDateTime(date, end, Number($('[data-timeline-event-end-day]').value) > 0), categoryId: timelineDraftCategoryId, subcategoryId: timelineDraftSubcategoryId, author: 'user', source: { type: 'manual' }, mutationId: mutationId(editingTimelineEvent ? 'timeline_update' : 'timeline_create') };
  if (editingTimelineEvent) { payload.baseRevision = editingTimelineEvent.revision; await ethereApi.updateTimelineEvent(editingTimelineEvent.id, payload); }
  else await ethereApi.createTimelineEvent(payload);
  closeTimelineEventEditor();
  showToast('已保存');
  renderTimeline();
}
async function archiveTimelineEvent() {
  if (!editingTimelineEvent || !connected) return;
  const archived = await ethereApi.archiveTimelineEvent(editingTimelineEvent.id, { baseRevision: editingTimelineEvent.revision, mutationId: mutationId('timeline_archive') });
  closeTimelineEventEditor();
  $('[data-event-delete-sheet]').hidden = true;
  renderTimeline();
  showToast('已删除', 6000, { label: '撤销', run: async () => { await ethereApi.restoreTimelineEvent(archived.event.id, { baseRevision: archived.event.revision, mutationId: mutationId('timeline_restore') }); showToast('已恢复'); renderTimeline(); } });
}
function resetLightboxImage(image) { image.dataset.scale = '1'; image.dataset.x = '0'; image.dataset.y = '0'; image.style.transform = ''; }
let activeChatPhotoUrls = [];
function closeSpaceLightbox() {
  const lightbox = $('[data-space-lightbox]');
  lightbox.hidden = true;
  lightbox.onpointerdown = null;
  lightbox.onpointermove = null;
  lightbox.onpointerup = null;
  lightbox.onpointercancel = null;
  lightbox.ondblclick = null;
  $('[data-space-lightbox-content]').innerHTML = '';
  activeChatPhotoUrls.forEach((url) => URL.revokeObjectURL(url));
  activeChatPhotoUrls = [];
}
function enableLightboxPinch(lightbox) {
  const pointers = new Map();
  let target = null;
  let startDistance = 0;
  let startScale = 1;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;
  let startTrackScroll = 0;
  let startSlide = 0;
  let lastX = 0;
  let wasPinching = false;
  let movedY = 0;
  let baseWidth = 0;
  let baseHeight = 0;
  let animationFrame = 0;
  const apply = () => {
    if (!target) return;
    if (animationFrame) return;
    animationFrame = requestAnimationFrame(() => {
      animationFrame = 0;
      if (!target) return;
    const scale = Number(target.dataset.scale || 1);
    const maxX = Math.max(0, baseWidth * (scale - 1) / 2);
    const maxY = Math.max(0, baseHeight * (scale - 1) / 2);
    const x = Math.max(-maxX, Math.min(maxX, Number(target.dataset.x || 0)));
    const y = Math.max(-maxY, Math.min(maxY, Number(target.dataset.y || 0)));
    target.dataset.x = String(x); target.dataset.y = String(y);
    target.style.transform = `translate3d(${x}px,${y}px,0) scale(${scale})`;
    });
  };
  lightbox.onpointerdown = (event) => {
    const image = event.target.closest('.space-lightbox-slide img');
    if (!image) return;
    if (target && target !== image) pointers.clear();
    target = image;
    baseWidth = image.offsetWidth;
    baseHeight = image.offsetHeight;
    image.classList.add('is-gesturing');
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    image.setPointerCapture?.(event.pointerId);
    if (pointers.size === 1) {
      const track = image.closest('.space-lightbox-track');
      startX = event.clientX; startY = event.clientY; lastX = event.clientX;
      originX = Number(image.dataset.x || 0); originY = Number(image.dataset.y || 0);
      startTrackScroll = track?.scrollLeft || 0;
      startSlide = Math.round(startTrackScroll / Math.max(1, track?.clientWidth || 1));
      wasPinching = false;
      movedY = 0;
    }
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; startDistance = Math.hypot(a.x - b.x, a.y - b.y); startScale = Number(image.dataset.scale || 1); wasPinching = true; }
  };
  lightbox.onpointermove = (event) => {
    if (!target || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    lastX = event.clientX;
    if (pointers.size === 2) {
      event.preventDefault();
      const [a, b] = [...pointers.values()];
      target.dataset.scale = String(Math.max(.72, Math.min(4, startScale * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, startDistance))));
      apply();
    } else if (Number(target.dataset.scale || 1) > 1) {
      event.preventDefault();
      target.dataset.x = String(originX + event.clientX - startX);
      target.dataset.y = String(originY + event.clientY - startY);
      movedY = event.clientY - startY;
      apply();
    } else if (!wasPinching) {
      event.preventDefault();
      movedY = event.clientY - startY;
      const track = target.closest('.space-lightbox-track');
      if (track) track.scrollLeft = startTrackScroll - (event.clientX - startX);
    }
  };
  const finish = (event) => {
    const wasLastPointer = pointers.size === 1;
    pointers.delete(event.pointerId);
    if (!target) return;
    if (pointers.size === 1) { const point = [...pointers.values()][0]; startX = point.x; startY = point.y; originX = Number(target.dataset.x || 0); originY = Number(target.dataset.y || 0); }
    if (!pointers.size && Number(target.dataset.scale || 1) <= 1.02) {
      const track = target.closest('.space-lightbox-track');
      if (track && wasLastPointer && !wasPinching) {
        const direction = lastX - startX < -42 ? 1 : lastX - startX > 42 ? -1 : 0;
        const lastSlide = Math.max(0, track.children.length - 1);
        const destination = Math.max(0, Math.min(lastSlide, startSlide + direction));
        track.scrollTo({ left: destination * track.clientWidth, behavior: 'smooth' });
      }
      resetLightboxImage(target);
      wasPinching = false;
      if (Math.abs(movedY) > 90 && Math.abs(movedY) > Math.abs(lastX - startX) * 1.2) closeSpaceLightbox();
    }
    if (!pointers.size) target?.classList.remove('is-gesturing');
  };
  lightbox.onpointerup = finish;
  lightbox.onpointercancel = finish;
  lightbox.ondblclick = (event) => {
    const image = event.target.closest('.space-lightbox-slide img');
    if (!image) return;
    target = image;
    baseWidth = image.offsetWidth;
    baseHeight = image.offsetHeight;
    if (Number(image.dataset.scale || 1) > 1.02) resetLightboxImage(image);
    else { image.dataset.scale = '2'; apply(); }
  };
}
function showSpaceLightbox(images, index = 0) {
  if (!images.length) return;
  const lightbox = $('[data-space-lightbox]');
  const content = $('[data-space-lightbox-content]');
  content.innerHTML = `<div class="space-lightbox-track">${images.map((image, imageIndex) => `<figure class="space-lightbox-slide"><img src="${escapeHtml(image.previewDataUrl || image.previewUrl || image.originalDataUrl || image.originalUrl)}" data-scale="1" data-x="0" data-y="0" alt="记录图片 ${imageIndex + 1}"></figure>`).join('')}</div><span class="space-lightbox-counter">${index + 1} / ${images.length}</span>`;
  lightbox.hidden = false;
  const track = content.querySelector('.space-lightbox-track');
  function loadOriginal(active) {
    const node = track.children[active]?.querySelector('img');
    const original = images[active]?.originalDataUrl || images[active]?.originalUrl;
    if (!node || !original || node.dataset.fullLoading || node.getAttribute('src') === original) return;
    node.dataset.fullLoading = 'true';
    const full = new Image();
    full.src = original;
    full.decode().then(() => { if (node.isConnected && !lightbox.hidden) node.src = original; }).catch(() => { /* 预览图仍可查看。 */ });
  }
  requestAnimationFrame(() => { track.scrollLeft = index * track.clientWidth; loadOriginal(index); });
  track.addEventListener('scroll', () => { const active = Math.round(track.scrollLeft / Math.max(1, track.clientWidth)); $('.space-lightbox-counter', content).textContent = `${active + 1} / ${images.length}`; loadOriginal(active); }, { passive: true });
  enableLightboxPinch(lightbox);
}
function openSpacePhoto(photo) {
  const post = spacePosts.find((item) => item.id === photo.closest('[data-space-id]')?.dataset.spaceId);
  if (!post?.images?.length) return;
  showSpaceLightbox(post.images, Math.max(0, [...photo.parentElement.children].indexOf(photo)));
}

async function showChatLightbox(attachments, index) {
  const images = attachments.filter((item) => item?.type === 'image' && item.dataUrl?.startsWith('data:image/'));
  if (!images.length) return;
  const originals = await Promise.all(images.map((item) => loadChatPhotoOriginal(item.originalPhotoId).catch(() => null)));
  const originalUrls = originals.map((blob) => blob ? URL.createObjectURL(blob) : null);
  activeChatPhotoUrls = originalUrls.filter(Boolean);
  showSpaceLightbox(images.map((item, photoIndex) => ({
    previewDataUrl: item.dataUrl,
    originalUrl: originalUrls[photoIndex] || item.dataUrl,
  })), index);
}

function renderSpaceEditorImages() {
  $('[data-space-upload-preview]').innerHTML = pendingSpaceImages.map((image, index) => `<div class="space-upload-preview__item"><button class="space-upload-preview__open" type="button" data-space-draft-photo="${index}" aria-label="放大第 ${index + 1} 张图片"><img src="${escapeHtml(image.previewDataUrl || image.previewUrl)}" alt="待发布图片"></button><button class="space-upload-preview__remove" type="button" data-space-draft-remove="${index}" aria-label="删除第 ${index + 1} 张图片"><span aria-hidden="true">×</span></button></div>`).join('');
  $('[data-space-image-input]').closest('.space-upload').hidden = pendingSpaceImages.length >= 9;
}
function closeSpaceEditor() { spaceEditorSession += 1; $('[data-space-editor]').hidden = true; leaveSubpage(); spaceAddButton.hidden = currentView !== 'space'; $('[data-space-text]').value = ''; $('[data-space-image-input]').value = ''; $('[data-space-image-input]').disabled = false; $('[data-space-upload-preview]').innerHTML = ''; $('[data-space-editor-title]').textContent = '记录'; pendingSpaceImages = []; editingSpacePost = null; spaceImagesPreparing = false; }
function openSpaceEditor(post = null) { spaceEditorSession += 1; spaceImagesPreparing = false; $('[data-space-image-input]').disabled = false; editingSpacePost = post; pendingSpaceImages = (post?.images || []).map((image) => ({ ...image })); $('[data-space-editor-title]').textContent = post ? '编辑记录' : '记录'; $('[data-space-text]').value = post?.contentMarkdown || ''; renderSpaceEditorImages(); $('[data-space-editor]').hidden = false; enterSubpage(); spaceAddButton.hidden = true; }
function enablePhotoDragging(root = document) {
  $$('[data-drag-scroll]', root).forEach((strip) => {
    if (strip.dataset.dragReady) return;
    strip.dataset.dragReady = 'true';
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startScroll = 0;
    strip.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startScroll = strip.scrollLeft;
      strip.dataset.dragMoved = '';
    });
    strip.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return;
      const delta = event.clientX - startX;
      const deltaY = event.clientY - startY;
      const horizontalDrag = Math.abs(delta) > 12 && Math.abs(delta) > Math.abs(deltaY) * 1.15;
      if (horizontalDrag) strip.dataset.dragMoved = 'true';
      if (event.pointerType !== 'mouse' || (!horizontalDrag && !strip.classList.contains('is-dragging'))) return;
      if (!strip.classList.contains('is-dragging')) {
        strip.classList.add('is-dragging');
        strip.setPointerCapture?.(event.pointerId);
      }
      strip.scrollLeft = startScroll - delta;
    });
    const finish = (event) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      strip.classList.remove('is-dragging');
    };
    strip.addEventListener('pointerup', finish);
    strip.addEventListener('pointercancel', (event) => { finish(event); strip.dataset.dragMoved = ''; });
    strip.addEventListener('click', (event) => {
      const photo = event.target.closest('[data-space-photo]');
      if (!photo) return;
      event.stopPropagation();
      if (strip.dataset.dragMoved === 'true') { strip.dataset.dragMoved = ''; return; }
      openSpacePhoto(photo);
    });
  });
}
function refreshSpaceClamps(root = document) {
  requestAnimationFrame(() => {
    $$('[data-space-copy]', root).forEach((copy) => {
      const button = copy.nextElementSibling?.matches('[data-space-expand]') ? copy.nextElementSibling : null;
      if (!button) return;
      const wasCollapsed = copy.classList.contains('is-collapsed');
      copy.classList.remove('is-collapsed');
      const lineHeight = Number.parseFloat(getComputedStyle(copy).lineHeight) || 24;
      const limit = lineHeight * 5;
      let collapsedHeight = 0;
      for (const child of copy.children) {
        const top = child.offsetTop;
        const bottom = child.offsetTop + child.offsetHeight;
        if (bottom <= limit + 1) { collapsedHeight = bottom; continue; }
        const isStructuredBlock = child.matches('h1,h2,h3,h4,blockquote,ul,ol,pre,hr,.markdown-table-wrap');
        if (isStructuredBlock && top < limit + 1) collapsedHeight = bottom;
        if (!collapsedHeight || child.matches('p')) collapsedHeight = limit;
        break;
      }
      if (!collapsedHeight) collapsedHeight = Math.min(limit, copy.scrollHeight);
      copy.style.setProperty('--space-collapsed-height', `${Math.ceil(collapsedHeight)}px`);
      const overflowing = copy.scrollHeight > collapsedHeight + 2;
      copy.classList.toggle('is-overflowing', overflowing);
      copy.classList.toggle('is-collapsed', wasCollapsed && overflowing);
      button.hidden = !overflowing;
    });
  });
}

function renderSpacePosts() {
  const root = $('.space-timeline');
  const selected = spacePosts.filter((post) => matchesSpacePost({ author: post.author, date: beijingDateKey(post.occurredAt) }, {
    author: spaceActorFilter, time: spaceDayFilter,
    start: spaceCustomStart ? isoDate(spaceCustomStart) : null, end: spaceCustomEnd ? isoDate(spaceCustomEnd) : null,
  }, isoDate(new Date())));
  root.innerHTML = selected.length ? selected.map(spacePostMarkup).join('') : '<p class="empty-state" data-space-empty>还没有记录</p>';
  enablePhotoDragging(root);
  refreshSpaceClamps(root);
}

function spacePostMarkup(post) {
  const occurredAt = new Date(post.occurredAt);
  const date = beijingDateKey(occurredAt).replaceAll('-', '.');
  const time = beijingTimeValue(occurredAt);
  const photos = post.images?.length ? `<div class="space-photos" data-drag-scroll aria-label="${post.images.length} 张图片">${post.images.map((image, index) => `<button class="space-photo" type="button" data-space-photo aria-label="放大记录图片 ${index + 1}"><img src="${escapeHtml(image.previewUrl)}" data-original-src="${escapeHtml(image.originalUrl)}" alt="记录图片"></button>`).join('')}</div>` : '';
  return `<article class="space-entry" data-space-id="${escapeHtml(post.id)}" data-space-kind="${escapeHtml(post.author)}" data-space-date="${escapeHtml(beijingDateKey(occurredAt))}"><div class="space-entry__meta"><i aria-hidden="true"></i><time><strong>${escapeHtml(date)}</strong><em>${escapeHtml(time)}</em></time><button class="post-actions-trigger" type="button" data-space-actions="${escapeHtml(post.id)}" aria-label="动态操作"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button></div><div class="space-entry__content"><div class="space-copy is-collapsed" data-space-copy>${markdownMarkup(post.contentMarkdown || '')}</div><button class="space-expand" type="button" data-space-expand hidden>展开</button>${photos}</div></article>`;
}

async function loadSpacePosts() {
  if (!connected) return;
  try {
    const result = await ethereApi.spacePosts({ limit: 200 });
    spacePosts = result.posts || [];
    renderSpacePosts();
  } catch (error) {
    showToast(error.message || '空间读取失败');
  }
}

function readFileDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = reject; reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file); }); }
async function prepareSpaceImage(file) {
  const [originalDataUrl, preview] = await Promise.all([readFileDataUrl(file), prepareImage(file, { maxEdge: 2400, quality: .92 })]);
  return { originalDataUrl, previewDataUrl: preview.dataUrl };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text && !pendingAttachments.length) return;
  const attachments = pendingAttachments;
  const quote = quoteDraft;
  const messageId = crypto.randomUUID();
  appendMessage('user', text, attachments, messageId, { status: 'sending', quote });
  input.value = '';
  pendingAttachments = [];
  quoteDraft = null;
  renderQuotePreview();
  imageInput.value = '';
  renderAttachment();
  resizeComposer();
  pendingChatSends.push({ message: text, images: attachments.filter((item) => item.type === 'image'), files: attachments.filter((item) => item.type === 'file').map((item) => item.id), messageId, quote });
  if (currentChatRequest) void ethereApi.interruptChat().catch(() => {});
  void runChatSendLoop();
});
function sendVoiceText(text, callbacks) {
  return new Promise((resolve, reject) => {
    const messageId = crypto.randomUUID();
    appendMessage('user', text, [], messageId, { status: 'sending' });
    pendingChatSends.push({ message: text, images: [], files: [], messageId, quote: null, channel: 'voice',
      voiceCallbacks: { onDelta: callbacks.onDelta, onDone: resolve, onError: reject } });
    void runChatSendLoop();
  });
}
function quoteableMessage(target) {
  const bubble = target?.closest?.('.bubble');
  const message = messages.find((item) => item.id === bubble?.closest('[data-message-id]')?.dataset.messageId);
  if (!bubble || !message || !['user', 'assistant'].includes(message.role)
    || ['streaming', 'sending', 'failed'].includes(message.status) || message.id === 'welcome' || !message.content?.trim()) return null;
  return { bubble, message };
}
list.addEventListener('pointerdown', (event) => {
  if (!['touch', 'pen'].includes(event.pointerType) || event.target.closest('img,button,a')) return;
  const target = quoteableMessage(event.target);
  if (!target) return;
  window.clearTimeout(quotePressTimer);
  quotePressStart = { x: event.clientX, y: event.clientY };
  quotePressTimer = window.setTimeout(() => {
    const selected = selectedQuoteCandidate();
    showQuoteAction(target.message, selected?.message.id === target.message.id ? selected.text : target.message.content,
      selected?.message.id === target.message.id ? selected.rect : target.bubble.getBoundingClientRect());
    quotePressTimer = 0;
  }, 520);
});
list.addEventListener('pointermove', (event) => {
  if (!quotePressStart || Math.hypot(event.clientX - quotePressStart.x, event.clientY - quotePressStart.y) < 10) return;
  window.clearTimeout(quotePressTimer);
  quotePressTimer = 0;
  quotePressStart = null;
  hideQuoteAction();
});
for (const type of ['pointerup', 'pointercancel']) list.addEventListener(type, () => { window.clearTimeout(quotePressTimer); quotePressTimer = 0; quotePressStart = null; });
list.addEventListener('contextmenu', (event) => {
  const target = quoteableMessage(event.target);
  if (!target) return;
  event.preventDefault();
  const selected = selectedQuoteCandidate();
  showQuoteAction(target.message, selected?.message.id === target.message.id ? selected.text : target.message.content,
    selected?.message.id === target.message.id ? selected.rect : target.bubble.getBoundingClientRect());
});
document.addEventListener('selectionchange', () => {
  const selected = selectedQuoteCandidate();
  if (selected) showQuoteAction(selected.message, selected.text, selected.rect);
});
list.addEventListener('wheel', hideQuoteAction, { passive: true });
list.addEventListener('touchmove', hideQuoteAction, { passive: true });
quoteAction.addEventListener('click', () => {
  if (!quoteCandidate) return;
  if (quoteCandidate.text.length > 4000) return showToast('引用内容过长，请选取其中一段');
  quoteDraft = quoteCandidate;
  renderQuotePreview();
  hideQuoteAction();
  window.getSelection()?.removeAllRanges();
  input.focus({ preventScroll: true });
});
$('[data-cancel-quote]').addEventListener('click', () => { quoteDraft = null; renderQuotePreview(); input.focus({ preventScroll: true }); });
document.addEventListener('click', (event) => { if (!event.target.closest('[data-quote-action],.bubble')) hideQuoteAction(); });
input.addEventListener('input', resizeComposer);
const attachmentTrigger = $('[data-add-image]');
const reduceAttachmentMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let attachmentActionsOpen = false;
let attachmentCloseTimer = 0;
let attachmentOpenFrame = 0;
function setAttachmentActionsOpen(open) {
  window.clearTimeout(attachmentCloseTimer);
  window.cancelAnimationFrame(attachmentOpenFrame);
  attachmentActionsOpen = open;
  attachmentTrigger.setAttribute('aria-expanded', String(open));
  if (open) {
    attachmentActions.hidden = false;
    attachmentOpenFrame = window.requestAnimationFrame(() => attachmentActions.classList.add('is-open'));
  } else {
    attachmentActions.classList.remove('is-open');
    if (reduceAttachmentMotion.matches) attachmentActions.hidden = true;
    else attachmentCloseTimer = window.setTimeout(() => { if (!attachmentActionsOpen) attachmentActions.hidden = true; }, 180);
  }
}
function closeAttachmentActions() { if (attachmentActionsOpen) setAttachmentActionsOpen(false); }
attachmentTrigger.addEventListener('click', () => setAttachmentActionsOpen(!attachmentActionsOpen));
list.addEventListener('pointerdown', closeAttachmentActions, { passive: true });
list.addEventListener('click', closeAttachmentActions);
input.addEventListener('focus', closeAttachmentActions);
$('[data-choose-image]').addEventListener('click', () => { closeAttachmentActions(); imageInput.click(); });
$('[data-choose-file]').addEventListener('click', () => { closeAttachmentActions(); fileInput.click(); });
divinationSheetController = createDivinationSheet({ root: document, storage, getAssistantName: () => bossName, send: (text) => {
  const messageId = crypto.randomUUID();
  appendMessage('user', text, [], messageId, { status: 'sending' });
  pendingChatSends.push({ message: text, images: [], files: [], messageId, quote: null });
  if (currentChatRequest) void ethereApi.interruptChat().catch(() => {});
  void runChatSendLoop();
  scrollToLatest();
} });
$('[data-open-divination]').addEventListener('click', () => { closeAttachmentActions(); divinationSheetController.open(); });
voiceCallController = createVoiceCall({ api: ethereApi, nativePermissions, sendText: sendVoiceText,
  interruptTurn: () => ethereApi.interruptChat(), showToast, getVoiceId: () => settings.voiceId || DEFAULT_VOICE_ID,
  getAssistantName: () => bossName });
$('[data-start-voice-call]').addEventListener('click', async () => {
  closeAttachmentActions();
  setView('chat');
  try { await voiceCallController.start(); } catch (error) { showToast(error.message || '无法开始语音通话'); }
});
window.EthereAnswerIncomingCall = (openingText = '') => {
  setView('chat');
  void voiceCallController.start('incoming', openingText).catch((error) => showToast(error.message || '无法接听来电'));
};
if (nativePermissions?.consumeIncomingCallIntent) {
  void nativePermissions.consumeIncomingCallIntent().then((result) => {
    if (result.answer) window.EthereAnswerIncomingCall(result.openingText || '');
  }).catch(() => {});
}
imageInput.addEventListener('change', async () => { const count = pendingAttachments.filter((item) => item.type === 'image').length; const files = [...imageInput.files].filter((file) => file.type.startsWith('image/')).slice(0, 4 - count); if (!files.length) return; if (files.some((file) => file.size > 12 * 1024 * 1024)) return showToast('请选择 12 MB 以内的图片'); try { pendingAttachments = [...pendingAttachments, ...await Promise.all(files.map(prepareChatImage))]; renderAttachment(); imageInput.value = ''; } catch { showToast('有图片无法读取'); } });
fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  const count = pendingAttachments.filter((item) => item.type === 'file').length;
  if (files.length > 3 - count) return showToast('单条消息最多附带 3 个文件');
  if (files.some((file) => file.size > 8 * 1024 * 1024)) return showToast('文件不能超过 8 MB');
  for (const file of files) {
    try { pendingAttachments.push(await ethereApi.uploadChatFile(file.name, await readFileDataUrl(file))); renderAttachment(); }
    catch (error) { showToast(error.message || '文件上传失败'); }
  }
});

async function consumeSharedContent() {
  if (!nativePermissions?.consumeSharedContent || !connected) return;
  if (sharedContentLoading) { sharedContentPending = true; return; }
  sharedContentLoading = true;
  try {
    const shared = await nativePermissions.consumeSharedContent();
    if (!shared?.text && !shared?.files?.length) return;
    closeAttachmentActions();
    setView('chat');
    input.value = appendSharedText(input.value, shared.text);
    for (const item of shared.files || []) {
      const kind = sharedFileKind(item);
      if (kind === 'image') {
        if (pendingAttachments.filter((attachment) => attachment.type === 'image').length >= 4) { showToast('单条消息最多附带 4 张图片'); continue; }
        try {
          const blob = await (await fetch(item.dataUrl)).blob();
          const image = new File([blob], item.name, { type: item.mime || blob.type });
          pendingAttachments.push(await prepareChatImage(image));
        } catch { showToast('分享的图片无法读取'); }
      } else if (kind === 'file') {
        if (pendingAttachments.filter((attachment) => attachment.type === 'file').length >= 3) { showToast('单条消息最多附带 3 个文件'); continue; }
        try { pendingAttachments.push(await ethereApi.uploadChatFile(item.name, item.dataUrl)); }
        catch (error) { showToast(error.message || '分享的文件上传失败，请重新分享'); }
      } else showToast(`暂不支持 ${item.name || '这个文件'} 的格式`);
    }
    renderAttachment();
    resizeComposer();
  } catch (error) { showToast(error.message || '无法读取分享内容'); }
  finally {
    sharedContentLoading = false;
    if (sharedContentPending) { sharedContentPending = false; void consumeSharedContent(); }
  }
}
window.EthereHandleSharedContent = () => { void consumeSharedContent(); };

spaceButton.addEventListener('click', () => setView('space')); settingsButton.addEventListener('click', () => { if (!settingsButton.disabled) setView('settings'); }); timelineButton.addEventListener('click', () => { setView('timeline'); renderTimeline(); }); backButton.addEventListener('click', () => setView('chat'));
categoriesButton.addEventListener('click', async () => {
  $('[data-category-editor]').hidden = false;
  enterSubpage();
  categoriesButton.hidden = true;
  $('[data-category-list]').innerHTML = '<p class="empty-state">正在读取…</p>';
  if (!connected) return renderCategoryBrowser();
  try {
    await loadTimelineCategories();
  } catch (error) {
    $('[data-category-list]').innerHTML = '<p class="empty-state">分类读取失败</p>';
    showToast(error.message);
    if (!error.status) setConnectionState(false);
  }
});
$('[data-close-categories]').addEventListener('click', () => { $('[data-category-editor]').hidden = true; leaveSubpage(); categoriesButton.hidden = false; });
$('[data-add-category]').addEventListener('click', () => openCategoryEdit('addCategory'));
$('[data-category-list]').addEventListener('click', (event) => {
  const add = event.target.closest('[data-add-subcategory]');
  if (add) return openCategoryEdit('addSubcategory', add.dataset.addSubcategory);
  const edit = event.target.closest('[data-edit-category]');
  if (!edit) return;
  openCategoryEdit(edit.dataset.editSubcategory ? 'editSubcategory' : 'editCategory', edit.dataset.editCategory, edit.dataset.editSubcategory || '');
});
$('[data-category-color-options]').addEventListener('click', (event) => {
  const color = event.target.closest('[data-category-color]');
  if (!color) return;
  categoryEditColor = color.dataset.categoryColor;
  $$('[data-category-color]').forEach((button) => button.classList.toggle('is-active', button === color));
});
$$('[data-close-category-edit]').forEach((button) => button.addEventListener('click', closeCategoryEdit));
$('[data-category-edit-form]').addEventListener('submit', async (event) => {
  event.preventDefault();
  const target = categoryEditTarget;
  const name = $('[data-category-edit-name]').value.trim();
  if (!target) return;
  if (!name) return showToast('请输入分类名称');
  const button = event.currentTarget.querySelector('[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  await handleCategoryMutation(() => {
    if (target.mode === 'addCategory') return ethereApi.createTimelineCategory({ id: categoryStableId('category'), name, color: categoryEditColor, baseRevision: timelineCategoryRevision });
    if (target.mode === 'addSubcategory') return ethereApi.createTimelineSubcategory(target.categoryId, { id: categoryStableId('subcategory'), name, baseRevision: timelineCategoryRevision });
    if (target.mode === 'editSubcategory') return ethereApi.updateTimelineSubcategory(target.categoryId, target.subcategoryId, { name, baseRevision: timelineCategoryRevision });
    return ethereApi.updateTimelineCategory(target.categoryId, { name, color: categoryEditColor, baseRevision: timelineCategoryRevision });
  });
  button.disabled = false;
});
$('[data-category-status-action]').addEventListener('click', async () => {
  const target = categoryEditTarget;
  if (!target || !target.mode.startsWith('edit')) return;
  const category = timelineCategories.find((item) => item.id === target.categoryId);
  const item = target.mode === 'editSubcategory' ? category?.children.find((child) => child.id === target.subcategoryId) : category;
  const payload = { status: item?.status === 'inactive' ? 'active' : 'inactive', baseRevision: timelineCategoryRevision };
  await handleCategoryMutation(() => target.mode === 'editSubcategory'
    ? ethereApi.updateTimelineSubcategory(target.categoryId, target.subcategoryId, payload)
    : ethereApi.updateTimelineCategory(target.categoryId, payload));
});
spaceAddButton.addEventListener('click', () => openSpaceEditor()); $('[data-close-space-editor]').addEventListener('click', closeSpaceEditor);
$('[data-space-image-input]').addEventListener('change', async (event) => {
  const files = [...event.target.files].filter((file) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type));
  event.target.value = '';
  if (!files.length) return;
  if (pendingSpaceImages.length + files.length > 9) return showToast('每条动态最多 9 张图片');
  if (files.some((file) => file.size > 12 * 1024 * 1024)) return showToast('单张图片请不超过 12 MB');
  if (spaceImagesPreparing) return;
  const session = spaceEditorSession;
  spaceImagesPreparing = true;
  event.target.disabled = true;
  try {
    const prepared = await Promise.all(files.map(prepareSpaceImage));
    if (session !== spaceEditorSession) return;
    pendingSpaceImages.push(...prepared);
    renderSpaceEditorImages();
  } catch { if (session === spaceEditorSession) showToast('有图片无法读取，请重新选择'); }
  finally { if (session === spaceEditorSession) { spaceImagesPreparing = false; event.target.disabled = false; } }
});
$('[data-space-upload-preview]').addEventListener('click', (event) => {
  const remove = event.target.closest('[data-space-draft-remove]');
  if (remove) { pendingSpaceImages.splice(Number(remove.dataset.spaceDraftRemove), 1); renderSpaceEditorImages(); return; }
  const photo = event.target.closest('[data-space-draft-photo]');
  if (photo) showSpaceLightbox(pendingSpaceImages, Number(photo.dataset.spaceDraftPhoto));
});
$('[data-space-editor-form]').addEventListener('submit', async (event) => {
  event.preventDefault();
  const contentMarkdown = $('[data-space-text]').value.trim();
  if (spaceImagesPreparing) return showToast('图片还在处理，请稍等');
  if (!contentMarkdown && !pendingSpaceImages.length) return showToast('写点内容或添加图片再发布');
  const submit = event.currentTarget.querySelector('[type="submit"]');
  const wasEditing = Boolean(editingSpacePost);
  submit.disabled = true;
  showToast('正在保存…', 10_000);
  try {
    const images = pendingSpaceImages.map((image) => image.id ? { id: image.id } : { originalDataUrl: image.originalDataUrl, previewDataUrl: image.previewDataUrl });
    if (editingSpacePost) await ethereApi.updateSpacePost(editingSpacePost.id, { contentMarkdown, images, baseRevision: editingSpacePost.revision });
    else await ethereApi.createSpacePost({ contentMarkdown, images, occurredAt: new Date().toISOString() });
    closeSpaceEditor();
    await loadSpacePosts();
    showToast(wasEditing ? '保存成功' : '发布成功');
  } catch (error) { showToast(error.message || '保存失败'); }
  finally { submit.disabled = false; }
});

function setBossNameEditing(editing) {
  const input = $('[data-boss-name-input]');
  const action = $('[data-edit-boss-name]');
  input.readOnly = !editing;
  action.classList.toggle('is-editing', editing);
  action.setAttribute('aria-label', editing ? '完成修改称呼' : '编辑称呼');
  action.querySelector('svg').toggleAttribute('hidden', editing);
  action.querySelector('span').toggleAttribute('hidden', !editing);
  if (editing) input.focus();
}
$('[data-boss-name-form]').addEventListener('submit', (event) => { event.preventDefault(); const value = $('[data-boss-name-input]').value.trim(); if (!value) return; bossName = value; storage.setItem('ethere.boss-name', value); setBossNameEditing(false); syncBossName(); if (connected) ethereApi.updateSettings({ bossName: value }).catch(() => setConnectionState(false)); });
$('[data-edit-boss-name]').addEventListener('click', () => { if ($('[data-boss-name-input]').readOnly) setBossNameEditing(true); else $('[data-boss-name-form]').requestSubmit(); });
$('[data-boss-name-input]').addEventListener('keydown', (event) => { if (event.key === 'Escape' && !event.currentTarget.readOnly) { event.currentTarget.value = bossName; setBossNameEditing(false); event.currentTarget.blur(); } });

const settings = readJson('ethere.settings', { model: 'default', voiceId: DEFAULT_VOICE_ID, checkinEnabled: true, checkinMin: 30, checkinMax: 90, theme: 'white' });
const MODEL_LABELS = { default: 'Runtime 默认' };
let draftCheckinMin = settings.checkinMin;
let draftCheckinMax = settings.checkinMax;
function applyTheme(theme) { document.body.dataset.theme = theme; settings.theme = theme; writeJson('ethere.settings', settings); $$('[data-theme-choice]').forEach((button) => button.classList.toggle('is-active', button.dataset.themeChoice === theme)); }
$('[data-model-label]').textContent = MODEL_LABELS[settings.model] || MODEL_LABELS.default;
$('[data-voice-label]').textContent = voiceLabel(settings.voiceId);
if (nativePermissions?.getCallRingtone) void nativePermissions.getCallRingtone().then((result) => {
  $('[data-ringtone-label]').textContent = result.label || '手机默认铃声';
}).catch(() => {});
$('[data-checkin-label]').textContent = `${settings.checkinEnabled ? '' : '已关闭 · '}${settings.checkinMin}–${settings.checkinMax} 分钟`;
applyTheme(settings.theme);
$('[data-open-model-picker]').addEventListener('click', async () => { $('[data-model-sheet]').hidden = false; try { const result = await ethereApi.models(); const options = [{ id: 'default', label: 'Runtime 默认' }, ...(result.models || [])]; options.forEach((model) => { MODEL_LABELS[model.id] = model.label; }); $('[data-model-options]').innerHTML = options.map((model) => `<button type="button" data-model-option="${escapeHtml(model.id)}">${escapeHtml(model.label)}</button>`).join(''); $$('[data-model-option]').forEach((button) => button.classList.toggle('is-active', button.dataset.modelOption === settings.model)); } catch (error) { showToast(error.message); } });
$$('[data-close-model-sheet]').forEach((button) => button.addEventListener('click', () => { $('[data-model-sheet]').hidden = true; }));
$('[data-open-voice-picker]').addEventListener('click', () => {
  $('[data-voice-options]').innerHTML = VOICE_OPTIONS.map((voice) => `<button type="button" data-voice-option="${voice.id}" class="${voice.id === settings.voiceId ? 'is-active' : ''}">${voice.label}</button>`).join('');
  $('[data-voice-sheet]').hidden = false;
});
$$('[data-close-voice-sheet]').forEach((button) => button.addEventListener('click', () => { $('[data-voice-sheet]').hidden = true; }));
$('[data-choose-call-ringtone]').addEventListener('click', async () => {
  if (!nativePermissions?.chooseCallRingtone) { showToast('请在手机上设置来电铃声'); return; }
  try {
    const result = await nativePermissions.chooseCallRingtone();
    $('[data-ringtone-label]').textContent = result.label || '手机默认铃声';
  } catch (error) { showToast(error.message || '无法选择铃声'); }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-voice-option]');
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    const remote = await ethereApi.updateSettings({ voiceId: button.dataset.voiceOption });
    settings.voiceId = remote.voiceId || DEFAULT_VOICE_ID;
    $('[data-voice-label]').textContent = voiceLabel(settings.voiceId);
    writeJson('ethere.settings', settings);
    $('[data-voice-sheet]').hidden = true;
  } catch (error) { showToast(error.message || '音色保存失败'); }
  finally { button.disabled = false; }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-model-option]');
  if (!button || button.disabled) return;
  const nextModel = button.dataset.modelOption;
  if (nextModel === settings.model) {
    $('[data-model-sheet]').hidden = true;
    return;
  }
  button.disabled = true;
  try {
    const remote = await ethereApi.updateSettings({ model: nextModel });
    settings.model = remote.model || nextModel;
    $('[data-model-label]').textContent = MODEL_LABELS[settings.model] || settings.model;
    writeJson('ethere.settings', settings);
    $('[data-model-sheet]').hidden = true;
    await syncChatEvents();
  } catch (error) {
    showToast(error.message);
    setConnectionState(false);
  } finally {
    button.disabled = false;
  }
});
$('[data-open-checkin-picker]').addEventListener('click', () => { draftCheckinMin = settings.checkinMin; draftCheckinMax = settings.checkinMax; $('[data-checkin-enabled]').checked = settings.checkinEnabled === true; $('[data-checkin-min-value]').textContent = draftCheckinMin; $('[data-checkin-max-value]').textContent = draftCheckinMax; $('[data-checkin-sheet]').hidden = false; });
$$('[data-close-checkin-sheet]').forEach((button) => button.addEventListener('click', () => { $('[data-checkin-sheet]').hidden = true; }));
$$('[data-checkin-step]').forEach((button) => button.addEventListener('click', () => { const [target, delta] = button.dataset.checkinStep.split(':'); if (target === 'min') draftCheckinMin = Math.max(5, Math.min(draftCheckinMax - 5, draftCheckinMin + Number(delta))); else draftCheckinMax = Math.min(1440, Math.max(draftCheckinMin + 5, draftCheckinMax + Number(delta))); $('[data-checkin-min-value]').textContent = draftCheckinMin; $('[data-checkin-max-value]').textContent = draftCheckinMax; }));
$('[data-apply-checkin]').addEventListener('click', async (event) => {
  if (!connected) return showToast('电脑端未连接，暂时无法保存');
  const button = event.currentTarget;
  if (button.disabled) return;
  const enabled = $('[data-checkin-enabled]').checked;
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    const remote = await ethereApi.updateSettings({
      checkin: { enabled, minMinutes: draftCheckinMin, maxMinutes: draftCheckinMax },
    });
    settings.checkinEnabled = remote.checkin?.enabled === true;
    settings.checkinMin = remote.checkin?.minMinutes || draftCheckinMin;
    settings.checkinMax = remote.checkin?.maxMinutes || draftCheckinMax;
    $('[data-checkin-label]').textContent = `${settings.checkinEnabled ? '' : '已关闭 · '}${settings.checkinMin}–${settings.checkinMax} 分钟`;
    writeJson('ethere.settings', settings);
    $('[data-checkin-sheet]').hidden = true;
    const next = eventClock(remote.checkin?.nextAt);
    showToast(settings.checkinEnabled && next ? `已保存 · 下次约 ${next}` : settings.checkinEnabled ? '已保存' : '已保存 · 主动联系已关闭');
  } catch (error) {
    showToast(error.message);
    setConnectionState(false);
  } finally {
    button.disabled = false;
    button.textContent = '保存';
  }
});
let didaLoginPoll = 0;
function didaSummary(projects, fallback) {
  if (!projects?.length) return fallback;
  if (projects.length === 1) return projects[0].name;
  return `${projects[0].name} 等 ${projects.length} 个`;
}
async function loadDidaSettings() {
  const connection = $('[data-dida-connection]');
  const summary = $('[data-dida-summary]');
  const list = $('[data-dida-project-list]');
  connection.textContent = '正在检查…';
  try {
    const status = await ethereApi.didaStatus();
    connection.textContent = status.connected ? '已连接' : '未连接';
    $('[data-dida-login]').textContent = status.connected ? '重新连接' : '连接账号';
    const selectedIds = new Set((status.supervisedProjects || []).map((project) => project.id));
    summary.textContent = didaSummary(status.supervisedProjects, status.connected ? '请选择清单' : '未连接');
    if (!status.connected) {
      list.innerHTML = '<p>连接账号后选择清单</p>';
      return false;
    }
    const result = await ethereApi.didaProjects();
    list.innerHTML = (result.projects || []).map((project) => `<button type="button" data-select-dida-project="${escapeHtml(project.id)}" class="${selectedIds.has(project.id) ? 'is-active' : ''}"><span>${escapeHtml(project.name)}</span><i aria-hidden="true"></i></button>`).join('') || '<p>没有读取到可用清单</p>';
    return true;
  } catch (error) {
    connection.textContent = '连接异常';
    list.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    return false;
  }
}
$('[data-open-dida-settings]').addEventListener('click', async () => {
  $('[data-dida-settings]').hidden = false;
  enterSubpage();
  await loadDidaSettings();
});
$('[data-close-dida-settings]').addEventListener('click', () => {
  window.clearInterval(didaLoginPoll);
  $('[data-dida-settings]').hidden = true;
  leaveSubpage();
});
$('[data-dida-login]').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (button.disabled) return;
  const authWindow = window.open('about:blank', '_blank');
  button.disabled = true;
  button.textContent = '正在打开…';
  try {
    const result = await ethereApi.startDidaLogin();
    if (!result.authorizationUrl) throw new Error('没有获得登录地址');
    if (authWindow) authWindow.location.href = result.authorizationUrl;
    else window.location.href = result.authorizationUrl;
    window.clearInterval(didaLoginPoll);
    didaLoginPoll = window.setInterval(async () => {
      if (await loadDidaSettings()) window.clearInterval(didaLoginPoll);
    }, 2_000);
  } catch (error) {
    authWindow?.close();
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = '重新连接';
  }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-select-dida-project]');
  if (!button || button.disabled) return;
  const buttons = $$('[data-select-dida-project]');
  const nextIds = buttons.filter((item) => item.classList.contains('is-active') !== (item === button)).map((item) => item.dataset.selectDidaProject);
  if (!nextIds.length) return showToast('请至少保留一个监督清单');
  buttons.forEach((item) => { item.disabled = true; });
  try {
    const result = await ethereApi.selectDidaProjects(nextIds);
    const savedIds = new Set(result.supervisedProjects.map((project) => project.id));
    $('[data-dida-summary]').textContent = didaSummary(result.supervisedProjects, '请选择清单');
    buttons.forEach((item) => item.classList.toggle('is-active', savedIds.has(item.dataset.selectDidaProject)));
    showToast('监督清单已保存');
  } catch (error) {
    showToast(error.message);
  } finally {
    buttons.forEach((item) => { item.disabled = false; });
  }
});
function reminderTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
function setReminderCount(count) { $('[data-reminder-count]').textContent = count > 0 ? String(count) : ''; }
async function refreshReminderCount() {
  const result = await ethereApi.reminders('scheduled');
  setReminderCount(result.reminders?.length || 0);
}
let reminderLoadRequest = 0;
async function loadReminders({ showLoading = true } = {}) {
  const list = $('[data-reminder-list]');
  const requestId = ++reminderLoadRequest;
  if (showLoading) list.innerHTML = '<p class="reminder-empty">正在读取…</p>';
  try {
    const result = await ethereApi.reminders('scheduled');
    if (requestId !== reminderLoadRequest) return;
    const reminders = sortRemindersForDisplay(result.reminders || []);
    const scheduled = reminders.filter((item) => item.status === 'scheduled');
    setReminderCount(scheduled.length);
    if (!reminders.length) {
      list.innerHTML = '<p class="reminder-empty">现在没有进行中的提醒</p>';
      return;
    }
    list.innerHTML = reminders.map((item) => {
      const status = item.status === 'scheduled' ? (item.dailyAt ? '已启用' : '待触发') : item.status === 'completed' ? '已完成' : '已取消';
      const relation = item.relatedTaskTitle ? `<p class="reminder-relation">滴答 · ${escapeHtml(item.relatedTaskTitle)}</p>` : '';
      const repeat = item.dailyAt ? `<span>每天 ${escapeHtml(item.dailyAt)}</span>` : item.repeatMinutes ? `<span>每 ${item.repeatMinutes} 分钟复查</span>` : '';
      const action = item.status === 'scheduled' ? `<button type="button" data-cancel-reminder="${escapeHtml(item.id)}" data-reminder-revision="${item.revision}">取消</button>` : '';
      const footer = repeat || action ? `<footer>${repeat}${action}</footer>` : '';
      const nextLabel = item.dailyAt && item.status === 'scheduled' ? `下次 ${reminderTime(item.triggerAt)}` : reminderTime(item.triggerAt);
      return `<article class="reminder-card reminder-card--${escapeHtml(item.status)}"><header><time>${escapeHtml(nextLabel)}</time><span>${status}</span></header><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.message)}</p>${relation}${footer}</article>`;
    }).join('');
  } catch (error) {
    if (requestId !== reminderLoadRequest) return;
    list.innerHTML = `<p class="reminder-empty">${escapeHtml(error.message)}</p>`;
  }
}
$('[data-open-reminders]').addEventListener('click', async () => {
  $('[data-reminder-manager]').hidden = false;
  enterSubpage();
  await loadReminders();
});
$('[data-close-reminders]').addEventListener('click', () => { $('[data-reminder-manager]').hidden = true; leaveSubpage(); });
$('[data-refresh-reminders]').addEventListener('click', () => { void loadReminders(); });
async function loadStudyPlans() {
  const list = $('[data-study-plan-list]');
  list.innerHTML = '<p class="reminder-empty">正在读取…</p>';
  try {
    const { plans = [] } = await ethereApi.studyPlans();
    if (!plans.length) {
      list.innerHTML = `<p class="study-empty">还没有学习计划。想系统学什么，直接在聊天里告诉 ${escapeHtml(bossName)}。</p>`;
      return;
    }
    list.innerHTML = plans.map((plan) => {
      const state = plan.status === 'completed' ? '已学完' : plan.status === 'paused' ? '已暂停' : '学习中';
      const next = plan.currentLessonTitle ? `下一节 · ${escapeHtml(plan.currentLessonTitle)}` : '可以回顾已学内容';
      return `<article class="study-plan-card"><button class="study-plan-card__main" type="button" data-study-open="${escapeHtml(plan.id)}" aria-expanded="false"><span><strong>${escapeHtml(plan.title)}</strong><small>${escapeHtml(state)} · ${plan.completedCount}/${plan.lessonCount} 节</small></span><b aria-hidden="true">⌄</b></button><p>${next}</p>${plan.checkpoint ? `<p class="study-plan-checkpoint">接着讲：${escapeHtml(plan.checkpoint)}</p>` : ''}<div class="study-plan-lessons" data-study-details="${escapeHtml(plan.id)}" hidden></div><button class="study-plan-continue" type="button" data-continue-study="${escapeHtml(plan.id)}" data-study-title="${escapeHtml(plan.title)}">继续学习</button></article>`;
    }).join('');
  } catch (error) { list.innerHTML = `<p class="study-empty">${escapeHtml(error.message)}</p>`; }
}
$('[data-open-study-plans]').addEventListener('click', async () => {
  $('[data-study-manager]').hidden = false;
  enterSubpage();
  await loadStudyPlans();
});
$('[data-close-study-plans]').addEventListener('click', () => { $('[data-study-manager]').hidden = true; leaveSubpage(); });
$('[data-study-plan-list]').addEventListener('click', async (event) => {
  const continueButton = event.target.closest('[data-continue-study]');
  if (continueButton) {
    const title = continueButton.dataset.studyTitle;
    $('[data-study-manager]').hidden = true;
    leaveSubpage();
    setView('chat');
    input.value = `继续学习「${title}」，先看看我们讲到哪里，再从上次的暂停点接着讲。`;
    resizeComposer();
    input.focus();
    return;
  }
  const button = event.target.closest('[data-study-open]');
  if (!button) return;
  const details = $('[data-study-details="' + button.dataset.studyOpen + '"]');
  if (!details.hidden) { details.hidden = true; button.setAttribute('aria-expanded', 'false'); return; }
  details.innerHTML = '<p>正在读取提纲…</p>';
  details.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  try {
    const { plan } = await ethereApi.studyPlan(button.dataset.studyOpen);
    details.innerHTML = `<ol>${plan.lessons.map((lesson) => `<li class="${lesson.status === 'done' ? 'is-done' : lesson.id === plan.currentLessonId ? 'is-current' : ''}"><span>${escapeHtml(lesson.title)}</span>${lesson.status === 'done' ? '<small>已学</small>' : ''}</li>`).join('')}</ol>`;
  } catch (error) { details.innerHTML = `<p>${escapeHtml(error.message)}</p>`; }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-cancel-reminder]');
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    await ethereApi.cancelReminder(button.dataset.cancelReminder, Number(button.dataset.reminderRevision));
    showToast('提醒已取消');
    await loadReminders();
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
});
$('[data-open-chat-history]').addEventListener('click', async () => {
  if (!connected) return showToast('电脑端未连接，无法读取聊天记录');
  $('[data-chat-history]').hidden = false;
  enterSubpage();
  historyDate = '';
  historySearch = '';
  $('[data-chat-history-search]').value = '';
  $('[data-history-date-label]').textContent = '';
  await loadChatHistory({ reset: true });
});
$('[data-close-chat-history]').addEventListener('click', () => { $('[data-chat-history]').hidden = true; leaveSubpage(); });
$('[data-chat-history-search]').addEventListener('input', (event) => {
  window.clearTimeout(historySearchTimer);
  historySearchTimer = window.setTimeout(() => { historySearch = event.target.value.trim(); void loadChatHistory({ reset: true }); }, 280);
});
$('[data-open-history-date]').addEventListener('click', () => {
  const selected = historyDate ? dateFromIso(historyDate) : new Date();
  historyPickerMonth = new Date(selected.getFullYear(), selected.getMonth(), 1);
  renderHistoryDatePicker();
  $('[data-history-date-sheet]').hidden = false;
});
$$('[data-close-history-date]').forEach((button) => button.addEventListener('click', () => { $('[data-history-date-sheet]').hidden = true; }));
$('[data-load-older-history]').addEventListener('click', async () => { await loadChatHistory({ reset: false }); });
$('[data-open-context-settings]').addEventListener('click', () => { $('[data-context-settings]').hidden = false; });
$('[data-close-context-settings]').addEventListener('click', () => { $('[data-context-settings]').hidden = true; });
$('[data-compact-thread]').addEventListener('click', async (event) => {
  if (!connected) return showToast('电脑端未连接，无法压缩');
  const button = event.currentTarget;
  const label = button.querySelector('strong');
  button.disabled = true;
  if (label) label.textContent = '正在压缩…';
  showToast('正在压缩上下文…', 10 * 60_000);
  try {
    await ethereApi.compactThread();
    await syncChatEvents();
    showToast('压缩完成');
  } catch (error) {
    await syncChatEvents().catch(() => {});
    showToast(error.message);
    if (!error.status) setConnectionState(false);
  } finally {
    button.disabled = false;
    if (label) label.textContent = '压缩当前上下文';
  }
});
$('[data-request-new-thread]').addEventListener('click', () => { $('[data-new-thread-sheet]').hidden = false; });
$$('[data-close-new-thread]').forEach((button) => button.addEventListener('click', () => { $('[data-new-thread-sheet]').hidden = true; }));
$('[data-close-approval-edit]').addEventListener('click', closeApprovalEdit);
$('[data-close-memory-approval-edit]').addEventListener('click', closeApprovalEdit);
$('[data-approval-level]').addEventListener('click', (event) => {
  const option = event.target.closest('[data-approval-level-option]');
  if (!option || !approvalDraft) return;
  approvalDraft.level = option.dataset.approvalLevelOption;
  renderApprovalEditSheet();
});
$('[data-approval-parent-options]').addEventListener('click', (event) => {
  const option = event.target.closest('[data-approval-parent]');
  if (!option || !approvalDraft) return;
  approvalDraft.parentCategoryId = option.dataset.approvalParent;
  renderApprovalEditSheet();
});
$('[data-approval-color-options]').addEventListener('click', (event) => {
  const option = event.target.closest('[data-approval-color]');
  if (!option || !approvalDraft) return;
  approvalDraft.color = option.dataset.approvalColor;
  renderApprovalEditSheet();
});
$('[data-approval-edit-form]').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!approvalDraft || !approvalEditMessageId) return;
  const name = $('[data-approval-name]').value.trim();
  if (!name) return showToast('请输入分类名称');
  if (approvalDraft.level === 'secondary' && !approvalDraft.parentCategoryId) return showToast('请选择所属一级分类');
  const button = event.currentTarget.querySelector('[type="submit"]');
  button.disabled = true;
  await resolveChatApproval(approvalEditMessageId, 'accept', { ...approvalDraft, name });
  button.disabled = false;
  closeApprovalEdit();
});
$('[data-memory-approval-edit-form]').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!approvalDraft || !approvalEditMessageId) return;
  const title = $('[data-memory-approval-title]').value.trim();
  const contentMarkdown = $('[data-memory-approval-content]').value.trim();
  if (!title || !contentMarkdown) return showToast(!title ? '请输入记忆主题' : '请输入记忆内容');
  const button = event.currentTarget.querySelector('[type="submit"]');
  button.disabled = true;
  const saved = await resolveChatApproval(approvalEditMessageId, 'accept', { title, contentMarkdown }, { keepSeparate: $('[data-memory-approval-separate]').checked });
  button.disabled = false;
  if (saved) closeApprovalEdit();
});
$('[data-start-new-thread]').addEventListener('click', async (event) => {
  if (!connected) return showToast('电脑端未连接，无法开始新线程');
  const button = event.currentTarget;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = '正在切换…';
  showToast('正在切换对话线程…', 30_000);
  try {
    await ethereApi.startNewThread();
    $('[data-new-thread-sheet]').hidden = true;
    $('[data-context-settings]').hidden = true;
    setView('chat');
    await syncChatEvents();
    showToast('已开始新线程');
  } catch (error) {
    showToast(error.message);
    if (!error.status) setConnectionState(false);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
});
$$('[data-theme-choice]').forEach((button) => button.addEventListener('click', () => applyTheme(button.dataset.themeChoice)));

let activeDocument = '';
function formatDateTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '旧版本' : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date); }
let activeDocumentRevision = '';
let activeDocumentSavedText = '';
$$('[data-settings-document]').forEach((button) => button.addEventListener('click', async () => { activeDocument = button.dataset.settingsDocument; const key = `ethere.document.${activeDocument}`; const titles = { persona: '人设', operations: '工具使用规则' }; const localDraft = storage.getItem(key) || ''; $('[data-settings-document-title]').textContent = titles[activeDocument]; $('[data-settings-document-input]').value = localDraft; $('[data-settings-editor]').hidden = false; enterSubpage(); if (connected) { try { const document = await ethereApi.readDocument(activeDocument); const serverText = document?.text || ''; $('[data-settings-document-input]').value = serverText; activeDocumentRevision = document?.revision || ''; activeDocumentSavedText = serverText; storage.setItem(key, serverText); } catch { setConnectionState(false); } } }));
$('[data-open-document-history]').addEventListener('click', async () => {
  if (!connected) return showToast('电脑端未连接，无法查看历史版本');
  try {
    const { versions } = await ethereApi.documentHistory(activeDocument);
    $('[data-document-history-list]').innerHTML = versions.map((version, index) => `<div class="document-history-row"><div><strong>${index === 0 ? '当前版本' : formatDateTime(version.savedAt)}</strong><span>${escapeHtml(version.text.slice(0, 72))}${version.text.length > 72 ? '…' : ''}</span></div><button type="button" data-restore-document-revision="${escapeHtml(version.revision)}" ${version.revision === activeDocumentRevision ? 'disabled' : ''}>恢复</button></div>`).join('') || '<p class="empty-state">还没有历史版本</p>';
    $('[data-document-history-sheet]').hidden = false;
  } catch (error) { showToast(error.message || '历史版本读取失败'); }
});
$('[data-close-document-history]').addEventListener('click', () => { $('[data-document-history-sheet]').hidden = true; });
$('[data-document-history-list]').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-restore-document-revision]');
  if (!button || button.disabled) return;
  if ($('[data-settings-document-input]').value !== activeDocumentSavedText) return showToast('请先保存或放弃当前编辑，再恢复历史版本');
  button.disabled = true;
  try {
    const saved = await ethereApi.restoreDocument(activeDocument, button.dataset.restoreDocumentRevision, activeDocumentRevision);
    activeDocumentRevision = saved.revision;
    activeDocumentSavedText = saved.text;
    $('[data-settings-document-input]').value = saved.text;
    storage.setItem(`ethere.document.${activeDocument}`, saved.text);
    $('[data-document-history-sheet]').hidden = true;
    showToast(saved.application?.applied ? '已恢复并应用' : '已恢复 · 当前线程尚未刷新');
  } catch (error) { showToast(error.message || '恢复失败'); button.disabled = false; }
});

async function permissionStatus(kind) {
  if (nativePermissions?.getPermissionStatus) {
    try { return nativeStatusValue(await nativePermissions.getPermissionStatus({ kind })); } catch { return 'denied'; }
  }
  if (kind === 'notifications' && 'Notification' in window) return Notification.permission;
  return 'unavailable';
}

function renderPermissionAction(selector, value) {
  const button = $(selector);
  button.textContent = value === 'granted' ? '已授权' : value === 'unavailable' ? '不可用' : '去授权';
  button.disabled = value === 'granted' || value === 'unavailable';
}

async function refreshPermissionStatus({ syncUsage = false } = {}) {
  if (syncUsage && nativePermissions?.collectUsageSnapshot && connected) {
    try {
      const usageStatus = await permissionStatus('usage');
      if (usageStatus === 'granted') await ethereApi.savePhoneUsageSnapshot(await nativePermissions.collectUsageSnapshot());
    } catch { /* 权限页仍可继续显示现有状态。 */ }
  }
  const [usage, notifications, background, overlay, microphone, exactAlarm, fullScreenCall, data] = await Promise.all([permissionStatus('usage'), permissionStatus('notifications'), permissionStatus('background'), permissionStatus('overlay'), permissionStatus('microphone'), permissionStatus('exactAlarm'), permissionStatus('fullScreenCall'), connected ? ethereApi.phoneUsageStatus().catch(() => null) : null]);
  renderPermissionAction('[data-request-usage-permission]', usage);
  renderPermissionAction('[data-request-notification-permission]', notifications);
  renderPermissionAction('[data-request-background-permission]', background);
  renderPermissionAction('[data-request-overlay-permission]', overlay);
  renderPermissionAction('[data-request-microphone-permission]', microphone);
  renderPermissionAction('[data-request-exact-alarm-permission]', exactAlarm);
  renderPermissionAction('[data-request-full-screen-call-permission]', fullScreenCall);
  $('[data-phone-usage-data-status]').textContent = data?.dataUpdatedAt ? `最后更新：${new Date(data.dataUpdatedAt).toLocaleString('zh-CN', { hour12: false })}` : '尚未从手机同步';
  const granted = [usage, notifications, background].filter((status) => status === 'granted').length;
  $('[data-permission-summary]').textContent = nativePermissions?.getPermissionStatus ? granted === 3 ? '已授权' : `${granted}/3 已授权` : '手机端查看';
}

$('[data-open-permissions]').addEventListener('click', async () => { $('[data-permissions-manager]').hidden = false; enterSubpage(); await refreshPermissionStatus({ syncUsage: true }); });
$('[data-close-permissions]').addEventListener('click', () => { $('[data-permissions-manager]').hidden = true; leaveSubpage(); });
$('[data-request-usage-permission]').addEventListener('click', async () => { if (!nativePermissions?.requestUsageAccess) return showToast('请安装 Android 版后授权'); await nativePermissions.requestUsageAccess(); window.setTimeout(refreshPermissionStatus, 900); });
$('[data-request-background-permission]').addEventListener('click', async () => { if (!nativePermissions?.requestBackgroundAccess) return showToast('请安装 Android 版后设置'); await nativePermissions.requestBackgroundAccess(); window.setTimeout(refreshPermissionStatus, 900); });
for (const [selector, method] of [
  ['[data-request-overlay-permission]', 'requestOverlayAccess'],
  ['[data-request-microphone-permission]', 'requestMicrophonePermission'],
  ['[data-request-exact-alarm-permission]', 'requestExactAlarmAccess'],
  ['[data-request-full-screen-call-permission]', 'requestFullScreenCallAccess'],
]) {
  $(selector).addEventListener('click', async () => {
    if (!nativePermissions?.[method]) return showToast('请安装新版 Android 应用后授权');
    try { await nativePermissions[method](); } catch (error) { showToast(error.message || '无法打开权限设置'); }
    window.setTimeout(refreshPermissionStatus, 900);
  });
}
$('[data-request-notification-permission]').addEventListener('click', async () => {
  if (nativePermissions?.requestNotificationPermission) {
    const result = await nativePermissions.requestNotificationPermission();
    if (nativeStatusValue(result) === 'granted' && nativePermissions.showNotification) {
      await nativePermissions.showNotification({ title: bossName, body: '通知已开启，之后的主动消息会从这里提醒你。' });
      await startNativeNotificationStream();
    }
  } else if ('Notification' in window) await Notification.requestPermission();
  await refreshPermissionStatus();
});
$('[data-close-settings-document]').addEventListener('click', () => { $('[data-settings-editor]').hidden = true; leaveSubpage(); });
$('[data-settings-document-form]').addEventListener('submit', async (event) => { event.preventDefault(); const text = $('[data-settings-document-input]').value; storage.setItem(`ethere.document.${activeDocument}`, text); if (!connected) return showToast('已保存为本机草稿，连接电脑后再保存一次'); try { const saved = await ethereApi.saveDocument(activeDocument, text, activeDocumentRevision); activeDocumentRevision = saved.revision; activeDocumentSavedText = text; $('[data-settings-editor]').hidden = true; leaveSubpage(); if (!['persona', 'operations'].includes(activeDocument)) return showToast('已保存'); if (saved.application?.applied) return showToast('已保存并应用'); if (saved.application?.status === 'pending-new-thread') return showToast('已保存 · 将在新线程应用'); showToast('已保存到电脑 · 尚未应用'); } catch (error) { showToast(error.message); } });

$$('[data-range]').forEach((button) => button.addEventListener('click', () => { if (button.dataset.range === 'custom') return openPeriodPicker('custom'); activeRange = button.dataset.range; $$('[data-range]').forEach((item) => item.classList.toggle('is-active', item === button)); renderTimeline(); }));
$$('[data-period-step]').forEach((button) => button.addEventListener('click', () => stepPeriod(button.dataset.periodStep === 'previous' ? -1 : 1)));
$('[data-open-period-picker]').addEventListener('click', () => openPeriodPicker(activeRange));
$$('[data-close-period-picker]').forEach((button) => button.addEventListener('click', closePeriodPicker));
$('[data-space-time-filter]').addEventListener('click', () => { $('[data-space-time-body]').innerHTML = spaceTimeOptionsMarkup(); $('[data-space-time-sheet]').hidden = false; });
$$('[data-close-space-time]').forEach((button) => button.addEventListener('click', () => { $('[data-space-time-sheet]').hidden = true; }));
$('[data-distribution-toggle]').addEventListener('click', () => { if (activeRange !== 'day') return; dayStatsExpanded = !dayStatsExpanded; const stats = $('[data-timeline-mode="stats"]'); stats.hidden = !dayStatsExpanded; $('[data-distribution-toggle]').classList.toggle('is-stats', dayStatsExpanded); $('[data-distribution-toggle]').setAttribute('aria-expanded', String(dayStatsExpanded)); });
$('[data-edit-review]').addEventListener('click', () => { $('[data-review-input]').value = timelineReview?.text || ''; $('[data-review-editor]').hidden = false; enterSubpage(); });
$('[data-close-review]').addEventListener('click', () => { $('[data-review-editor]').hidden = true; leaveSubpage(); });
$('[data-review-form]').addEventListener('submit', async (event) => { event.preventDefault(); if (!connected) return showToast('电脑端未连接，无法保存'); const button = event.currentTarget.querySelector('[type="submit"]'); if (button.disabled) return; button.disabled = true; try { const result = await ethereApi.saveTimelineReview(isoDate(timelineDate), { text: $('[data-review-input]').value, author: 'user', baseRevision: timelineReview?.revision || 0, mutationId: mutationId('timeline_review') }); timelineReview = result.review; $('[data-review-editor]').hidden = true; leaveSubpage(); renderTimelineData(); showToast('已保存'); } catch (error) { showToast(error.message || '保存失败'); } finally { button.disabled = false; } });
$('[data-add-timeline-event]').addEventListener('click', () => openTimelineEventEditor());
$('[data-close-timeline-event]').addEventListener('click', closeTimelineEventEditor);
$('[data-timeline-event-form]').addEventListener('submit', async (event) => { event.preventDefault(); const button = event.currentTarget.querySelector('[type="submit"]'); if (button.disabled) return; button.disabled = true; try { await saveTimelineEvent(); } catch (error) { showToast(error.message || '保存失败'); } finally { button.disabled = false; } });
$('[data-open-event-category]').addEventListener('click', () => { renderEventCategoryOptions(); $('[data-event-category-sheet]').hidden = false; });
$$('[data-close-event-category]').forEach((button) => button.addEventListener('click', () => { $('[data-event-category-sheet]').hidden = true; }));
$$('[data-open-event-time]').forEach((button) => button.addEventListener('click', () => openEventTimePicker(button.dataset.openEventTime)));
$$('[data-close-event-time]').forEach((button) => button.addEventListener('click', closeEventTimePicker));
$('[data-event-hour-wheel]').addEventListener('scroll', (event) => updateEventTimeFromWheel(event.currentTarget, 'hour'), { passive: true });
$('[data-event-minute-wheel]').addEventListener('scroll', (event) => updateEventTimeFromWheel(event.currentTarget, 'minute'), { passive: true });
$('[data-apply-event-time]').addEventListener('click', () => {
  const value = `${twoDigits(eventTimeHour % 24)}:${twoDigits(eventTimeMinute)}`;
  $(`[data-timeline-event-${eventTimeTarget}]`).value = value;
  if (eventTimeTarget === 'end') $('[data-timeline-event-end-day]').value = Number(eventTimeHour >= 24);
  syncTimelineTimeLabels();
  closeEventTimePicker();
});
$('[data-delete-timeline-event]').addEventListener('click', () => { $('[data-event-delete-sheet]').hidden = false; });
$$('[data-close-event-delete]').forEach((button) => button.addEventListener('click', () => { $('[data-event-delete-sheet]').hidden = true; }));
$('[data-confirm-event-delete]').addEventListener('click', async () => { try { await archiveTimelineEvent(); } catch (error) { showToast(error.message || '删除失败'); } });

document.addEventListener('click', async (event) => {
  const approvalAccept = event.target.closest('[data-approval-accept]'); if (approvalAccept) void resolveChatApproval(approvalAccept.dataset.approvalAccept, 'accept');
  const approvalEdit = event.target.closest('[data-approval-edit]'); if (approvalEdit) void openApprovalEdit(approvalEdit.dataset.approvalEdit);
  const approvalReject = event.target.closest('[data-approval-reject]'); if (approvalReject) void resolveChatApproval(approvalReject.dataset.approvalReject, 'reject');
  const timeOption = event.target.closest('[data-event-time-hour],[data-event-time-minute]'); if (timeOption) { const kind = timeOption.hasAttribute('data-event-time-hour') ? 'hour' : 'minute'; const wheel = timeOption.closest('.event-time-wheel'); centerEventTimeOption(wheel, `[data-event-time-${kind}="${timeOption.dataset[`eventTime${kind[0].toUpperCase()}${kind.slice(1)}`]}"]`); }
  const rankingToggle = event.target.closest('[data-ranking-toggle]'); if (rankingToggle) { const id = rankingToggle.dataset.rankingToggle; const row = rankingToggle.closest('[data-ranking-category]'); const children = row?.querySelector('.ranking-children'); const expanded = !rankingToggle.getAttribute('aria-expanded').includes('true'); rankingToggle.setAttribute('aria-expanded', String(expanded)); row?.classList.toggle('is-expanded', expanded); if (children) children.hidden = !expanded; if (expanded) expandedRankingCategories.add(id); else expandedRankingCategories.delete(id); }
  const toastButton = event.target.closest('[data-toast-action]'); if (toastButton && toastAction) { const action = toastAction; toastAction = null; window.clearTimeout(toastTimer); Promise.resolve(action.run()).catch((error) => showToast(error.message || '操作失败')); }
  const reviewExpand = event.target.closest('[data-review-expand]'); if (reviewExpand) { const copy = $('[data-review-text]'); const expanding = copy.classList.contains('is-collapsed'); copy.classList.toggle('is-collapsed', !expanding); reviewExpand.textContent = expanding ? '收起' : '展开'; }
  const editTimeline = event.target.closest('[data-edit-timeline-event]'); if (editTimeline) { const item = timelineEvents.find((entry) => entry.id === editTimeline.dataset.editTimelineEvent); if (item) openTimelineEventEditor(item); }
  const categoryChoice = event.target.closest('[data-event-category]'); if (categoryChoice) { setTimelineDraftCategory(categoryChoice.dataset.eventCategory, categoryChoice.dataset.eventSubcategory); $('[data-event-category-sheet]').hidden = true; }
  const retryMessage = event.target.closest('[data-retry-message]'); if (retryMessage) { const message = messages.find((item) => item.id === retryMessage.dataset.retryMessage); if (message && message.status === 'failed') { messages = [...messages.filter((item) => item.id !== message.id), { ...message, status: 'sending', occurredAt: new Date().toISOString(), createdAt: currentTime() }]; chatStore.write(messages); renderMessages(); scrollToLatest(); pendingChatSends.push({ message: message.content, images: (message.attachments || []).filter((item) => item.type === 'image'), files: (message.attachments || []).filter((item) => item.type === 'file').map((item) => item.id), messageId: message.id, quote: message.quote || null }); if (currentChatRequest) void ethereApi.interruptChat().catch(() => {}); void runChatSendLoop(); } }
  const copyMessage = event.target.closest('[data-copy-message]'); if (copyMessage) { const message = messages.find((item) => item.id === copyMessage.dataset.copyMessage); if (message?.content) void navigator.clipboard.writeText(message.content).then(() => showToast('已复制')).catch(() => showToast('复制失败')); }
  const copyHistory = event.target.closest('[data-copy-history]'); if (copyHistory) { const record = historyEvents.find((item) => item.id === copyHistory.dataset.copyHistory); if (record?.content) void navigator.clipboard.writeText(record.content).then(() => showToast('已复制')).catch(() => showToast('复制失败')); }
  const pickerReturn = event.target.closest('[data-picker-return-current]'); if (pickerReturn) { pendingPeriodDate = new Date(); if (pickerMode === 'week' || pickerMode === 'month') renderPeriodPicker(); else { timelineDate = new Date(); activeRange = pickerMode; $$('[data-range]').forEach((item) => item.classList.toggle('is-active', item.dataset.range === activeRange)); closePeriodPicker(); renderTimeline(); } }
  const pickerMonthStep = event.target.closest('[data-picker-month-step]'); if (pickerMonthStep) { pickerMonth = new Date(pickerMonth.getFullYear(), pickerMonth.getMonth() + Number(pickerMonthStep.dataset.pickerMonthStep), 1); renderPeriodPicker(); }
  const pickerDate = event.target.closest('[data-picker-date]'); if (pickerDate) { const selected = dateFromIso(pickerDate.dataset.pickerDate); if (pickerMode === 'day') { timelineDate = selected; activeRange = 'day'; $$('[data-range]').forEach((item) => item.classList.toggle('is-active', item.dataset.range === 'day')); closePeriodPicker(); renderTimeline(); } else if (customPickerStep === 'start') { pendingCustomStart = selected; pendingCustomEnd = null; renderPeriodPicker(); } else { pendingCustomEnd = selected; renderPeriodPicker(); } }
  const customNext = event.target.closest('[data-custom-picker-next]'); if (customNext && !customNext.disabled) { if (customPickerStep === 'start') { customPickerStep = 'end'; pickerMonth = new Date(pendingCustomStart.getFullYear(), pendingCustomStart.getMonth(), 1); renderPeriodPicker(); } else { customRangeStart = pendingCustomStart; customRangeEnd = pendingCustomEnd; timelineDate = customRangeStart; activeRange = 'custom'; $$('[data-range]').forEach((item) => item.classList.toggle('is-active', item.dataset.range === 'custom')); closePeriodPicker(); renderTimeline(); } }
  const pickerWeek = event.target.closest('[data-picker-week]'); if (pickerWeek) { pendingPeriodDate = dateFromIso(pickerWeek.dataset.pickerWeek); centerEventTimeOption(pickerWeek.closest('.period-wheel'), `[data-picker-week="${pickerWeek.dataset.pickerWeek}"]`); }
  const pickerMonthChoice = event.target.closest('[data-picker-month]'); if (pickerMonthChoice) { pendingPeriodDate = dateFromIso(pickerMonthChoice.dataset.pickerMonth); centerEventTimeOption(pickerMonthChoice.closest('.period-wheel'), `[data-picker-month="${pickerMonthChoice.dataset.pickerMonth}"]`); }
  const applyPeriod = event.target.closest('[data-apply-period]'); if (applyPeriod) { timelineDate = new Date(pendingPeriodDate); activeRange = pickerMode; $$('[data-range]').forEach((item) => item.classList.toggle('is-active', item.dataset.range === activeRange)); closePeriodPicker(); renderTimeline(); }
  const historyMonthStep = event.target.closest('[data-history-month-step]'); if (historyMonthStep) { historyPickerMonth = new Date(historyPickerMonth.getFullYear(), historyPickerMonth.getMonth() + Number(historyMonthStep.dataset.historyMonthStep), 1); renderHistoryDatePicker(); }
  const historyDateChoice = event.target.closest('[data-history-date]'); if (historyDateChoice) { historyDate = historyDateChoice.dataset.historyDate; $('[data-history-date-label]').textContent = formatDate(dateFromIso(historyDate)); $('[data-history-date-sheet]').hidden = true; void loadChatHistory({ reset: true }); }
  if (event.target.closest('[data-clear-history-date]')) { historyDate = ''; $('[data-history-date-label]').textContent = ''; $('[data-history-date-sheet]').hidden = true; void loadChatHistory({ reset: true }); }
  const spaceDays = event.target.closest('[data-space-days]'); if (spaceDays) { if (spaceDays.dataset.spaceDays === 'custom') { spacePendingStart = null; spacePendingEnd = null; spaceCustomStep = 'start'; spacePickerMonth = new Date(); renderSpaceCustomPicker(); } else { spaceDayFilter = spaceDays.dataset.spaceDays; const label = spaceDayFilter === 'all' ? '' : `最近 ${spaceDayFilter} 天`; $('[data-space-time-label]').textContent = label; $('[data-space-time-filter]').setAttribute('aria-label', label ? `记录时间：${label}` : '筛选记录时间'); $('[data-space-time-sheet]').hidden = true; applySpaceFilters(); } }
  const spaceMonthStep = event.target.closest('[data-space-month-step]'); if (spaceMonthStep) { spacePickerMonth = new Date(spacePickerMonth.getFullYear(), spacePickerMonth.getMonth() + Number(spaceMonthStep.dataset.spaceMonthStep), 1); renderSpaceCustomPicker(); }
  const spaceDate = event.target.closest('[data-space-date]'); if (spaceDate) { const selected = dateFromIso(spaceDate.dataset.spaceDate); if (spaceCustomStep === 'start') { spacePendingStart = selected; spacePendingEnd = null; } else { spacePendingEnd = selected; } renderSpaceCustomPicker(); }
  const spaceCustomNext = event.target.closest('[data-space-custom-next]'); if (spaceCustomNext && !spaceCustomNext.disabled) { if (spaceCustomStep === 'start') { spaceCustomStep = 'end'; spacePickerMonth = new Date(spacePendingStart.getFullYear(), spacePendingStart.getMonth(), 1); renderSpaceCustomPicker(); } else { spaceCustomStart = spacePendingStart; spaceCustomEnd = spacePendingEnd; spaceDayFilter = 'custom'; const label = formatDateRange(spaceCustomStart, spaceCustomEnd); $('[data-space-time-label]').textContent = label; $('[data-space-time-filter]').setAttribute('aria-label', `记录时间：${label}`); $('[data-space-time-sheet]').hidden = true; applySpaceFilters(); } }
  const removeAttachment = event.target.closest('[data-remove-attachment]'); if (removeAttachment) { const [removed] = pendingAttachments.splice(Number(removeAttachment.dataset.removeAttachment), 1); if (removed?.originalPhotoId) void removeChatPhotoOriginal(removed.originalPhotoId).catch(() => {}); renderAttachment(); }
  const draftPhoto = event.target.closest('[data-chat-draft-photo]'); if (draftPhoto) { const selected = pendingAttachments[Number(draftPhoto.dataset.chatDraftPhoto)]; if (selected?.type === 'image') showChatLightbox(pendingAttachments, pendingAttachments.filter((item) => item.type === 'image').indexOf(selected)); }
  const chatPhoto = event.target.closest('[data-chat-photo]'); if (chatPhoto) { const message = messages.find((item) => item.id === chatPhoto.closest('[data-message-id]')?.dataset.messageId); if (message) showChatLightbox(message.attachments || [], Number(chatPhoto.dataset.chatPhoto)); }
  const filter = event.target.closest('[data-space-filter]'); if (filter) { spaceActorFilter = filter.dataset.spaceFilter; $$('[data-space-filter]').forEach((item) => item.classList.toggle('is-active', item === filter)); applySpaceFilters(); }
  const expand = event.target.closest('[data-space-expand]'); if (expand) { const copy = expand.previousElementSibling; const collapsed = copy.classList.toggle('is-collapsed'); expand.textContent = collapsed ? '展开' : '收起'; }
  const photo = event.target.closest('[data-space-photo]'); if (photo) { const strip = photo.closest('[data-drag-scroll]'); if (strip?.dataset.dragMoved === 'true') strip.dataset.dragMoved = ''; else openSpacePhoto(photo); }
  if (event.target.closest('[data-close-space-lightbox]') || event.target.matches('.space-lightbox-slide,.space-lightbox-track')) closeSpaceLightbox();
  const actions = event.target.closest('[data-space-actions]'); if (actions) { spaceActionPost = spacePosts.find((post) => post.id === actions.dataset.spaceActions) || null; $('[data-space-actions-sheet]').hidden = !spaceActionPost; }
  if (event.target.closest('[data-close-space-actions]')) { $('[data-space-actions-sheet]').hidden = true; spaceActionPost = null; }
  if (event.target.closest('[data-space-action-edit]') && spaceActionPost) { const post = spaceActionPost; $('[data-space-actions-sheet]').hidden = true; spaceActionPost = null; openSpaceEditor(post); }
  if (event.target.closest('[data-space-action-delete]') && spaceActionPost) {
    const post = spaceActionPost;
    $('[data-space-actions-sheet]').hidden = true;
    spaceActionPost = null;
    try { await ethereApi.deleteSpacePost(post.id, post.revision); await loadSpacePosts(); showToast('已删除'); }
    catch (error) { showToast(error.message || '删除失败'); }
  }
});

window.addEventListener('ethere:connection', (event) => { setConnectionState(Boolean(event.detail?.connected)); if (event.detail?.connected) { renderTimeline(); void loadSpacePosts(); } });
if (!nativeAndroidViewport) {
  window.visualViewport?.addEventListener('resize', () => document.documentElement.style.setProperty('--visual-height', `${window.visualViewport.height}px`));
}
function noteReadGesture() {
  if (performance.now() > readGestureUntil) readGestureStart = list.scrollTop;
  readGestureUntil = performance.now() + 900;
}
list.addEventListener('touchstart', noteReadGesture, { passive: true });
list.addEventListener('touchmove', noteReadGesture, { passive: true });
list.addEventListener('wheel', noteReadGesture, { passive: true });
list.addEventListener('scroll', () => {
  const readingDown = readGestureStart !== null && list.scrollTop > readGestureStart + 1 && performance.now() <= readGestureUntil;
  if (readingDown) readGestureUntil = performance.now() + 900;
  refreshJumpLatest();
  markVisibleUnread(readingDown ? readGestureStart : null);
  lastChatScrollTop = list.scrollTop;
}, { passive: true });
jumpLatestButton.addEventListener('click', () => scrollToLatest({ markRead: true }));
let keyboardSnapPending = false;
input.addEventListener('focus', () => {
  keyboardSnapPending = true;
  window.setTimeout(() => { if (keyboardSnapPending) { scrollToLatest(); keyboardSnapPending = false; } }, 320);
});
const snapAfterKeyboardResize = () => {
  if (!keyboardSnapPending) return;
  requestAnimationFrame(() => { scrollToLatest(); keyboardSnapPending = false; });
};
window.visualViewport?.addEventListener('resize', snapAfterKeyboardResize);
window.addEventListener('resize', snapAfterKeyboardResize);
window.addEventListener('resize', syncQuoteWidths);

async function loadServerSettings() {
  let remote = await ethereApi.settings();
  if (['Boss', 'Ethere'].includes(remote.bossName) && !['Boss', 'Ethere'].includes(bossName)) remote = await ethereApi.updateSettings({ bossName });
  bossName = remote.bossName || bossName;
  settings.model = remote.model || 'default';
  settings.voiceId = remote.voiceId || DEFAULT_VOICE_ID;
  settings.checkinEnabled = remote.checkin?.enabled === true;
  settings.checkinMin = remote.checkin?.minMinutes || settings.checkinMin;
  settings.checkinMax = remote.checkin?.maxMinutes || settings.checkinMax;
  storage.setItem('ethere.boss-name', bossName);
  writeJson('ethere.settings', settings);
  $('[data-model-label]').textContent = MODEL_LABELS[settings.model] || settings.model;
  $('[data-voice-label]').textContent = voiceLabel(settings.voiceId);
  $('[data-checkin-label]').textContent = `${settings.checkinEnabled ? '' : '已关闭 · '}${settings.checkinMin}–${settings.checkinMax} 分钟`;
  $('[data-dida-summary]').textContent = didaSummary(remote.dida?.projects, '未连接');
  syncBossName();
}

renderMessages(); resizeComposer(); syncBossName(); setConnectionState(false); renderTimeline(); enablePhotoDragging(); refreshSpaceClamps(); setView('chat');
clearNativeDeliveredNotifications();
void startNativeNotificationStream();
ethereApi.health().then(async () => {
  setConnectionState(true);
  void consumeSharedContent();
  await startNativeNotificationStream();
  await Promise.all([syncChatEvents(), hydrateRecentMessageTimes(), loadServerSettings(), loadSpacePosts(), refreshReminderCount()]);
  await reconcileUnfinishedMessages();
  revealFirstUnread();
  void nativePermissions?.consumeOpenChatIntent?.().catch(() => {});
  startChatEventStream();
}).catch(() => { setConnectionState(false); revealFirstUnread(); });
window.addEventListener('online', () => { void ethereApi.health().then(async () => { setConnectionState(true); void consumeSharedContent(); await Promise.all([syncChatEvents(), hydrateRecentMessageTimes(), refreshReminderCount()]); await reconcileUnfinishedMessages(); startChatEventStream(); await startNativeNotificationStream(); }).catch(() => setConnectionState(false)); });
document.addEventListener('visibilitychange', () => {
  syncNativeChatVisibility();
  if (document.hidden) {
    if (currentView === 'chat' && isAtLatest() && clearUnreadThroughLatest(unreadMessageIds, messages)) saveUnreadMessages();
    unreadAtBackground = new Set(unreadMessageIds);
    currentTurnWasBackgrounded = true;
    for (const stream of activeTextStreams) { stream.instant = true; stream.flush(); }
    return;
  }
  clearNativeDeliveredNotifications();
  void startNativeNotificationStream();
  if (currentView === 'chat') requestAnimationFrame(syncQuoteWidths);
  pendingUnreadReveal = true;
  for (const stream of activeTextStreams) stream.flush();
  if (connected) void syncChatEvents().then(reconcileUnfinishedMessages).catch(() => setConnectionState(false)).finally(() => revealFirstUnread(unreadSince(unreadMessageIds, unreadAtBackground)));
  else revealFirstUnread(new Set());
  if (connected && currentView === 'settings') {
    if (!$('[data-reminder-manager]').hidden) void loadReminders({ showLoading: false });
    else void refreshReminderCount().catch(() => {});
  }
  if (currentView === 'settings') void refreshPermissionStatus({ syncUsage: !$('[data-permissions-manager]')?.hidden });
});
window.setInterval(() => {
  if (currentChatRequest) return;
  if (connected) void syncChatEvents().then(reconcileUnfinishedMessages).catch(() => setConnectionState(false));
  else void ethereApi.health().then(async () => { setConnectionState(true); await syncChatEvents(); await reconcileUnfinishedMessages(); startChatEventStream(); await startNativeNotificationStream(); }).catch(() => {});
}, 30_000);
