import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const views = await readFile(new URL('../web/companion-views.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const api = await readFile(new URL('../web/companion-api.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
const spaceFilter = await readFile(new URL('../web/space-filter.js', import.meta.url), 'utf8');
const memoryUi = await readFile(new URL('../web/memory-ui.js', import.meta.url), 'utf8');
const androidManifest = await readFile(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
const androidMainActivity = await readFile(new URL('../android/app/src/main/java/com/ethere/app/MainActivity.java', import.meta.url), 'utf8');
const androidPermissions = await readFile(new URL('../android/app/src/main/java/com/ethere/app/EtherePermissionsPlugin.java', import.meta.url), 'utf8');
const androidIncomingCall = await readFile(new URL('../android/app/src/main/java/com/ethere/app/EthereIncomingCallActivity.java', import.meta.url), 'utf8');
const androidIncomingManager = await readFile(new URL('../android/app/src/main/java/com/ethere/app/EthereIncomingCallManager.java', import.meta.url), 'utf8');

test('opening the Android app clears delivered Ethere notifications and settings summarizes live grants', () => {
  assert.match(androidMainActivity, /public void onResume\(\)[\s\S]*?NotificationManagerCompat\.from\(this\)\.cancelAll\(\)/);
  assert.match(androidPermissions, /void clearDeliveredNotifications\(PluginCall call\)[\s\S]*?\.cancelAll\(\)/);
  assert.match(app, /function clearNativeDeliveredNotifications\(\)/);
  assert.match(app, /granted === 3 \? '已授权' : `\$\{granted\}\/3 已授权`/);
});

test('chat keeps mobile reading position and notifies only after a completed off-screen turn', () => {
  assert.match(html, /data-jump-latest/);
  assert.match(html, /class="chat-jump-latest"[^>]*aria-label="回到最新消息"[^>]*>\s*<svg[^>]*>/);
  assert.doesNotMatch(html, /data-jump-latest[^>]*>回到最新<\/button>/);
  assert.match(styles, /\.chat-jump-latest\s*\{[^}]*min-height:44px/);
  assert.match(styles, /\.chat-jump-latest\s*\{[^}]*border-radius:50%/);
  assert.match(styles, /\.conversation::-webkit-scrollbar\s*\{\s*display:\s*none/);
  assert.match(app, /function revealFirstUnread\(/);
  assert.match(app, /function markVisibleUnread\(/);
  assert.match(app, /const first = currentView === 'chat' \? messages\.find\(\(message\) => candidates\.has\(message\.id\) && unreadMessageIds\.has\(message\.id\)\)/);
  assert.doesNotMatch(app, /notificationTargetId/);
  assert.match(app, /list\.addEventListener\('touchstart', noteReadGesture/);
  assert.match(app, /if \(readingDown\) readGestureUntil = performance\.now\(\) \+ 900/);
  assert.match(app, /markVisibleUnread\(readingDown \? readGestureStart : null\)/);
  assert.match(app, /passedSinceScrollTop !== null && isAtLatest\(\)/);
  assert.match(app, /clearUnreadThroughLatest\(unreadMessageIds, messages\)/);
  assert.doesNotMatch(app.match(/function renderMessages\(\) \{[\s\S]*?\n\}\n\nfunction isAtLatest/)?.[0] || '', /readGestureUntil = 0/);
  assert.match(app, /const visibleAnchor = followLatest/);
  assert.match(app, /contentNode\.innerHTML = markdownMarkup\(content\)/);
  assert.match(app, /input\.addEventListener\('focus'/);
  assert.match(app, /jumpLatestButton\.addEventListener\('click', \(\) => scrollToLatest\(\{ markRead: true \}\)\)/);
  assert.match(app, /revealFirstUnread\(unreadSince\(unreadMessageIds, unreadAtChatExit\)\)/);
  assert.match(app, /currentView === 'chat' && !document\.hidden/);
  assert.match(androidPermissions, /public void setChatVisible\(/);
  assert.match(androidPermissions, /event\.optBoolean\("turnComplete", false\)/);
  assert.match(androidMainActivity, /ethereForeground = true;[\s\S]*?public void onPause\(\)\s*\{\s*ethereForeground = false;/);
  assert.match(androidPermissions, /!MainActivity\.isEthereForeground\(\)/);
  assert.match(androidPermissions, /showEventNotification\(int cursor,[\s\S]*?MainActivity\.isEthereForeground\(\) \|\| EthereCallForegroundService\.isRunning\(\)/);
  assert.match(app, /if \(!nativePermissions\?\.showNotification \|\| !document\.hidden\) return;/);
  assert.match(androidPermissions, /consumeOpenChatIntent/);
  assert.match(androidMainActivity, /onNewIntent\(Intent intent\)/);
  assert.match(app, /window\.EthereOpenChatFromNotification = openChatFromNotification/);
});

test('app shell exposes chat, timeline, space, and settings views', () => {
  assert.match(html, /data-view-panel="chat"/);
  assert.match(html, /data-view-panel="timeline"/);
  assert.match(html, /data-view-panel="space"/);
  assert.match(html, /data-view-panel="settings"/);
});

test('chat activity remains in the conversation and does not duplicate in the header', () => {
  assert.doesNotMatch(html, /data-page-status/);
  assert.doesNotMatch(app, /refreshRuntimeStatus|pageStatus/);
  assert.match(html, /class="typing" data-typing hidden/);
});

test('chat draft photos open the shared preview outside hidden view panels', () => {
  assert.match(html, /<\/div>\s*<section class="space-lightbox" data-space-lightbox/);
  assert.doesNotMatch(views, /data-space-lightbox/);
  assert.match(app, /data-chat-draft-photo/);
  assert.match(app, /showChatLightbox\(pendingAttachments/);
});

test('permissions page scrolls and uses compact status buttons', () => {
  assert.match(styles, /\.permissions-manager > div \{[^}]*min-height:0;[^}]*overflow:hidden auto/);
  assert.match(styles, /\.permission-card button \{[^}]*min-width:52px; min-height:44px/);
});

test('study plan cards appear in chat and the active lesson is highlighted without a label', () => {
  assert.match(app, /function studyCardMarkup\(/);
  assert.match(app, /message\.card\?\.kind === 'study-plan' \? studyCardMarkup/);
  assert.match(app, /card: streamEvent\.card \|\| null/);
  assert.match(app, /lesson\.id === plan\.currentLessonId \? 'is-current'/);
  assert.doesNotMatch(app, /<small>当前<\/small>/);
  assert.match(styles, /\.study-plan-lessons li\.is-current \{[^}]*color:var\(--app-accent/);
});

test('Android WebView can grant microphone capture after runtime approval', () => {
  assert.match(androidManifest, /android\.permission\.RECORD_AUDIO/);
  assert.match(androidManifest, /android\.permission\.MODIFY_AUDIO_SETTINGS/);
  assert.match(androidPermissions, /void requestMicrophonePermission\(PluginCall call\)/);
});

test('incoming call uses a dark screen with answer, hangup, and quiet snooze', () => {
  assert.match(androidManifest, /android:name="\.EthereIncomingCallActivity"[^>]*android:theme="@style\/AppTheme\.NoActionBar"/);
  assert.match(androidIncomingCall, /root\.setBackgroundColor\(Color\.rgb\(15, 17, 23\)\)/);
  assert.match(androidIncomingCall, /callAction\(actions, "挂断"/);
  assert.match(androidIncomingCall, /callAction\(actions, "接听"/);
  assert.match(androidIncomingCall, /setText\("稍后提醒"\)/);
});

test('call settings sit below permissions and ringtone/vibration use wake-up audio routing', () => {
  assert.match(views, /data-open-permissions[\s\S]*?data-open-voice-picker[\s\S]*?data-choose-call-ringtone[\s\S]*?<\/section>[\s\S]*?data-open-model-picker/);
  assert.match(styles, /:is\(\[data-model-options\], \[data-voice-options\]\)/);
  assert.match(androidPermissions, /void chooseCallRingtone\(PluginCall call\)/);
  assert.match(androidPermissions, /@ActivityCallback\s+private void callRingtoneChosen/);
  assert.match(androidIncomingManager, /AudioAttributes\.USAGE_ALARM/);
  assert.match(androidIncomingManager, /VibrationAttributes\.USAGE_ALARM/);
  assert.match(androidIncomingManager, /!EthereIncomingCallOverlay\.show\(context, action\)\) postCallNotification/);
});

test('Android Back closes the frontmost nested memory page before its list', () => {
  assert.match(app, /const inlineBack = \[\.\.\.document\.querySelectorAll\('\.inline-editor:not\(\[hidden\]\) button\[aria-label="返回"\]'\)\]\.at\(-1\)/);
  assert.match(memoryUi, /function closeDetail\(\) \{ \$\('\[data-memory-detail\]'\)\.hidden = true; state\.selected = null; \}/);
  assert.match(memoryUi, /function close\(\) \{ \$\('\[data-memory-manager\]'\)\.hidden = true; leaveSubpage\(\); \}/);
});

test('chat header provides direct space, settings, and timeline destinations', () => {
  assert.doesNotMatch(html, /class="bottom-nav"/);
  assert.doesNotMatch(html, /data-open-menu/);
  for (const destination of ['data-open-space', 'data-open-settings', 'data-open-timeline']) {
    assert.match(html, new RegExp(destination));
  }
});

test('chat proportions stay compact without reducing mobile touch targets or safe areas', () => {
  assert.match(styles, /\.app-shell\[data-view="chat"\] \.topbar \{[^}]*min-height:52px;[^}]*--app-safe-top/);
  assert.match(styles, /\.app-shell\[data-view="chat"\] \.topbar \.icon-button \{[^}]*width:44px; height:44px/);
  assert.match(styles, /\.composer \{[^}]*grid-template-columns: 44px minmax\(0, 1fr\) 44px;[^}]*--app-safe-bottom/);
  assert.match(styles, /\.composer textarea \{[^}]*font-size:15px/);
  assert.match(styles, /\.bubble \{[^}]*width:fit-content; max-width:94%;[^}]*font-size:15px/);
  assert.match(styles, /\.message--mine \.bubble \{[^}]*max-width:88%/);
  assert.match(styles, /@media \(max-width:430px\) \{[^}]*\.app-shell\[data-view="chat"\] \.topbar \{[^}]*min-height:46px/);
  assert.match(styles, /\.app-shell\[data-view="chat"\] \.composer \{[^}]*padding-top:2px/);
  assert.match(styles, /\.composer__field \{[^}]*min-height: 44px/);
  assert.match(styles, /\.composer__field::before \{[^}]*inset: 5px 0/);
  assert.match(styles, /\.composer__utility \{[^}]*width: 44px;[^}]*height: 44px/);
  assert.match(styles, /\.send-button \{[^}]*width: 44px;[^}]*height: 44px/);
  assert.match(styles, /\.app-shell\[data-view="chat"\] \.identity strong \{ font-size:15\.5px/);
  assert.match(styles, /\.topbar,\s*\.app-shell\[data-view="chat"\] \.topbar \{[^}]*min-height: 46px;[^}]*--app-safe-top/);
  assert.match(styles, /\.message:not\(\.message--mine\) \.bubble,[\s\S]*?width:100%;[^}]*max-width:100%;[^}]*background:transparent/);
  assert.match(styles, /\.composer__utility \{ color:color-mix\(in srgb,var\(--app-muted,#9298aa\) 65%,white\)/);
});

test('attachment tray toggles from the plus button and closes from the conversation', () => {
  assert.match(html, /data-add-image[^>]*aria-expanded="false"/);
  assert.match(html, /class="composer-actions__inner"/);
  assert.match(app, /attachmentTrigger\.addEventListener\('click', \(\) => setAttachmentActionsOpen\(!attachmentActionsOpen\)\)/);
  assert.match(app, /list\.addEventListener\('click', closeAttachmentActions\)/);
  assert.match(app, /input\.addEventListener\('focus', closeAttachmentActions\)/);
  assert.match(styles, /\.composer-actions\.is-open \{[^}]*opacity: 1;[^}]*pointer-events: auto/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.composer-actions \{ transition: none/);
});

test('chat quotes selected text above the reply and sends the source as separate data', () => {
  assert.match(html, /data-quote-preview/);
  assert.match(html, /data-quote-action[^>]*>引用<\/button>/);
  assert.match(app, /function selectedQuoteCandidate\(/);
  assert.match(app, /list\.addEventListener\('contextmenu'/);
  assert.match(app, /quoteMarkup\(message\.quote\)/);
  assert.doesNotMatch(app, /<span>\$\{author\}：<\/span>/);
  assert.doesNotMatch(html, /data-quote-label/);
  assert.match(app, /message__body">\$\{quoteMarkup\(message\.quote\)\}<div class="bubble">/);
  assert.match(app, /quote: message\.quote \|\| null/);
  assert.match(api, /body: JSON\.stringify\(\{ message, images, files, messageId, quote, channel \}\)/);
  assert.match(styles, /\.composer-quote__text \{[^}]*text-overflow:ellipsis/);
  assert.match(styles, /\.message-quote__text \{[^}]*text-overflow:ellipsis/);
  assert.match(app, /quote\.style\.width = `\$\{bubble\.offsetWidth\}px`/);
  assert.match(app, /bubble\.offsetWidth > 0/);
  assert.match(app, /if \(view === 'chat'\) requestAnimationFrame\(syncQuoteWidths\)/);
  const quoteRule = styles.match(/\.message-quote \{([^}]+)\}/)?.[1] || '';
  assert.doesNotMatch(quoteRule, /border-left/);
});

test('space editor previews, removes, and appends images across selections', () => {
  assert.match(views, /data-space-upload-preview/);
  assert.match(app, /data-space-draft-photo/);
  assert.match(app, /data-space-draft-remove/);
  assert.match(app, /showSpaceLightbox\(pendingSpaceImages/);
  assert.match(app, /const prepared = await Promise\.all\(files\.map\(prepareSpaceImage\)\)/);
  assert.match(app, /pendingSpaceImages\.push\(\.\.\.prepared\)/);
  assert.match(app, /event\.target\.value = ''/);
  assert.match(app, /image\.id \? \{ id: image\.id \}/);
  assert.match(styles, /\.space-upload-preview::-webkit-scrollbar \{ display:none; \}/);
});

test('Android handles bottom navigation and keyboard insets exactly once', () => {
  assert.match(androidManifest, /android:windowSoftInputMode="adjustNothing"/);
  assert.match(androidMainActivity, /WindowInsetsCompat\.Type\.statusBars\(\) \| WindowInsetsCompat\.Type\.displayCutout\(\)/);
  assert.match(androidMainActivity, /WindowInsetsCompat\.Type\.navigationBars\(\)/);
  assert.match(androidMainActivity, /view\.setPadding\(0, statusBars\.top, 0,/);
  assert.match(androidMainActivity, /keyboardVisible \? ime\.bottom : navigationBars\.bottom/);
  assert.doesNotMatch(androidMainActivity, /EdgeToEdge\.enable/);
  assert.match(app, /nativeAndroidViewport = window\.Capacitor\?\.getPlatform\?\.\(\) === 'android'/);
  assert.match(app, /document\.documentElement\.dataset\.nativeAndroid = 'true'/);
  assert.match(styles, /html\[data-native-android="true"\][^{]*\{[^}]*--app-safe-top:\s*0px[^}]*--app-safe-bottom:\s*0px/);
});

test('settings owns management entries instead of space', () => {
  for (const label of ['界面颜色', '人设', '工具使用规则', '记忆', '对话模型', '线程管理', '主动联系间隔', '滴答清单', '提醒任务', '学习计划']) {
    assert.match(views, new RegExp(label));
  }
  assert.ok(views.indexOf('data-open-reminders') < views.indexOf('data-open-study-plans'), '学习计划入口应排在提醒任务之后');
  assert.match(views, /data-compact-thread/);
  assert.match(views, /data-start-new-thread/);
  assert.match(views, /const BACK_ICON/);
  for (const close of ['review', 'categories', 'space-editor', 'settings-document', 'chat-history']) {
    assert.match(views, new RegExp(`data-close-${close}[^>]*aria-label="返回"`));
  }
  assert.match(views, /class="bottom-sheet" data-context-settings/);
  assert.match(views, /data-close-context-settings[^>]*aria-label="关闭线程管理"/);
  assert.match(styles, /\.context-settings-sheet[^}]*min-height:42dvh/);
  const contextMarkup = views.match(/context-settings__actions[^`]+/)?.[0] || '';
  assert.doesNotMatch(contextMarkup, />›</);
  assert.match(views, /data-theme-choice/);
  assert.match(views, /data-settings-document-form/);
  assert.match(styles, /\.settings-document form\s*\{[^}]*display:flex[^}]*height:100%[^}]*min-height:0[^}]*flex-direction:column[^}]*overflow:hidden/);
  assert.match(styles, /\.settings-document textarea\s*\{[^}]*flex:1 1 0[^}]*height:auto[^}]*min-height:0[^}]*max-height:none/);
  assert.match(views, /data-dida-settings/);
  assert.match(views, /data-dida-project-list/);
  assert.match(app, /selectDidaProjects\(nextIds\)/);
  assert.match(app, /请至少保留一个监督清单/);
  assert.match(api, /JSON\.stringify\(\{ projectIds \}\)/);
  assert.match(views, /data-reminder-manager/);
  assert.match(views, /data-open-reminders/);
  assert.doesNotMatch(views, /只读取选中清单/);
  assert.match(app, /const footer = repeat \|\| action/);
  assert.match(styles, /\.reminder-card \{ padding:14px 16px/);
  assert.doesNotMatch(views, /'时间线分类'/);
  assert.match(views, /data-edit-boss-name/);
  assert.match(views, /data-connection-label/);
  assert.match(views, /data-theme-choice="white"/);
  assert.match(views, /data-open-model-picker/);
  assert.match(views, /data-open-checkin-picker/);
  assert.doesNotMatch(views, /data-model-select|data-checkin-min[^-]|type="number"/);
  assert.doesNotMatch(views, /电脑端连接|人设文件|当前模型|当前对话上下文|滴答清单监督/);
  assert.match(views, /data-apply-checkin>保存</);
  assert.match(app, /保存中…/);
  assert.match(app, /正在压缩上下文…/);
  assert.match(app, /正在切换对话线程…/);
  assert.match(app, /setView\('chat'\)/);
  assert.doesNotMatch(app, /showView\(/);
  assert.match(app, /已保存并应用/);
  assert.match(app, /已保存到电脑 · 尚未应用/);
  assert.match(api, /runtime\/thread\/new/);
  assert.match(api, /payload\?\.error/);
  assert.match(views, /data-open-chat-history/);
  assert.match(views, /data-open-permissions/);
  assert.match(views, /<strong>权限<\/strong>/);
  assert.match(views, /应用使用情况[\s\S]*data-phone-usage-data-status>尚未从手机同步/);
  assert.doesNotMatch(views, /权限与手机状态|数据同步|最近一次手机数据|data-check-permissions|data-notification-permission-status|data-test-phone-usage|permission-note/);
  assert.doesNotMatch(app, /data-check-permissions|data-test-phone-usage/);
  assert.match(app, /最后更新：/);
  assert.match(views, /data-request-usage-permission/);
  assert.match(views, /data-request-notification-permission/);
  assert.match(app, /EthereAndroidPermissions/);
  assert.match(api, /phone-usage\/status/);
  assert.match(views, /data-chat-history-search/);
  assert.match(views, /data-open-history-date/);
  assert.match(views, /data-history-date-sheet/);
  assert.match(views, /data-load-older-history/);
  assert.match(api, /chat\/history/);
  assert.match(app, /loadChatHistory/);
  assert.match(app, /message-day-divider/);
  assert.match(app, /occurredAt/);
  assert.match(app, /historySearch/);
  assert.match(app, /renderHistoryDatePicker/);
  assert.doesNotMatch(views, /data-chat-history-date|type="date"/);
  for (const group of ['系统', '模型设置', '任务']) assert.match(views, new RegExp(`aria-label="${group}"`));
  assert.doesNotMatch(views, /settings-group-title|<h2[^>]*>系统|<h2[^>]*>模型设置|<h2[^>]*>任务/);
  assert.match(views, /settings-list settings-card/);
  assert.doesNotMatch(views, /我的助手|settings-section-label/);
  assert.match(views, /data-edit-boss-name/);
  assert.doesNotMatch(views, /data-save-boss-name/);
  assert.match(app, /function setBossNameEditing\(editing\)/);
  assert.match(app, /querySelector\('svg'\)\.toggleAttribute\('hidden', editing\)/);
  assert.match(styles, /\.profile-edit \[hidden\] \{ display:none !important; \}/);
  assert.match(styles, /\.settings-card \{[^}]*border-radius:16px/);
  assert.match(styles, /:is\(\.space-editor form,[^}]*> header \{[^}]*grid-template-columns:44px minmax\(0,1fr\) 44px/);
  assert.match(styles, /\.bottom-sheet > :last-child:not\(\.sheet-backdrop\) \{[^}]*max-height:86dvh/);
  assert.match(styles, /\.theme-swatch \{[^}]*width:40px; height:44px/);
  assert.doesNotMatch(views, /外观与身份|对话与记忆|主动与任务|data-chat-history-recent/);
  assert.match(views, /线程管理/);
  assert.match(app, /data-copy-history/);
  assert.match(styles, /\.toast[\s\S]*top:\s*50%/);
  assert.match(styles, /caret-color:var\(--app-accent,var\(--brand\)\)/);
  assert.match(styles, /\.composer__field:focus-within/);
  assert.match(app, /nativeAndroidViewport = window\.Capacitor\?\.getPlatform\?\.\(\) === 'android'/);
  assert.match(app, /if \(!nativeAndroidViewport\) \{[\s\S]*visualViewport\?\.addEventListener\('resize'/);
  assert.match(app, /<time>\$\{escapeHtml\(message\.createdAt\)\}<\/time><span>/);
  for (const marker of ['data-open-memory', 'data-memory-search', 'data-memory-status="remember"', 'data-memory-status="watch"', 'data-memory-active-count']) assert.match(views, new RegExp(marker));
  assert.doesNotMatch(views, /data-memory-pending|待确认/);
  assert.doesNotMatch(views, /data-add-memory|data-memory-confirm|新增记忆/);
  assert.doesNotMatch(memoryUi, /api\.createMemoryNode|api\.createMemory\(/);
  assert.match(memoryUi, /api\.updateMemoryV2/);
  assert.match(memoryUi, /api\.updateMemory/);
  assert.match(memoryUi, /api\.archiveMemory/);
  assert.match(memoryUi, /api\.reportMemoryV2Issue/);
  assert.match(memoryUi, /忘记这条记忆/);
  assert.match(memoryUi, /markdownMarkup\(memory\.contentMarkdown \|\| memory\.content\)/);
  assert.doesNotMatch(views, /data-memory-status="retrievable"/);
  assert.doesNotMatch(views, /data-memory-status="closed"/);
  assert.match(views, /data-memory-status="active"/);
  assert.match(views, /data-memory-status="remember"/);
  assert.match(views, /data-memory-status="watch"/);
  assert.match(memoryUi, /api\.memoryV2List/);
  assert.match(memoryUi, /const title = isV2 \? ''/);
  assert.match(memoryUi, /memory-card--v2/);
  assert.match(memoryUi, /memory\.memory_type === 'fact' \? '事实' : '判断'/);
  assert.doesNotMatch(memoryUi, /data-memory-archived-count|status: 'superseded'/);
  assert.match(memoryUi, /api\.memoryV2Evidence/);
  assert.match(memoryUi, /api\.memoryV2Related/);
  assert.match(styles, /\.memory-list\s*\{[^}]*overflow:hidden auto/);
  assert.match(styles, /\.memory-detail__content\s*\{[^}]*overflow:hidden auto/);
  assert.doesNotMatch(views, /data-import-memory|data-reread-memory/);
  assert.doesNotMatch(api, /memory\/reread|migration-preview|memory\/import/);
  assert.match(html, /data-memory-approval-separate-label>检测到相似记忆，仍作为新主题保存/);
  assert.match(api, /checkMemoryDuplicate/);
  assert.match(app, /检测到与“\$\{duplicate\.title\}”相似，仍作为新主题保存/);
  assert.match(styles, /memory-approval-separate > span::before[^}]*width:12px[^}]*border-radius:50%/);
  assert.match(app, /proposal\.duplicateCandidate \|\| message\.memoryDuplicateCandidate/);
  assert.match(app, /duplicate \? '覆盖' : '新增'/);
  assert.match(app, /将更新“\$\{escapeHtml\(duplicate\.title\)\}”/);
  assert.match(app, /hydrateMemoryApprovalDuplicates/);
  assert.match(app, /approval\.kind === 'dida-task-change'/);
  assert.match(app, /approval\.kind === 'dida-task-with-reminder'/);
  assert.match(app, /任务重复/);
  assert.match(app, /formatTaskRepeat\(proposal\.repeatFlag\)/);
  assert.match(app, /重试关联提醒/);
  assert.doesNotMatch(app, /approval-card__combo-message|escapeHtml\(reminder\.title \|\| ''\)/);
  assert.match(app, /approval-card__combo-reason/);
  assert.match(styles, /\.approval-card--task-combo \.approval-card__actions button \{ min-height:44px/);
  assert.match(app, /滴答任务建议/);
  assert.match(app, /已写入滴答清单/);
  assert.match(styles, /approval-card__actions--two/);
});

test('reminder list keeps touch scrolling without a desktop scrollbar and marks reminder bubbles', () => {
  assert.match(styles, /\.reminder-list\s*\{[^}]*overflow-y:auto;[^}]*scrollbar-width:none;/);
  assert.match(styles, /\.reminder-list::-webkit-scrollbar\s*\{\s*display:none;/);
  assert.match(styles, /\.message--reminder \.message__body::before\s*\{[^}]*background:#d8886b;/);
  assert.match(app, /message\.source === 'reminder' \? ' message--reminder'/);
});

test('timeline shell supports global ranges, ranking, two-level categories, and a full daily review', () => {
  assert.match(views, /data-distribution-toggle/);
  assert.match(views, /data-timeline-mode="events"/);
  assert.match(views, /data-timeline-mode="stats"/);
  assert.match(views, /当日回顾/);
  for (const range of ['day', 'week', 'month', 'custom']) assert.match(views, new RegExp(`data-range="${range}"`));
  assert.match(app, /renderRanking/);
  assert.match(app, /data-ranking-toggle/);
  assert.match(app, /expandedRankingCategories/);
  assert.match(app, /textContent = '时间排行'/);
  assert.doesNotMatch(app, /当天时间排行|本周时间排行|本月时间排行|自定义范围排行/);
  assert.match(styles, /\.ranking-children\[hidden\]/);
  assert.match(app, /category-path/);
  assert.match(views, /data-review-form/);
  assert.match(views, /data-review-expand/);
  assert.match(views, /data-add-timeline-event/);
  assert.match(views, /data-timeline-event-form/);
  assert.match(views, /data-delete-timeline-event/);
  assert.match(views, /data-event-time-sheet/);
  assert.match(views, /data-open-event-time="start"/);
  assert.match(views, /data-open-event-time="end"/);
  assert.doesNotMatch(views, /type="time"|timeline-next-day/);
  assert.match(app, /eventTimeTarget === 'end' \? 48 : 24/);
  assert.match(app, /eventTimeHour >= 24/);
  assert.match(styles, /-webkit-line-clamp:5/);
  assert.match(styles, /\.daily-review-card \.daily-review-expand[^}]*text-align:right/);
  assert.match(styles, /\.daily-review-copy \.task-list-item/);
  assert.match(styles, /\.timeline-filter-sticky[^}]*position:sticky/);
  assert.match(styles, /\.event-time-wheel/);
  assert.match(app, /dayStatsExpanded/);
  assert.doesNotMatch(app, /events\.hidden = !events\.hidden/);
  assert.match(app, /weekLabelMarkup/);
  assert.match(app, /saveTimelineEvent/);
  assert.match(app, /archiveTimelineEvent/);
  assert.match(app, /markdownMarkup\(timelineReview/);
  assert.match(api, /timeline\/events/);
  assert.match(api, /timeline\/reviews/);
  assert.match(views, /data-category-list/);
  assert.doesNotMatch(views, /data-category-edit-name[^>]*required/);
  assert.match(app, /请输入分类名称/);
  assert.match(styles, /\.category-browser > div[^}]*overflow-y:auto/);
  assert.match(styles, /\.stats-panel:not\(\[hidden\]\) \+ \[data-timeline-mode="events"\][^}]*padding-top:28px/);
  assert.match(styles, /\.timeline-entry[^}]*margin-bottom: 20px/);
  assert.match(app, /timelineCategories/);
  assert.match(app, /timelineStats/);
  assert.match(app, /timelineReview/);
  assert.doesNotMatch(app, /SAMPLE_EVENTS|SAMPLE_REVIEW|DEFAULT_CATEGORIES/);
  assert.match(app, /stepPeriod/);
  assert.match(app, /timelineBounds/);
  assert.doesNotMatch(views, /data-day-strip/);
  assert.doesNotMatch(views, /data-return-current/);
  assert.match(app, /data-picker-return-current/);
  assert.match(views, /data-period-picker/);
  assert.match(views, /data-period-picker-body/);
  assert.match(app, /calendarMarkup/);
  assert.match(app, /data-picker-week/);
  assert.match(app, /data-picker-month/);
  assert.match(app, /extendPeriodWheel/);
  assert.match(app, /data-custom-picker-next/);
  assert.doesNotMatch(views, /data-range-start-wheel|<select size=/);
  assert.doesNotMatch(app, /已切换到上一个时间段|已切换到下一个时间段/);
  assert.doesNotMatch(views, /proposal-card/);
  assert.doesNotMatch(views, /点击查看统计|原 Diary 的新位置|展开并编辑/);
});

test('space shell distinguishes user writing and assistant observations', () => {
  assert.match(views, /data-space-editor-form/);
  assert.match(views, /multiple hidden/);
  assert.match(views, /class="space-upload" aria-label="添加图片"/);
  assert.match(views, /class="space-editor__media"[\s\S]*data-space-upload-preview[\s\S]*data-space-image-input[\s\S]*data-space-text/);
  assert.doesNotMatch(app, /spaceAddButton\.hidden = true; \$\('\[data-space-text\]'\)\.focus\(\)/);
  assert.match(styles, /\.space-upload\[hidden\] \{ display:none; \}/);
  assert.doesNotMatch(views, />添加图片<\/label>/);
  assert.match(styles, /\.space-editor form\s*\{[^}]*display:flex[^}]*min-height:0[^}]*flex-direction:column[^}]*overflow:hidden/);
  assert.match(styles, /\.space-editor textarea\s*\{[^}]*flex:1 1 0[^}]*height:auto[^}]*max-height:none/);
  assert.match(views, /data-space-actions-sheet/);
  assert.match(views, /data-space-action-edit/);
  assert.match(views, /data-space-action-delete/);
  assert.match(app, /enablePhotoDragging/);
  assert.match(views, /data-space-time-filter/);
  assert.match(app, /data-space-expand/);
  assert.match(html, /data-space-lightbox/);
  assert.match(app, /data-space-photo/);
  assert.match(app, /spaceTimeOptionsMarkup/);
  assert.match(app, /\['custom', '自定义'\]/);
  assert.match(app, /data-space-custom-next/);
  assert.match(app, /matchesSpacePost/);
  assert.match(spaceFilter, /filters\.author/);
  assert.match(spaceFilter, /filters\.time/);
  assert.match(views, /space-author-dot--user/);
  assert.match(views, /space-author-dot--assistant/);
  assert.match(views, /data-space-filter="user"/);
  assert.match(views, /data-space-filter="assistant"/);
  assert.match(views, /data-space-filter="assistant"[^>]*>.*data-boss-name>Ethere<\/span><\/button>/);
  assert.doesNotMatch(views, />他<\/button>/);
  assert.doesNotMatch(views, /我写的/);
  assert.match(styles, /\.space-entry\[hidden\]\s*\{\s*display:none\s*!important;/);
  assert.match(styles, /\.space-entry__meta time strong\s*\{[^}]*font-size:10px/);
  assert.match(styles, /\.space-entry__meta time\s*\{[^}]*color:var\(--app-muted/);
  assert.match(html, /space-lightbox-close/);
  assert.match(app, /window\.EthereHandleBack/);
  assert.match(styles, /\[data-space-filter="user"\][^}]*min-width:48px/);
  assert.match(styles, /\.space-copy\.is-collapsed\.is-overflowing::after\s*\{\s*display:none/);
  assert.match(styles, /\.space-expand[^}]*margin:2px 0 2px auto[^}]*text-align:right/);
  assert.doesNotMatch(views, /没有符合条件的记录/);
  assert.match(views, />记录<.*>发送</s);
  assert.doesNotMatch(views, /OUR SPACE|首版只做文字|我的记录|共同经历|kind: 'together'/);
  assert.match(app, /ethereApi\.spacePosts/);
  assert.match(app, /originalDataUrl/);
  assert.match(app, /previewDataUrl/);
  assert.match(app, /maxEdge: 2400, quality: \.92/);
  assert.match(app, /enableLightboxPinch/);
  assert.match(app, /track\.scrollTo\(\{ left: destination \* track\.clientWidth/);
  assert.match(app, /event\.target\.matches\('\.space-lightbox-slide,\.space-lightbox-track'\)/);
  assert.match(app, /space-lightbox-track/);
  assert.match(app, /if \(view === 'space'\)[\s\S]*loadSpacePosts/);
  assert.match(styles, /\.space-filters[^}]*position:sticky/);
  assert.match(styles, /\.space-copy\.is-collapsed[^}]*--space-collapsed-height/);
  assert.match(app, /child\.offsetTop \+ child\.offsetHeight/);
  assert.match(app, /isStructuredBlock/);
  assert.match(app, /event\.pointerType !== 'mouse'/);
  assert.match(styles, /\.space-copy \.markdown-table-wrap/);
  assert.match(styles, /\.space-lightbox-track[^}]*scroll-snap-type:x mandatory/);
  assert.match(styles, /\.space-lightbox[^}]*position:fixed/);
  assert.match(styles, /\.space-lightbox-slide img[^}]*touch-action:none/);
});

test('chat owns image attachment and connection state without a timeline proposal', () => {
  assert.match(html, /accept="image\/\*"/);
  assert.match(views, /data-boss-name-form/);
  assert.doesNotMatch(app, /时间线写入建议/);
  assert.match(app, /ethere\.boss-name/);
  assert.match(app, /setConnectionState/);
  assert.doesNotMatch(html, /离线演示/);
  assert.match(app, /split\(\/\\n\+\//);
  assert.doesNotMatch(app, /event\.key\s*===\s*['"]Enter['"]/);
  assert.doesNotMatch(app, /message__name/);
  assert.match(styles, /\.message-image \{ width:min\(34%,132px\)/);
});

test('chat sends text to the Ethere streaming endpoint instead of using a mock reply', () => {
  assert.match(app, /ethereApi\.streamChat/);
  assert.match(api, /application\/x-ndjson|\/chat/);
  assert.match(app, /images: attachments\.filter\(\(item\) => item\.type === 'image'\)/);
  assert.match(api, /JSON\.stringify\(\{ message, images, files, messageId, quote, channel \}\)/);
  assert.match(app, /interruptChat/);
  assert.match(app, /syncChatEvents/);
  assert.match(api, /chat\/events\?after=/);
  assert.match(html, /type="file" accept="image\/\*" multiple/);
  assert.doesNotMatch(html, /placeholder=/);
  assert.match(app, /attachment\.name/);
  assert.doesNotMatch(app, /图片发送将在下一个切片接入/);
  assert.doesNotMatch(app, /function mockReply/);
});

test('chat stream renders MCP write activities and segmented assistant replies', () => {
  assert.match(app, /streamEvent\.type === 'activity'/);
  assert.match(app, /streamEvent\.type === 'segment'/);
  assert.match(app, /source: 'mcp'/);
  assert.match(app, /chatStore\.append\(message, messages\)/);
});

test('manual compaction waits for the real completion event instead of the default request timeout', () => {
  assert.match(api, /compactThread:.*10 \* 60_000/);
});
