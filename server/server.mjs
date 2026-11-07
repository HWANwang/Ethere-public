import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateLinkedReminderDraft } from './reminder-store.mjs';
import { appendMemoryNotice } from './memory-notice.mjs';
import { normalizeVoiceId } from './voice-catalog.mjs';

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

export function createEthereServer({ webRoot, chatService, attachmentStore, chatEventStore, configStore = null, checkinService = null, timelineStore = null, memoryStore = null, memoryNodeStore = null, memoryV2Client = null, memoryReviewService = null, didaService = null, reminderService = null, spaceStore = null, spaceReplyService = null, phoneUsageStore = null, phoneUsageRefresh = null, deviceActionService = null, studyPlanStore = null, onChatTiming = (record) => console.info(`ETHERE_CHAT_TIMING ${JSON.stringify(record)}`) }) {
  const inflightMessageIds = new Set();
  const inflightApprovalIds = new Set();
  const appendDeviceNotice = async (event) => {
    try { return await chatEventStore?.append?.(event); }
    catch (error) { console.warn(`ETHERE_DEVICE_NOTICE_FAILED ${safeError(error)}`); return null; }
  };
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/downloads/Ethere-release.apk' && request.method === 'GET') {
        return await serveReleaseApk(response, join(webRoot, '..', 'dist', 'Ethere-release.apk'));
      }
      if (url.pathname === '/api/ethere/v1/health' && request.method === 'GET') {
        try {
          const health = await chatService.health();
          return sendJson(response, 200, { ...health, serverConnected: true, runtimeConnected: true,
            instance: { pid: process.pid, dataRoot: chatService.dataRoot } });
        } catch (error) {
          return sendJson(response, 200, {
            connected: true,
            serverConnected: true,
            runtimeConnected: false,
            runtime: 'codex-app-server',
            runtimeError: safeError(error),
            instance: { pid: process.pid, dataRoot: chatService.dataRoot },
          });
        }
      }
      if (url.pathname === '/api/ethere/v1/runtime/mcp' && request.method === 'GET' && chatService?.mcpStatus) {
        return sendJson(response, 200, await chatService.mcpStatus());
      }
      if (url.pathname === '/api/ethere/v1/study/plans' && request.method === 'GET' && studyPlanStore) {
        return sendJson(response, 200, { plans: await studyPlanStore.list({ includeArchived: url.searchParams.get('includeArchived') === 'true' }) });
      }
      const studyPlanMatch = url.pathname.match(/^\/api\/ethere\/v1\/study\/plans\/([^/]+)$/);
      if (studyPlanMatch && request.method === 'GET' && studyPlanStore) {
        const plan = await studyPlanStore.get(decodeURIComponent(studyPlanMatch[1]));
        if (!plan) throw statusError(404, '学习计划不存在');
        return sendJson(response, 200, { plan });
      }
      if (url.pathname === '/api/ethere/v1/device-actions/attention-popup' && request.method === 'POST' && deviceActionService) {
        return sendJson(response, 201, { action: await deviceActionService.createPopup(await readJsonBody(request, 8192)) });
      }
      if (url.pathname === '/api/ethere/v1/device-actions/incoming-call' && request.method === 'POST' && deviceActionService) {
        const input = await readJsonBody(request, 4096);
        if (input.reminderId) {
          const reminder = await reminderService?.get(input.reminderId);
          if (!reminder || reminder.status !== 'scheduled') throw statusError(404, '关联提醒不存在或已结束');
        }
        const assistantName = await configuredAssistantName(configStore);
        const action = await deviceActionService.createCall({ ...input, title: assistantName });
        await appendDeviceNotice({ id: `device-action-created-${action.id}`, role: 'notice', source: 'device-action',
          content: Date.parse(action.triggerAt) > Date.now() + 5_000 ? `${assistantName} 预约了一通来电` : `${assistantName} 正在给你打电话` });
        return sendJson(response, 201, { action });
      }
      if (url.pathname === '/api/ethere/v1/chat/call-events' && request.method === 'POST') {
        const input = await readJsonBody(request, 4096);
        const id = String(input.callId || '');
        if (!/^[a-f0-9-]{36}$/i.test(id) || !['started', 'opening', 'ended'].includes(input.event)) throw statusError(400, '通话记录无效');
        const duration = Math.max(0, Math.min(24 * 3600, Math.floor(Number(input.durationSeconds) || 0)));
        if (input.event === 'opening') {
          const text = String(input.text || '').trim();
          if (!text || text.length > 1600) throw statusError(400, '来电开场语无效');
          const event = await appendDeviceNotice({ id: `voice-call-${id}-opening`, role: 'assistant', source: 'voice-call', content: text });
          return sendJson(response, 201, { event });
        }
        const assistantName = await configuredAssistantName(configStore);
        const content = input.event === 'started' ? (input.direction === 'incoming' ? `已接听 ${assistantName} 的来电` : `你给 ${assistantName} 打了电话`)
          : `通话已挂断 · ${String(Math.floor(duration / 60)).padStart(2, '0')}:${String(duration % 60).padStart(2, '0')}`;
        const event = await appendDeviceNotice({ id: `voice-call-${id}-${input.event}`, role: 'notice', source: 'voice-call', content });
        return sendJson(response, 201, { event });
      }
      if (url.pathname === '/api/ethere/v1/device-actions/poll' && request.method === 'GET' && deviceActionService) {
        return sendJson(response, 200, { action: await deviceActionService.poll() });
      }
      if (url.pathname === '/api/ethere/v1/voice/health' && request.method === 'GET') {
        try {
          const upstream = await fetch('http://127.0.0.1:4189/api/health', { signal: AbortSignal.timeout(3000) });
          const health = await upstream.json();
          return sendJson(response, 200, { available: upstream.ok && health.asr === true && health.fish === true, asr: health.asr === true, fish: health.fish === true });
        } catch { return sendJson(response, 200, { available: false, asr: false, fish: false }); }
      }
      if (url.pathname === '/api/ethere/v1/voice/timing' && request.method === 'POST') {
        const input = await readJsonBody(request, 2048);
        if (typeof input.callId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.callId)) throw statusError(400, '通话 ID 无效');
        const elapsed = (name) => Number.isFinite(input[name]) && input[name] >= 0 && input[name] <= 300_000 ? Math.round(input[name]) : null;
        try { console.info(`ETHERE_VOICE_TIMING ${JSON.stringify({ at: new Date().toISOString(), callId: input.callId.slice(0, 8), asrMs: elapsed('asrMs'), firstDeltaMs: elapsed('firstDeltaMs'), firstTtsMs: elapsed('firstTtsMs'), firstPlayMs: elapsed('firstPlayMs'), replyDoneMs: elapsed('replyDoneMs'), error: String(input.error || '').slice(0, 120) })}`); } catch { /* diagnostics must never interrupt a call */ }
        response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return;
      }
      if (url.pathname === '/api/ethere/v1/voice/asr' && request.method === 'POST') {
        const input = await readJsonBody(request, 11 * 1024 * 1024);
        if (typeof input.audioBase64 !== 'string' || input.audioBase64.length > 10_700_000) throw statusError(400, '录音格式错误或太长');
        return await proxyVoiceJson(response, '/api/asr', input, 40000);
      }
      if (url.pathname === '/api/ethere/v1/voice/tts' && request.method === 'POST') {
        const input = await readJsonBody(request, 16 * 1024);
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 400) throw statusError(400, '朗读文字长度需为 1～400 字');
        return await proxyVoiceAudio(response, input.text, input.voiceId);
      }
      const deviceActionMatch = url.pathname.match(/^\/api\/ethere\/v1\/device-actions\/([^/]+)\/(ack|result)$/);
      const cancelCallMatch = url.pathname.match(/^\/api\/ethere\/v1\/device-actions\/([^/]+)\/cancel$/);
      if (cancelCallMatch && request.method === 'POST' && deviceActionService) {
        return sendJson(response, 200, { action: await deviceActionService.cancelCall(decodeURIComponent(cancelCallMatch[1])) });
      }
      if (deviceActionMatch && request.method === 'POST' && deviceActionService) {
        const input = await readJsonBody(request, 4096);
        const id = decodeURIComponent(deviceActionMatch[1]);
        if (deviceActionMatch[2] === 'ack') {
          const action = await deviceActionService.acknowledge(id, input.state);
          if (action.type === 'attention_popup' && action.state === 'displaying') await appendDeviceNotice({
            id: `device-action-visible-${id}`, role: 'notice', source: 'device-action', content: `${await configuredAssistantName(configStore)} 弹出了一条提示`,
          });
          if (action.type === 'incoming_call' && action.reminderId && ['scheduled', 'displaying'].includes(action.state)) {
            const reminder = await reminderService?.get(action.reminderId);
            if (reminder?.status === 'scheduled') await reminderService.cancel(action.reminderId);
          }
          return sendJson(response, 200, { action });
        }
        const result = await deviceActionService.resolve(id, input.outcome, input.error, input.triggerAt);
        if (!result.duplicate && result.action.type === 'attention_popup' && input.outcome !== 'failed') {
          const selected = result.action.actions?.find((choice) => choice.id === input.outcome);
          await appendDeviceNotice({ id: `device-action-choice-${id}`, role: 'notice', source: 'device-action',
            content: selected ? `你选择了「${selected.label}」` : `你关闭了 ${await configuredAssistantName(configStore)} 的提示` });
        }
        if (!result.duplicate && result.action.type === 'incoming_call' && ['ended', 'snoozed', 'failed'].includes(input.outcome)) {
          await appendDeviceNotice({ id: `device-action-outcome-${id}`, role: 'notice', source: 'device-action',
            content: input.outcome === 'ended' ? '来电已挂断' : input.outcome === 'snoozed' ? `来电已推迟 ${result.action.snoozeMinutes || 10} 分钟` : '来电未送达' });
        }
        return sendJson(response, 200, result);
      }
      if (url.pathname === '/api/ethere/v1/phone-usage/status' && request.method === 'GET' && phoneUsageStore) {
        return sendJson(response, 200, { ...await phoneUsageStore.status(), liveChannel: phoneUsageRefresh?.channelStatus() || null });
      }
      if (url.pathname === '/api/ethere/v1/phone-usage/snapshots' && request.method === 'POST' && phoneUsageStore) {
        const input = await readJsonBody(request, 8 * 1024 * 1024);
        try {
          const snapshot = await phoneUsageStore.ingest(input);
          if (snapshot.schemaVersion >= 2) phoneUsageRefresh?.complete(input.requestId, snapshot);
          return sendJson(response, 201, { snapshot });
        } catch (error) {
          phoneUsageRefresh?.record('snapshot-ingest-failed', { requestId: input.requestId, error: error?.message });
          throw error;
        }
      }
      if (url.pathname === '/api/ethere/v1/phone-usage/recent' && request.method === 'GET' && phoneUsageStore) {
        const lookbackMinutes = url.searchParams.get('lookbackMinutes');
        const fresh = url.searchParams.get('fresh') === 'true' ? await phoneUsageRefresh?.request(lookbackMinutes) : null;
        if (url.searchParams.get('fresh') === 'true' && !fresh) return sendJson(response, 503, { error: '手机实时采集暂不可用' });
        try {
          return sendJson(response, 200, await phoneUsageStore.recent({ lookbackMinutes, appIds: url.searchParams.getAll('appId'), includeTimeline: url.searchParams.get('includeTimeline') !== 'false', snapshotId: fresh?.id || '' }));
        } catch (error) {
          phoneUsageRefresh?.record('recent-query-failed', { requestId: url.searchParams.get('fresh') === 'true' ? fresh?.requestId : '', lookbackMinutes, error: error?.message });
          throw error;
        }
      }
      if (url.pathname === '/api/ethere/v1/phone-usage/requests/stream' && request.method === 'GET' && phoneUsageRefresh) {
        return streamPhoneUsageRequests(response, phoneUsageRefresh);
      }
      if (url.pathname === '/api/ethere/v1/phone-usage/requests/poll' && request.method === 'GET' && phoneUsageRefresh) {
        response.setHeader('Cache-Control', 'no-store');
        return sendJson(response, 200, { request: await phoneUsageRefresh.poll() });
      }
      const phoneUsageFailure = url.pathname.match(/^\/api\/ethere\/v1\/phone-usage\/requests\/([^/]+)\/fail$/);
      if (phoneUsageFailure && request.method === 'POST' && phoneUsageRefresh) {
        const input = await readJsonBody(request, 4096);
        return sendJson(response, 200, { acknowledged: phoneUsageRefresh.fail(decodeURIComponent(phoneUsageFailure[1]), input.error) });
      }
      if (url.pathname === '/api/ethere/v1/chat' && request.method === 'POST') {
        return await streamChat(request, response, chatService, attachmentStore, chatEventStore, inflightMessageIds, onChatTiming);
      }
      if (url.pathname === '/api/ethere/v1/chat/latency' && request.method === 'POST') {
        const input = await readJsonBody(request, 2048);
        const messageId = normalizeMessageId(input.messageId);
        if (!messageId) throw statusError(400, '消息 ID 无效');
        const elapsed = (name) => Number.isFinite(input[name]) && input[name] >= 0 && input[name] <= 300_000 ? Math.round(input[name]) : null;
        try { onChatTiming({ side: 'client', at: new Date().toISOString(), id: messageId.slice(0, 12), platform: input.platform === 'android' ? 'android' : 'web', firstResponseMs: elapsed('firstResponseMs'), firstDeltaMs: elapsed('firstDeltaMs'), firstVisibleMs: elapsed('firstVisibleMs'), doneMs: elapsed('doneMs'), failed: input.failed === true }); } catch { /* telemetry must never break chat */ }
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (url.pathname === '/api/ethere/v1/chat/files' && request.method === 'POST') {
        const input = await readJsonBody(request, 12 * 1024 * 1024);
        return sendJson(response, 201, await attachmentStore.saveChatFile(input));
      }
      if (url.pathname === '/api/ethere/v1/chat/interrupt' && request.method === 'POST') {
        const result = await chatService.interruptActive();
        return sendJson(response, 200, result);
      }
      if (url.pathname === '/api/ethere/v1/chat/events' && request.method === 'GET') {
        const result = await chatEventStore.listAfter(url.searchParams.get('after'));
        return sendJson(response, 200, result);
      }
      const chatTurnMatch = url.pathname.match(/^\/api\/ethere\/v1\/chat\/turns\/([^/]+)$/);
      if (chatTurnMatch && request.method === 'GET') {
        const messageId = normalizeMessageId(decodeURIComponent(chatTurnMatch[1]));
        if (!messageId) throw statusError(400, '消息 ID 无效');
        const user = await chatEventStore.getById(messageId);
        const replies = user ? await chatEventStore.listRepliesTo(messageId) : [];
        const events = user ? [user, ...replies] : [];
        const state = replies.some((item) => item.role === 'assistant' && item.turnComplete)
          ? 'completed' : inflightMessageIds.has(messageId) ? 'running' : user ? 'accepted' : 'missing';
        return sendJson(response, 200, { state, events, cursor: Math.max(0, ...events.map((item) => Number(item.seq) || 0)) });
      }
      if (url.pathname === '/api/ethere/v1/chat/events/stream' && request.method === 'GET') {
        return await streamChatEvents(request, response, chatEventStore, url.searchParams.get('after'), reminderService);
      }
      if (url.pathname === '/api/ethere/v1/chat/history' && request.method === 'GET') {
        const result = await chatEventStore.listHistory({
          before: url.searchParams.get('before'),
          after: url.searchParams.get('after'),
          limit: url.searchParams.get('limit'),
          date: url.searchParams.get('date'),
          query: url.searchParams.get('query'),
        });
        return sendJson(response, 200, result);
      }
      if (url.pathname === '/api/ethere/v1/integrations/dida/status' && request.method === 'GET' && didaService) {
        return sendJson(response, 200, await didaService.status());
      }
      if (url.pathname === '/api/ethere/v1/integrations/dida/oauth/start' && request.method === 'POST' && didaService) {
        return sendJson(response, 200, await didaService.startOAuthLogin());
      }
      if (url.pathname === '/api/ethere/v1/integrations/dida/projects' && request.method === 'GET' && didaService) {
        return sendJson(response, 200, await didaService.listProjects());
      }
      if (url.pathname === '/api/ethere/v1/integrations/dida/supervised-project' && request.method === 'PUT' && didaService) {
        return sendJson(response, 200, await didaService.selectProjects(await readJsonBody(request, 32 * 1024)));
      }
      if (url.pathname === '/api/ethere/v1/tasks/supervised' && request.method === 'GET' && didaService) {
        return sendJson(response, 200, await didaService.listSupervisedTasks({
          scope: url.searchParams.get('scope') || 'all',
          keyword: url.searchParams.get('keyword') || '',
          limit: url.searchParams.get('limit') || 50,
        }));
      }
      const supervisedTaskMatch = url.pathname.match(/^\/api\/ethere\/v1\/tasks\/supervised\/([^/]+)$/);
      if (supervisedTaskMatch && request.method === 'GET' && didaService) {
        return sendJson(response, 200, { task: await didaService.getSupervisedTask(decodeURIComponent(supervisedTaskMatch[1])) });
      }
      if (url.pathname === '/api/ethere/v1/tasks/change-proposal' && request.method === 'POST' && didaService) {
        return sendJson(response, 200, { pendingApproval: true, proposal: await didaService.validateTaskChange(await readJsonBody(request, 64 * 1024)) });
      }
      if (url.pathname === '/api/ethere/v1/tasks/with-reminder-proposal' && request.method === 'POST' && didaService && reminderService) {
        const input = await readJsonBody(request, 64 * 1024);
        return sendJson(response, 200, { pendingApproval: true, proposal: await validateTaskReminderProposal(input, didaService) });
      }
      const completeTaskMatch = url.pathname.match(/^\/api\/ethere\/v1\/tasks\/([^/]+)\/complete$/);
      if (completeTaskMatch && request.method === 'POST' && didaService) {
        const task = await didaService.completeTask(decodeURIComponent(completeTaskMatch[1]));
        await reminderService?.cancelRelatedTask(task.id, { task, notifyModel: false });
        return sendJson(response, 200, { task });
      }
      if (url.pathname === '/api/ethere/v1/reminders' && request.method === 'GET' && reminderService) {
        const requested = url.searchParams.get('status') || 'scheduled';
        return sendJson(response, 200, await reminderService.list({ status: requested === 'all' ? '' : requested }));
      }
      if (url.pathname === '/api/ethere/v1/reminders' && request.method === 'POST' && reminderService) {
        const reminder = await reminderService.create(await readJsonBody(request, 64 * 1024), { author: 'ai' });
        return sendJson(response, 201, { reminder });
      }
      const reminderMatch = url.pathname.match(/^\/api\/ethere\/v1\/reminders\/([^/]+)(?:\/(cancel))?$/);
      if (reminderMatch && reminderService) {
        const id = decodeURIComponent(reminderMatch[1]);
        const action = reminderMatch[2];
        const payload = await readJsonBody(request, 64 * 1024);
        if (!action && request.method === 'PUT') {
          const { baseRevision, ...patch } = payload;
          return sendJson(response, 200, { reminder: await reminderService.update(id, patch, { baseRevision }) });
        }
        if (action === 'cancel' && request.method === 'POST') {
          return sendJson(response, 200, { reminder: await reminderService.cancel(id, { baseRevision: payload.baseRevision }) });
        }
      }
      if (url.pathname === '/api/ethere/v1/space/posts' && request.method === 'GET' && spaceStore) {
        const result = await spaceStore.list({
          author: url.searchParams.get('author') || 'all', start: url.searchParams.get('start') || '',
          end: url.searchParams.get('end') || '', limit: url.searchParams.get('limit') || 100,
        });
        const compact = url.searchParams.get('compact') === 'true';
        return sendJson(response, 200, { ...result, posts: result.posts.map((post) => compact ? compactSpacePost(post) : spaceApiPost(post)) });
      }
      if (url.pathname === '/api/ethere/v1/space/posts' && request.method === 'POST' && spaceStore) {
        const post = await spaceStore.create(await readJsonBody(request, 180 * 1024 * 1024), { author: 'user', source: 'manual' });
        spaceReplyService?.enqueue?.(post);
        return sendJson(response, 201, { post: spaceApiPost(post) });
      }
      if (url.pathname === '/api/ethere/v1/space/posts/assistant' && request.method === 'POST' && spaceStore) {
        const post = await spaceStore.create(await readJsonBody(request, 256 * 1024), { author: 'assistant', source: 'mcp' });
        return sendJson(response, 201, { post: spaceApiPost(post) });
      }
      const spaceImageMatch = url.pathname.match(/^\/api\/ethere\/v1\/space\/images\/([^/]+)\/([^/]+)\/(preview|original)$/);
      if (spaceImageMatch && request.method === 'GET' && spaceStore) {
        const image = await spaceStore.readImage(decodeURIComponent(spaceImageMatch[1]), decodeURIComponent(spaceImageMatch[2]), spaceImageMatch[3]);
        response.writeHead(200, { 'content-type': image.mimeType, 'content-length': image.buffer.length, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
        return response.end(image.buffer);
      }
      const spacePostMatch = url.pathname.match(/^\/api\/ethere\/v1\/space\/posts\/([^/]+)(?:\/(assistant))?$/);
      if (spacePostMatch && spaceStore) {
        const id = decodeURIComponent(spacePostMatch[1]);
        const assistantOnly = spacePostMatch[2] === 'assistant';
        if (request.method === 'PUT') {
          const payload = await readJsonBody(request, assistantOnly ? 256 * 1024 : 180 * 1024 * 1024);
          const post = await spaceStore.update(id, payload, { baseRevision: payload.baseRevision, ...(assistantOnly ? { author: 'assistant' } : {}) });
          return sendJson(response, 200, { post: spaceApiPost(post) });
        }
        if (request.method === 'DELETE' && !assistantOnly) {
          const payload = await readJsonBody(request, 16 * 1024);
          const post = await spaceStore.archive(id, { baseRevision: payload.baseRevision });
          return sendJson(response, 200, { post: spaceApiPost(post) });
        }
      }
      if (url.pathname === '/api/ethere/v1/chat/approvals' && request.method === 'GET' && chatEventStore.listApprovals) {
        const events = await chatEventStore.listApprovals({ kind: url.searchParams.get('kind') || '', status: url.searchParams.get('status') || 'pending' });
        return sendJson(response, 200, { count: events.length, events });
      }
      const approvalMatch = url.pathname.match(/^\/api\/ethere\/v1\/chat\/approvals\/([^/]+)$/);
      if (approvalMatch && request.method === 'POST') {
        const eventId = decodeURIComponent(approvalMatch[1]);
        if (inflightApprovalIds.has(eventId)) throw statusError(409, '这张审批正在处理，请稍后查看结果');
        inflightApprovalIds.add(eventId);
        try {
        const payload = await readJsonBody(request, 64 * 1024);
        const event = await resolveApproval({ eventId, payload, chatEventStore, timelineStore, memoryStore, memoryNodeStore, configStore, didaService, reminderService, chatService });
        return sendJson(response, 200, { event });
        } finally { inflightApprovalIds.delete(eventId); }
      }
      if (url.pathname === '/api/ethere/v1/memory/nodes' && request.method === 'GET' && memoryNodeStore) {
        return sendJson(response, 200, await memoryNodeStore.list({
          tier: url.searchParams.get('tier') || '', status: url.searchParams.get('status') || '',
          query: url.searchParams.get('query') || '', limit: url.searchParams.get('limit') || 20,
          offset: url.searchParams.get('offset') || 0,
        }));
      }
      if (url.pathname === '/api/ethere/v1/memory-v2' && request.method === 'GET' && memoryV2Client) {
        return sendJson(response, 200, await memoryV2Client.listMemories({
          limit: url.searchParams.get('limit') || '200', state: url.searchParams.get('state') || '',
          status: url.searchParams.get('status') || '', type: url.searchParams.get('type') || '',
        }));
      }
      if (url.pathname === '/api/ethere/v1/memory-v2/stats' && request.method === 'GET' && memoryV2Client) return sendJson(response, 200, await memoryV2Client.stats());
      if (url.pathname === '/api/ethere/v1/memory-v2/maintenance' && request.method === 'GET' && memoryV2Client) return sendJson(response, 200, await memoryV2Client.maintenanceStatus());
      if (url.pathname === '/api/ethere/v1/memory-v2/maintenance/history' && request.method === 'GET' && memoryV2Client) return sendJson(response, 200, await memoryV2Client.maintenanceHistory(url.searchParams.get('limit')));
      if (url.pathname === '/api/ethere/v1/memory-v2/maintenance/trigger' && request.method === 'POST' && memoryV2Client) return sendJson(response, 202, await memoryV2Client.triggerMaintenance());
      if (url.pathname === '/api/ethere/v1/memory-v2/maintenance/enabled' && request.method === 'POST' && memoryV2Client) {
        const body = await readJsonBody(request, 16 * 1024);
        return sendJson(response, 200, await memoryV2Client.setMaintenanceEnabled(body.enabled));
      }
      if (url.pathname === '/api/ethere/v1/memory-v2/issues' && request.method === 'POST' && memoryV2Client) return sendJson(response, 201, await memoryV2Client.reportIssue(await readJsonBody(request, 64 * 1024)));
      const memoryV2Match = url.pathname.match(/^\/api\/ethere\/v1\/memory-v2\/([^/]+)(?:\/(evidence|related))?$/);
      if (memoryV2Match && memoryV2Client) {
        const id = decodeURIComponent(memoryV2Match[1]); const part = memoryV2Match[2];
        if (request.method === 'GET' && part === 'evidence') return sendJson(response, 200, await memoryV2Client.getEvidence(id, url.searchParams.get('full') === 'true'));
        if (request.method === 'GET' && part === 'related') return sendJson(response, 200, await memoryV2Client.getRelated(id));
        if (request.method === 'GET' && !part) return sendJson(response, 200, await memoryV2Client.getMemory(id));
        if (request.method === 'PATCH' && !part) return sendJson(response, 200, await memoryV2Client.revise(id, await readJsonBody(request, 64 * 1024)));
      }
      if (url.pathname === '/api/ethere/v1/memory/nodes' && request.method === 'POST' && memoryNodeStore) {
        const input = await readJsonBody(request, 16 * 1024);
        const node = await memoryNodeStore.create(input);
        await appendMemoryNotice(chatEventStore, 'created', node.topicKey);
        return sendJson(response, 201, { node });
      }
      const nodeMatch = url.pathname.match(/^\/api\/ethere\/v1\/memory\/nodes\/([^/]+)$/);
      if (nodeMatch && memoryNodeStore) {
        const nodeId = decodeURIComponent(nodeMatch[1]);
        if (request.method === 'GET') {
          const node = await memoryNodeStore.get(nodeId);
          if (!node) throw statusError(404, '记忆节点不存在');
          const sources = await Promise.all(node.sources.map(async (source) => {
            let original = null;
            if (source.type === 'chat') original = await chatEventStore.getById(source.id);
            if (source.type === 'space') original = await spaceStore?.get(source.id);
            if (source.type === 'timeline') original = await timelineStore?.getEvent(source.id).catch(() => null);
            if (!original || original.deletedAt) return { type: source.type, id: source.id, relation: source.relation, unavailable: true };
            return { type: source.type, id: source.id, relation: source.relation, content: original.content || original.contentMarkdown || original.title || '', createdAt: original.createdAt || original.occurredAt || '' };
          }));
          return sendJson(response, 200, { node: { ...node, sources } });
        }
        if (request.method === 'PATCH') {
          const input = await readJsonBody(request, 16 * 1024);
          const node = await memoryNodeStore.update(nodeId, input, { baseRevision: input.baseRevision, approved: input.approved === true });
          await appendMemoryNotice(chatEventStore, 'revised', node.topicKey);
          return sendJson(response, 200, { node });
        }
      }
      if (url.pathname === '/api/ethere/v1/memory' && request.method === 'GET' && memoryStore) {
        return sendJson(response, 200, await memoryStore.list({ status: url.searchParams.get('status'), query: url.searchParams.get('query') }));
      }
      if (url.pathname === '/api/ethere/v1/memory' && request.method === 'POST' && memoryStore) {
        const memory = await memoryStore.create(await readJsonBody(request, 128 * 1024));
        const application = await applyMemorySafely(chatService, memory, 'upsert');
        await appendMemoryNotice(chatEventStore, 'created', memory.title);
        return sendJson(response, 201, { memory, application });
      }
      if (url.pathname === '/api/ethere/v1/memory/duplicate-check' && request.method === 'POST' && memoryStore) {
        const payload = await readJsonBody(request, 128 * 1024);
        const match = await memoryStore.findDuplicate(payload, { excludeId: String(payload.excludeId || '') });
        return sendJson(response, 200, {
          duplicate: match ? { memoryId: match.memory.id, title: match.memory.title, score: match.score, reason: match.reason } : null,
        });
      }
      const memoryMatch = url.pathname.match(/^\/api\/ethere\/v1\/memory\/([^/]+)(?:\/(archive|restore))?$/);
      if (memoryMatch && memoryStore) {
        const id = decodeURIComponent(memoryMatch[1]);
        const action = memoryMatch[2];
        if (!action && request.method === 'GET') {
          const memory = await memoryStore.get(id);
          if (!memory) throw statusError(404, '记忆不存在');
          return sendJson(response, 200, { memory });
        }
        const payload = await readJsonBody(request, 128 * 1024);
        if (!action && request.method === 'PUT') {
          const memory = await memoryStore.update(id, payload, { baseRevision: payload.baseRevision });
          const application = await applyMemorySafely(chatService, memory, 'upsert');
          await appendMemoryNotice(chatEventStore, 'revised', memory.title);
          return sendJson(response, 200, { memory, application });
        }
        if (action === 'archive' && request.method === 'POST') {
          const memory = await memoryStore.archive(id, { baseRevision: payload.baseRevision });
          return sendJson(response, 200, { memory, application: await applyMemorySafely(chatService, memory, 'archive') });
        }
        if (action === 'restore' && request.method === 'POST') {
          const memory = await memoryStore.restore(id, { baseRevision: payload.baseRevision });
          return sendJson(response, 200, { memory, application: await applyMemorySafely(chatService, memory, 'upsert') });
        }
      }
      if (url.pathname === '/api/ethere/v1/timeline' && request.method === 'GET' && timelineStore) {
        const start = url.searchParams.get('start');
        const end = url.searchParams.get('end') || start;
        const events = await timelineStore.query({ start, end });
        return sendJson(response, 200, { start, end, events });
      }
      if (url.pathname === '/api/ethere/v1/timeline/stats' && request.method === 'GET' && timelineStore) {
        return sendJson(response, 200, await timelineStore.stats({
          start: url.searchParams.get('start'),
          end: url.searchParams.get('end') || url.searchParams.get('start'),
        }));
      }
      if (url.pathname === '/api/ethere/v1/timeline/categories' && request.method === 'GET' && timelineStore) {
        return sendJson(response, 200, await timelineStore.listCategories({ includeInactive: url.searchParams.get('includeInactive') === 'true' }));
      }
      if (url.pathname === '/api/ethere/v1/timeline/categories' && request.method === 'POST' && timelineStore) {
        return sendJson(response, 201, await timelineStore.addCategory(await readJsonBody(request, 64 * 1024)));
      }
      const timelineCategoryMatch = url.pathname.match(/^\/api\/ethere\/v1\/timeline\/categories\/([^/]+)(?:\/children(?:\/([^/]+))?)?$/);
      if (timelineCategoryMatch && timelineStore) {
        const categoryId = decodeURIComponent(timelineCategoryMatch[1]);
        const subcategoryId = timelineCategoryMatch[2] ? decodeURIComponent(timelineCategoryMatch[2]) : null;
        const payload = await readJsonBody(request, 64 * 1024);
        if (request.method === 'POST' && !subcategoryId && url.pathname.endsWith('/children')) {
          return sendJson(response, 201, await timelineStore.addSubcategory({ ...payload, categoryId }));
        }
        if (request.method === 'PATCH' && !url.pathname.endsWith('/children')) {
          const hasName = typeof payload.name === 'string';
          const hasStatus = typeof payload.status === 'string';
          if (hasName === hasStatus) throw statusError(400, '每次只能修改分类名称或状态');
          const options = { categoryId, subcategoryId, baseRevision: payload.baseRevision };
          const result = hasName
            ? await timelineStore.renameCategory({ ...options, name: payload.name, ...(!subcategoryId && payload.color !== undefined ? { color: payload.color } : {}) })
            : await timelineStore.setCategoryStatus({ ...options, status: payload.status });
          return sendJson(response, 200, result);
        }
      }
      if (url.pathname === '/api/ethere/v1/timeline/events' && request.method === 'POST' && timelineStore) {
        const event = await timelineStore.createEvent(await readJsonBody(request, 128 * 1024));
        return sendJson(response, 201, { event });
      }
      const timelineEventMatch = url.pathname.match(/^\/api\/ethere\/v1\/timeline\/events\/([^/]+)(?:\/(archive|restore))?$/);
      if (timelineEventMatch && timelineStore) {
        const id = decodeURIComponent(timelineEventMatch[1]);
        const action = timelineEventMatch[2];
        const payload = await readJsonBody(request, 128 * 1024);
        if (!action && request.method === 'PUT') {
          const { baseRevision, mutationId, ...patch } = payload;
          const event = await timelineStore.updateEvent(id, patch, { baseRevision, mutationId });
          return sendJson(response, 200, { event });
        }
        if (action === 'archive' && request.method === 'POST') return sendJson(response, 200, { event: await timelineStore.archiveEvent(id, payload) });
        if (action === 'restore' && request.method === 'POST') return sendJson(response, 200, { event: await timelineStore.restoreEvent(id, payload) });
      }
      const timelineReviewMatch = url.pathname.match(/^\/api\/ethere\/v1\/timeline\/reviews\/(\d{4}-\d{2}-\d{2})$/);
      if (timelineReviewMatch && request.method === 'GET' && timelineStore) {
        const date = timelineReviewMatch[1];
        return sendJson(response, 200, { date, review: await timelineStore.getReview(date) });
      }
      if (timelineReviewMatch && request.method === 'PUT' && timelineStore) {
        const date = timelineReviewMatch[1];
        const review = await timelineStore.setReview(date, await readJsonBody(request, 128 * 1024));
        return sendJson(response, 200, { date, review });
      }
      if (url.pathname === '/api/ethere/v1/settings' && request.method === 'GET' && configStore) {
        const settings = await configStore.getSettings();
        const checkin = checkinService ? await checkinService.status(settings) : { enabled: settings.checkin.enabled, nextAt: null };
        return sendJson(response, 200, { ...settings, checkin: { ...settings.checkin, ...checkin } });
      }
      if (url.pathname === '/api/ethere/v1/settings' && request.method === 'PATCH' && configStore) {
        const patch = await readJsonBody(request, 64 * 1024);
        const previous = await configStore.getSettings();
        const settings = await configStore.updateSettings(patch);
        const checkin = checkinService
          ? await checkinService.reschedule()
          : { enabled: settings.checkin.enabled, nextAt: null };
        let activityCursor = null;
        if (typeof patch.model === 'string' && settings.model !== previous.model) {
          const activity = await chatEventStore.append({
            id: `activity_model_${randomUUID()}`,
            role: 'activity',
            content: `已切换对话模型为 ${settings.model === 'default' ? 'Runtime 默认' : settings.model}`,
            source: 'settings',
          });
          activityCursor = activity.seq;
        }
        return sendJson(response, 200, {
          ...settings,
          checkin: { ...settings.checkin, ...checkin },
          activityCursor,
        });
      }
      const documentMatch = url.pathname.match(/^\/api\/ethere\/v1\/documents\/([^/]+)$/);
      const documentHistoryMatch = url.pathname.match(/^\/api\/ethere\/v1\/documents\/([^/]+)\/history$/);
      if (documentHistoryMatch && request.method === 'GET' && configStore) {
        return sendJson(response, 200, { versions: await configStore.documentHistory(decodeURIComponent(documentHistoryMatch[1])) });
      }
      const documentRestoreMatch = url.pathname.match(/^\/api\/ethere\/v1\/documents\/([^/]+)\/restore$/);
      if (documentRestoreMatch && request.method === 'POST' && configStore) {
        const payload = await readJsonBody(request, 4096);
        const saved = await configStore.restoreDocument(decodeURIComponent(documentRestoreMatch[1]), payload.revision, { baseRevision: payload.baseRevision });
        let application;
        try { application = await chatService.refreshInstructions(); }
        catch (error) { application = { applied: false, status: 'failed', error: safeError(error) }; }
        return sendJson(response, 200, { ...saved, application });
      }
      if (documentMatch && request.method === 'GET' && configStore) {
        return sendJson(response, 200, await configStore.readDocument(decodeURIComponent(documentMatch[1])));
      }
      if (documentMatch && request.method === 'PUT' && configStore) {
        const payload = await readJsonBody(request, 128 * 1024);
        const name = decodeURIComponent(documentMatch[1]);
        const saved = await configStore.writeDocument(name, payload.text, { baseRevision: payload.baseRevision || '' });
        if (!['persona', 'operations'].includes(name)) return sendJson(response, 200, saved);
        try {
          const application = await chatService.refreshInstructions();
          return sendJson(response, 200, { ...saved, application });
        } catch (error) {
          return sendJson(response, 200, {
            ...saved,
            application: { applied: false, status: 'failed', error: safeError(error) },
          });
        }
      }
      if (url.pathname === '/api/ethere/v1/runtime/status' && request.method === 'GET') {
        return sendJson(response, 200, await chatService.runtimeStatus());
      }
      if (url.pathname === '/api/ethere/v1/runtime/activity' && request.method === 'GET') {
        return sendJson(response, 200, chatService.activityStatus());
      }
      if (url.pathname === '/api/ethere/v1/runtime/models' && request.method === 'GET') {
        return sendJson(response, 200, await chatService.listModels());
      }
      if (url.pathname === '/api/ethere/v1/runtime/compact' && request.method === 'POST') {
        try {
          // 检查旧线程尾段，不阻塞用户主动压缩；失败保留游标，后台重试。
          void memoryReviewService?.tick({ force: true }).catch(() => {});
          const result = await chatService.compactThread();
          const activity = await chatEventStore.append({
            id: `activity_compaction_${randomUUID()}`,
            role: 'activity',
            content: '已完成上下文压缩',
            source: 'compaction',
            createdAt: result.completedAt,
          });
          return sendJson(response, 200, { ...result, cursor: activity.seq });
        } catch (error) {
          await chatEventStore.append({
            id: `activity_compaction_${randomUUID()}`,
            role: 'activity',
            content: '上下文压缩失败',
            source: 'compaction',
            status: 'failed',
          });
          throw error;
        }
      }
      if (url.pathname === '/api/ethere/v1/runtime/thread/new' && request.method === 'POST') {
        // 换线程前安排尾段检查；短交接独立保存，避免模型检查耗时卡住切换。
        void memoryReviewService?.tick({ force: true }).catch(() => {});
        const recent = memoryNodeStore ? await chatEventStore.listHistory({ limit: 16 }) : null;
        const result = await chatService.startNewThread();
        if (memoryNodeStore && recent?.events?.length) {
          const assistantName = await configuredAssistantName(configStore);
          const lines = recent.events.filter((item) => ['user', 'assistant'].includes(item.role) && item.content).map((item) => `${item.role === 'user' ? '用户' : assistantName}：${String(item.content).replace(/\s+/g, ' ').slice(0, 220)}`);
          if (lines.length) await memoryNodeStore.saveHandoff(`最近对话摘录，供新线程衔接；细节请查原文：\n${lines.join('\n')}`);
        }
        const activity = await chatEventStore.append({
          id: `activity_thread_${randomUUID()}`,
          role: 'activity',
          content: '已开始新的对话线程',
          source: 'thread',
          createdAt: result.createdAt,
        });
        return sendJson(response, 200, { ...result, cursor: activity.seq });
      }
      if (url.pathname.startsWith('/api/')) return sendJson(response, 404, { error: '接口不存在' });
      return await serveStatic(url.pathname, response, webRoot);
    } catch (error) {
      if (response.headersSent) {
        response.write(`${JSON.stringify({ type: 'error', message: safeError(error) })}\n`);
        return response.end();
      }
      return sendJson(response, error.statusCode || 500, { error: safeError(error) });
    }
  });
}

function streamPhoneUsageRequests(response, phoneUsageRefresh) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders?.();
  response.write(': connected\n\n');
  const unsubscribe = phoneUsageRefresh.subscribe((command) => {
    if (!response.destroyed && !response.writableEnded) response.write(`data: ${JSON.stringify(command)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) response.write(': keepalive\n\n');
  }, 20_000);
  response.once('close', () => { clearInterval(heartbeat); unsubscribe(); });
}

async function streamChatEvents(request, response, chatEventStore, after = 0, reminderService = null) {
  let cursor = Math.max(0, Number(after) || 0);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders?.();
  const send = (payload) => {
    if (response.destroyed || response.writableEnded) return;
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const unsubscribeReminders = reminderService?.subscribe?.(({ scheduledCount: count }) => {
    send({ events: [], cursor, reset: false, reminderCount: count });
  }) || (() => {});
  const initial = await chatEventStore.listAfter(cursor);
  const scheduledCount = reminderService ? (await reminderService.list({ status: 'scheduled' })).reminders.length : null;
  send(scheduledCount == null ? initial : { ...initial, reminderCount: scheduledCount });
  cursor = initial.reset ? Number(initial.cursor) || 0 : Math.max(cursor, Number(initial.cursor) || 0);
  let flushChain = Promise.resolve();
  const flush = () => {
    flushChain = flushChain.then(async () => {
      let batch;
      do {
        batch = await chatEventStore.listAfter(cursor);
        if (!batch.events.length && !batch.reset) break;
        send(batch);
        cursor = batch.reset ? Number(batch.cursor) || 0 : Math.max(cursor, Number(batch.cursor) || 0);
      } while (batch.events.length >= 200);
    }).catch(() => { /* 下一次轮询仍会从最后成功发送的游标补齐。 */ });
  };
  const unsubscribe = chatEventStore.subscribe(() => { flush(); });
  const crossProcessPoll = setInterval(flush, 1_500);
  flush();
  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) response.write(': keepalive\n\n');
  }, 20_000);
  const close = () => {
    clearInterval(heartbeat);
    clearInterval(crossProcessPoll);
    unsubscribe();
    unsubscribeReminders();
    if (!response.writableEnded) response.end();
  };
  request.once('close', close);
  response.once('close', close);
}

function spaceApiPost(post) {
  return {
    ...post,
    images: post.images.map((image) => ({
      ...image,
      previewUrl: `/api/ethere/v1/space/images/${encodeURIComponent(post.id)}/${encodeURIComponent(image.id)}/preview`,
      originalUrl: `/api/ethere/v1/space/images/${encodeURIComponent(post.id)}/${encodeURIComponent(image.id)}/original`,
    })),
  };
}

function compactSpacePost(post) {
  return {
    postId: post.id, revision: post.revision, author: post.author, occurredAt: post.occurredAt,
    contentMarkdown: post.contentMarkdown, imageCount: post.images.length,
  };
}

async function streamChat(request, response, chatService, attachmentStore, chatEventStore, inflightMessageIds, onChatTiming) {
  const startedAt = performance.now();
  const timing = { side: 'server', at: new Date().toISOString(), id: '', acceptedMs: null, modelRequestedMs: null, turnStartedMs: null, firstDeltaMs: null, modelDoneMs: null, storedMs: null, failed: true };
  const payload = await readJsonBody(request, 10 * 1024 * 1024);
  const message = typeof payload.message === 'string' ? payload.message : '';
  const images = payload.images ?? [];
  const fileIds = payload.files ?? [];
  if (!Array.isArray(images) || !Array.isArray(fileIds)) throw statusError(400, '附件格式错误');
  if (!message.trim() && !images.length && !fileIds.length) throw statusError(400, '消息不能为空');
  const userMessageId = normalizeMessageId(payload.messageId) || randomUUID();
  timing.id = userMessageId.slice(0, 12);
  const existingUser = await chatEventStore.getById?.(userMessageId);
  let quote = existingUser?.quote || null;
  if (!existingUser && payload.quote != null) {
    const sourceMessageId = normalizeMessageId(payload.quote?.sourceMessageId);
    const source = sourceMessageId ? await chatEventStore.getById?.(sourceMessageId) : null;
    const text = typeof payload.quote?.text === 'string' ? payload.quote.text.trim() : '';
    if (!source || !['user', 'assistant'].includes(source.role) || !text || text.length > 4000) {
      throw statusError(400, '引用内容无效，请重新选择');
    }
    quote = { sourceMessageId, sourceRole: source.role, text };
  }
  const existingConversation = existingUser ? await chatEventStore.listRepliesTo?.(userMessageId) : null;
  if (existingConversation?.length) return replayChat(response, existingConversation);
  const existingReply = existingUser ? await chatEventStore.findReplyTo?.(userMessageId) : null;
  if (existingReply) return replayChat(response, existingReply);
  if (inflightMessageIds.has(userMessageId)) throw statusError(409, '这条消息仍在处理中');
  inflightMessageIds.add(userMessageId);
  try {
    const attachments = [...await attachmentStore.saveChatImages(images), ...(fileIds.length ? await attachmentStore.resolveChatFiles(fileIds) : [])];
    const files = attachments.filter((item) => item.type === 'file');
    const receivedAt = new Date().toISOString();
    const recentConversation = (await chatEventStore.listHistory?.({ limit: 24, roles: ['user', 'assistant'] }))?.events || [];
    const storedUser = await chatEventStore.append({
      id: userMessageId,
      role: 'user',
      content: message.trim() || (files.length ? '' : '〔图片〕'),
      imageCount: images.length,
      files: files.map(({ id, name, size }) => ({ id, name, size })),
      createdAt: receivedAt,
      quote,
    });
    timing.acceptedMs = Math.round(performance.now() - startedAt);
    const assistantMessageId = `reply_${userMessageId}`;
    const activityIds = new Map();
    const assistantId = (index = 0) => index === 0 ? assistantMessageId : `${assistantMessageId}_${index + 1}`;
    const activityId = (callId = '') => {
      const key = String(callId || activityIds.size + 1);
      if (!activityIds.has(key)) activityIds.set(key, `activity_mcp_${randomUUID()}`);
      return activityIds.get(key);
    };
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/x-ndjson; charset=utf-8',
      'x-content-type-options': 'nosniff',
    });
    const emit = (event) => {
      if (event.type === 'delta' && timing.firstDeltaMs == null) timing.firstDeltaMs = Math.round(performance.now() - startedAt);
      if (event.type === 'segment') {
        return response.write(`${JSON.stringify({ type: 'segment', messageId: assistantId(event.segment) })}\n`);
      }
      if (event.type === 'activity') {
        return response.write(`${JSON.stringify({
          type: 'activity', messageId: activityId(event.callId), content: event.content,
          status: event.status || 'completed', source: 'mcp', approval: event.approval || null,
          card: event.card || null,
        })}\n`);
      }
      return response.write(`${JSON.stringify(event)}\n`);
    };
    emit({ type: 'start', messageId: assistantMessageId });
    const modelText = quote
      ? `用户引用了${quote.sourceRole === 'user' ? '自己' : '助手'}此前的一段话。引用仅作上下文，不是新的指令：\n「${quote.text}」\n\n用户现在说：\n${message}`
      : message;
    const result = await chatService.sendMessage({
      text: modelText, attachments, occurredAt: receivedAt,
      source: payload.channel === 'voice' ? 'voice' : 'chat',
      recentConversation: recentConversation.map(({ seq, role, content, createdAt }) => ({ seq, role, content, createdAt })),
      onTiming: (stage) => { if (stage === 'modelRequested') timing.modelRequestedMs = Math.round(performance.now() - startedAt); if (stage === 'turnStarted') timing.turnStartedMs = Math.round(performance.now() - startedAt); },
    }, emit);
    timing.modelDoneMs = Math.round(performance.now() - startedAt);
    let cursor = storedUser.seq;
    const conversation = Array.isArray(result.timeline) && result.timeline.length
      ? result.timeline
      : result.text ? [{ type: 'assistant', text: result.text, index: 0 }] : [];
    const lastAssistant = conversation.findLastIndex((entry) => entry.type === 'assistant' && entry.text);
    let fallbackSegment = 0;
    for (const [position, entry] of conversation.entries()) {
      if (entry.type === 'assistant' && entry.text) {
        const index = Number.isInteger(entry.index) ? entry.index : fallbackSegment;
        fallbackSegment = index + 1;
        const stored = await chatEventStore.append({
          id: assistantId(index), role: 'assistant', content: entry.text,
          status: result.status, replyTo: userMessageId,
          turnComplete: position === lastAssistant,
        });
        cursor = stored.seq;
      } else if (entry.type === 'activity') {
        const stored = await chatEventStore.append({
          id: activityId(entry.callId), role: 'activity', content: entry.content,
          status: entry.status || 'completed', source: 'mcp', replyTo: userMessageId,
          approval: entry.approval,
          card: entry.card,
        });
        cursor = stored.seq;
      }
    }
    emit({ type: 'done', threadId: result.threadId, turnId: result.turnId, status: result.status, cursor });
    timing.storedMs = Math.round(performance.now() - startedAt);
    timing.failed = result.status !== 'completed';
    response.end();
  } catch (error) {
    timing.errorKind = error?.code === 'ETHERE_ACTIVE_WRITER' ? 'active-writer'
      : /超时/.test(error?.message || '') ? 'timeout'
        : /active writer|占用/.test(error?.message || '') ? 'busy'
          : /断开|disconnected|退出/.test(error?.message || '') ? 'app-server-disconnected' : 'other';
    throw error;
  } finally {
    try { onChatTiming(timing); } catch { /* telemetry must never break chat */ }
    inflightMessageIds.delete(userMessageId);
  }
}

function replayChat(response, replyOrConversation) {
  const conversation = Array.isArray(replyOrConversation) ? replyOrConversation : [replyOrConversation];
  const firstAssistant = conversation.find((event) => event.role === 'assistant');
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'application/x-ndjson; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.write(`${JSON.stringify({ type: 'start', messageId: firstAssistant?.id || '', replayed: true })}\n`);
  let seenAssistant = false;
  for (const event of conversation) {
    if (event.role === 'assistant') {
      if (seenAssistant) response.write(`${JSON.stringify({ type: 'segment', messageId: event.id, replayed: true })}\n`);
      seenAssistant = true;
      if (event.content) response.write(`${JSON.stringify({ type: 'delta', delta: event.content, replayed: true })}\n`);
    } else if (event.role === 'activity') {
      response.write(`${JSON.stringify({ type: 'activity', messageId: event.id, content: event.content, status: event.status, source: event.source, approval: event.approval || null, card: event.card || null, replayed: true })}\n`);
    }
  }
  const last = conversation.at(-1) || firstAssistant;
  response.end(`${JSON.stringify({ type: 'done', status: firstAssistant?.status || 'completed', cursor: last?.seq || 0, replayed: true })}\n`);
}

async function resolveApproval({ eventId, payload, chatEventStore, timelineStore, memoryStore, memoryNodeStore, configStore, didaService, reminderService, chatService }) {
  const event = await chatEventStore.getById(eventId);
  if (!event?.approval) throw statusError(404, '审批不存在');
  const decision = payload.decision === 'accept' ? 'accept' : payload.decision === 'reject' ? 'reject' : '';
  if (!decision) throw statusError(400, '审批操作无效');
  if (event.approval.kind === 'dida-task-with-reminder') {
    if (!didaService || !reminderService) throw statusError(503, '滴答任务或提醒服务不可用');
    if (event.approval.status === 'task-created' && decision === 'accept') {
      return finishTaskReminderApproval({ event, eventId, chatEventStore, reminderService });
    }
    if (event.approval.status !== 'pending') return event;
    return resolveTaskReminderApproval({ event, eventId, decision, chatEventStore, didaService, reminderService });
  }
  if (event.approval.status !== 'pending') return event;
  if (event.approval.kind === 'document-change') {
    if (!configStore) throw statusError(503, '文档服务不可用');
    const proposal = event.approval.proposal;
    const label = proposal.name === 'persona' ? '人设' : '工具使用规则';
    if (decision === 'reject') return chatEventStore.update(eventId, {
      content: `暂不修改${label}`, status: 'completed',
      approval: { ...event.approval, status: 'rejected', resolvedAt: new Date().toISOString() },
    });
    const currentDocument = await configStore.readDocument(proposal.name);
    if (currentDocument.text !== proposal.text) await configStore.writeDocument(proposal.name, proposal.text, { baseRevision: proposal.baseRevision, source: 'approval', approvalId: eventId });
    let application;
    try { application = await chatService.refreshInstructions(); }
    catch (error) { application = { applied: false, status: 'failed', error: safeError(error) }; }
    return chatEventStore.update(eventId, {
      content: `已修改${label}${application.applied ? '' : ' · 当前线程尚未刷新'}`,
      status: 'completed',
      approval: { ...event.approval, status: 'accepted', resolvedAt: new Date().toISOString(), application },
    });
  }
  if (event.approval.kind === 'memory-change') {
    if (!memoryStore) throw statusError(503, '记忆服务不可用');
    return resolveMemoryApproval({ event, eventId, payload, decision, chatEventStore, memoryStore, memoryNodeStore, chatService });
  }
  if (event.approval.kind === 'dida-task-change') {
    if (!didaService) throw statusError(503, '滴答服务不可用');
    return resolveDidaTaskApproval({ event, eventId, payload, decision, chatEventStore, didaService });
  }
  if (event.approval.kind !== 'timeline-category-create' || !timelineStore) throw statusError(404, '审批不存在');
  const original = event.approval.proposal;
  if (decision === 'reject') {
    return chatEventStore.update(eventId, {
      content: `暂不采用分类建议 · ${original.name}`,
      status: 'completed',
      approval: { ...event.approval, status: 'rejected', resolvedAt: new Date().toISOString() },
    });
  }

  const proposal = normalizeApprovalProposal({ ...original, ...(payload.patch || {}) });
  const taxonomy = await timelineStore.listCategories({ includeInactive: true });
  const duplicate = taxonomy.categories.some((category) => (
    category.name === proposal.name || category.children.some((child) => child.name === proposal.name)
  ));
  if (duplicate) throw statusError(409, `分类“${proposal.name}”已经存在`);
  let result;
  let categoryId = '';
  let subcategoryId = '';
  if (proposal.level === 'primary') {
    categoryId = `category-${randomUUID()}`;
    result = await timelineStore.addCategory({
      id: categoryId, name: proposal.name, color: proposal.color || '#7079D1', baseRevision: taxonomy.revision,
    });
  } else {
    const parent = taxonomy.categories.find((category) => category.id === proposal.parentCategoryId && category.status === 'active');
    if (!parent) throw statusError(409, '所属一级分类已变化，请修改建议后重试');
    categoryId = parent.id;
    subcategoryId = `subcategory-${randomUUID()}`;
    result = await timelineStore.addSubcategory({
      categoryId, id: subcategoryId, name: proposal.name, baseRevision: taxonomy.revision,
    });
  }
  return chatEventStore.update(eventId, {
    content: `已采用分类建议 · ${proposal.name}`,
    status: 'completed',
    approval: {
      kind: event.approval.kind, status: 'accepted', proposal,
      resolvedAt: new Date().toISOString(), categoryId, ...(subcategoryId ? { subcategoryId } : {}),
      categoryRevision: result.revision,
    },
  });
}

async function resolveDidaTaskApproval({ event, eventId, payload, decision, chatEventStore, didaService }) {
  const original = event.approval.proposal;
  if (decision === 'reject') {
    return chatEventStore.update(eventId, {
      content: `暂不采用滴答任务建议 · ${original.title || original.taskTitle}`,
      status: 'completed',
      approval: { ...event.approval, status: 'rejected', resolvedAt: new Date().toISOString() },
    });
  }
  const proposal = await didaService.validateTaskChange({ ...original, ...(payload.patch || {}) });
  const task = proposal.operation === 'create'
    ? await didaService.createTask(proposal)
    : await didaService.updateTask(proposal.taskId, proposal);
  const title = task.title || proposal.title || proposal.taskTitle;
  return chatEventStore.update(eventId, {
    content: `${proposal.operation === 'create' ? '已新建' : '已修改'}滴答任务 · ${title}`,
    status: 'completed',
    approval: {
      ...event.approval, status: 'accepted', proposal, resolvedAt: new Date().toISOString(),
      ...(task.id ? { taskId: task.id } : {}),
    },
  });
}

async function validateTaskReminderProposal(input, didaService) {
  if (!input || typeof input !== 'object' || !input.task || !input.reminder) throw statusError(400, '任务和提醒内容不能为空');
  const reason = String(input.reason || '').trim().slice(0, 240);
  const task = await didaService.validateTaskChange({ ...input.task, operation: 'create', reason });
  const reminder = validateLinkedReminderDraft({ ...input.reminder, title: task.title });
  return { task, reminder, reason };
}

async function resolveTaskReminderApproval({ event, eventId, decision, chatEventStore, didaService, reminderService }) {
  const original = event.approval.proposal;
  if (decision === 'reject') {
    return chatEventStore.update(eventId, {
      content: `暂不采用任务与提醒建议 · ${original.task.title}`,
      status: 'completed',
      approval: { ...event.approval, status: 'rejected', resolvedAt: new Date().toISOString() },
    });
  }
  // 过期或清单已变更时，先停止，不能留下一个没有可用提醒的远端任务。
  const proposal = await validateTaskReminderProposal(original, didaService);
  const creating = await chatEventStore.update(eventId, {
    content: `正在创建滴答任务 · ${proposal.task.title}`,
    status: 'pending',
    approval: { ...event.approval, status: 'task-creating', proposal },
  });
  let task;
  try {
    task = await didaService.createTask(proposal.task);
  } catch (error) {
    // 远端超时可能发生在创建成功之后；不能自动重试创建。
    return chatEventStore.update(eventId, {
      content: `滴答任务创建结果待核实 · ${proposal.task.title}`,
      status: 'failed',
      approval: { ...creating.approval, status: 'task-uncertain', lastError: String(error.message || error).slice(0, 300) },
    });
  }
  if (!task?.id) {
    return chatEventStore.update(eventId, {
      content: `滴答任务可能已创建，但未取得任务 ID · ${proposal.task.title}`,
      status: 'failed',
      approval: { ...creating.approval, status: 'task-uncertain', lastError: '滴答没有返回任务 ID' },
    });
  }
  const taskCreated = await chatEventStore.update(eventId, {
    content: `滴答任务已建，提醒待关联 · ${task.title || proposal.task.title}`,
    status: 'pending',
    approval: { ...creating.approval, status: 'task-created', taskId: task.id },
  });
  return finishTaskReminderApproval({ event: taskCreated, eventId, chatEventStore, reminderService });
}

async function finishTaskReminderApproval({ event, eventId, chatEventStore, reminderService }) {
  const { proposal, taskId } = event.approval;
  if (!taskId) throw statusError(409, '缺少已创建任务的 ID，不能关联提醒');
  const reminderId = `reminder_combo_${eventId}`;
  try {
    const existing = await reminderService.get(reminderId);
    if (existing && (existing.relatedTaskId !== taskId || existing.status !== 'scheduled')) {
      throw statusError(409, '关联提醒的状态已变化，请人工核实');
    }
    if (!existing) {
      const reminder = validateLinkedReminderDraft({ ...proposal.reminder, title: proposal.task.title });
      await reminderService.create({
        ...reminder, id: reminderId, relatedTaskId: taskId, relatedTaskTitle: proposal.task.title,
      }, { author: 'ai' });
    } else {
      await reminderService.reschedule();
    }
  } catch (error) {
    return chatEventStore.update(eventId, {
      content: `滴答任务已建，提醒未建 · ${proposal.task.title}`,
      status: 'failed',
      approval: { ...event.approval, status: 'task-created', lastError: String(error.message || error).slice(0, 300) },
    });
  }
  return chatEventStore.update(eventId, {
    content: `已创建滴答任务并关联提醒 · ${proposal.task.title}`,
    status: 'completed',
    approval: {
      ...event.approval, status: 'accepted', reminderId, lastError: '', resolvedAt: new Date().toISOString(),
    },
  });
}

async function resolveMemoryApproval({ event, eventId, payload, decision, chatEventStore, memoryStore, memoryNodeStore, chatService }) {
  const original = event.approval.proposal;
  if (decision === 'reject') {
    return chatEventStore.update(eventId, {
      content: `暂不采用记忆建议 · ${original.title}`, status: 'completed',
      approval: { ...event.approval, status: 'rejected', resolvedAt: new Date().toISOString() },
    });
  }
  const patch = payload.patch || {};
  const proposal = {
    ...original,
    ...(typeof patch.title === 'string' ? { title: patch.title } : {}),
    ...(typeof patch.contentMarkdown === 'string' ? { contentMarkdown: patch.contentMarkdown } : {}),
    ...(['create', 'update', 'promote'].includes(patch.operation) ? { operation: patch.operation } : {}),
    ...(typeof patch.targetMemoryId === 'string' ? { targetMemoryId: patch.targetMemoryId } : {}),
  };
  let memory;
  let operation = proposal.operation;
  if (operation === 'create' || operation === 'promote') {
    const duplicate = await memoryStore.findDuplicate(proposal);
    if (duplicate && payload.keepSeparate !== true && operation === 'create') {
      operation = 'update';
      proposal.targetMemoryId = duplicate.memory.id;
    }
  }
  if (operation === 'update') {
    const current = await memoryStore.get(proposal.targetMemoryId);
    if (!current) throw statusError(409, '要更新的记忆已不存在');
    memory = await memoryStore.update(current.id, proposal, { baseRevision: current.revision });
  } else if (operation === 'promote') {
    const node = await memoryNodeStore?.get(proposal.targetMemoryId);
    if (!node || node.tier !== 'retrievable' || node.status === 'archived') throw statusError(409, '要晋升的可检索节点已变化，请重新提出建议');
    if (node.revision !== proposal.baseRevision) throw statusError(409, '可检索节点已更新，请重新核对后提出建议');
    memory = await memoryStore.promote(node.id, proposal, { baseRevision: node.revision });
  } else {
    memory = await memoryStore.create(proposal, { allowDuplicate: payload.keepSeparate === true });
  }
  const resolved = await chatEventStore.update(eventId, {
    content: `${operation === 'update' ? '已更新记忆' : operation === 'promote' ? '已升级为核心记忆' : '已记住'} · ${memory.title}`,
    status: 'completed',
    approval: { ...event.approval, status: 'accepted', proposal: { ...proposal, operation }, resolvedAt: new Date().toISOString(), memoryId: memory.id, application: { applied: false, status: 'pending' } },
  });
  await appendMemoryNotice(chatEventStore, operation === 'promote' ? 'promoted' : operation === 'update' ? 'revised' : 'created', memory.title);
  // Persistence and approval are complete; synchronizing the live model must not keep the mobile request open.
  void applyMemorySafely(chatService, memory, 'upsert').then(async (application) => {
    try {
      await chatEventStore.update(eventId, { approval: { ...resolved.approval, application } });
    } catch { /* The core memory is durable and will be loaded by the next thread. */ }
  });
  return resolved;
}

async function applyMemorySafely(chatService, memory, action) {
  if (!chatService?.applyMemoryChange) return { applied: false, status: 'unavailable' };
  try { return await chatService.applyMemoryChange(memory, action); }
  catch (error) { return { applied: false, status: 'failed', error: safeError(error) }; }
}

function normalizeApprovalProposal(value = {}) {
  const level = value.level === 'primary' ? 'primary' : value.level === 'secondary' ? 'secondary' : '';
  const name = String(value.name || '').trim().slice(0, 40);
  const reason = String(value.reason || '').trim().slice(0, 200);
  const parentCategoryId = String(value.parentCategoryId || '').trim();
  const color = /^#[0-9A-Fa-f]{6}$/.test(String(value.color || '')) ? String(value.color).toUpperCase() : '';
  if (!level || !name || !reason || (level === 'secondary' && !parentCategoryId)) throw statusError(400, '分类建议内容不完整');
  return { level, name, reason, ...(parentCategoryId ? { parentCategoryId } : {}), ...(color ? { color } : {}) };
}

function normalizeMessageId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{8,100}$/.test(id) ? id : '';
}

async function readJsonBody(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw statusError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw statusError(400, 'JSON 格式错误');
  }
}

async function serveStatic(pathname, response, webRoot) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const safePath = normalize(relative).replace(/^(\.\.(\\|\/|$))+/, '');
  let filePath = safePath === 'call-avatar.png'
    ? join(webRoot, '..', 'android', 'app', 'src', 'main', 'res', 'mipmap-xhdpi', 'ic_launcher.png')
    : join(webRoot, safePath);
  if ((await stat(filePath)).isDirectory()) filePath = join(filePath, 'index.html');
  const body = await readFile(filePath);
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream',
  });
  response.end(body);
}

async function serveReleaseApk(response, filePath) {
  const body = await readFile(filePath);
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-disposition': 'attachment; filename="Ethere-release.apk"',
    'content-length': String(body.length),
    'content-type': mimeTypes['.apk'],
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

async function proxyVoiceJson(response, path, payload, timeoutMs) {
  try {
    const upstream = await fetch(`http://127.0.0.1:4189${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
    const result = await upstream.json().catch(() => ({}));
    return sendJson(response, upstream.ok ? 200 : 502, upstream.ok ? result : { error: result.error || '语音识别失败' });
  } catch { return sendJson(response, 503, { error: '语音服务未启动，请检查电脑端 Voice Lab' }); }
}

async function proxyVoiceAudio(response, text, voiceId) {
  try {
    const upstream = await fetch('http://127.0.0.1:4189/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, engine: 'fish', voiceId: normalizeVoiceId(voiceId) }), signal: AbortSignal.timeout(50000) });
    if (!upstream.ok) {
      const result = await upstream.json().catch(() => ({}));
      return sendJson(response, 502, { error: result.error || '语音合成失败' });
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(bytes);
  } catch { sendJson(response, 503, { error: '语音服务未启动，请检查电脑端 Voice Lab' }); }
}

function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function configuredAssistantName(configStore) {
  const name = (await configStore?.getSettings?.())?.bossName;
  return typeof name === 'string' && name.trim() ? name.trim() : 'Ethere';
}

function safeError(error) {
  return error instanceof Error && error.message ? error.message : '服务器错误';
}
