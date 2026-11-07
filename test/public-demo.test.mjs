import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { scriptedReply } from '../docs/demo-data.js';
import { ethereApi } from '../docs/app/companion-api.js';

test('public demo scripts cover learning, memory, and reminder without claiming a real write', () => {
  assert.equal(scriptedReply('帮我安排一节天文学课').id, 'learning');
  assert.equal(scriptedReply('你记得我的学习偏好吗').id, 'memory');
  const reminder = scriptedReply('明晚提醒我继续');
  assert.equal(reminder.id, 'reminder');
  assert.match(reminder.reply, /几点/);
  assert.doesNotMatch(reminder.reply, /已经创建|设置成功/);
  assert.equal(scriptedReply('你好').id, 'general');
});

test('showcase points to consistent scenes and explains the product flow', async () => {
  const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../docs/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /data-start-demo/);
  assert.doesNotMatch(html, /class="phone-scene-guide"/);
  assert.doesNotMatch(html, /class="scene-hint"/);
  const scenes = html.match(/<button type="button" data-scenario="[^"]+">[\s\S]*?<\/button>/g) || [];
  assert.equal(scenes.length, 8);
  assert.match(scenes[0], /data-scenario="checkin"[\s\S]*主动联系/);
  assert.ok(scenes.every((scene) => scene.includes('<svg viewBox="0 0 24 24">')));
  assert.match(styles, /\.scenario-grid button\.is-active/);
  assert.match(styles, /scroll-snap-type: y mandatory/);
  assert.match(html, /id="architecture"/);
  assert.equal((html.match(/data-architecture-screen/g) || []).length, 3);
  assert.equal((html.match(/class="scroll-cue/g) || []).length, 3);
  for (const section of ['接住当下', '让理解延续', '把关心落到行动']) assert.ok(html.includes(section));
  for (const mechanism of ['操作规则', '核心记忆', 'Watch', 'Remember', '语义关联', 'Check-in', '滴答任务']) assert.ok(html.includes(mechanism));
});

test('public demo keeps the presentation outside an unmodified app frontend', async () => {
  const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
  const appHtml = await readFile(new URL('../docs/app/index.html', import.meta.url), 'utf8');
  const actualStyles = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  const demoStyles = await readFile(new URL('../docs/app/styles.css', import.meta.url), 'utf8');
  const actualApp = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const demoApp = await readFile(new URL('../docs/app/app.js', import.meta.url), 'utf8');
  const actualViews = await readFile(new URL('../web/companion-views.js', import.meta.url), 'utf8');
  const demoViews = await readFile(new URL('../docs/app/companion-views.js', import.meta.url), 'utf8');
  assert.equal(demoStyles, actualStyles);
  assert.equal(demoApp, actualApp);
  assert.equal(demoViews, actualViews);
  assert.match(html, /<iframe[^>]+src="\.\/app\/index\.html"/);
  assert.match(html, /不只回应此刻，<br><em>也记得一路走来的你。<\/em>/);
  assert.match(html, /app\/brand-icon\.png/);
  assert.match(appHtml, /voice-call__identity"><img src="\.\/brand-icon\.png"/);
  assert.equal((html.match(/data-scenario=/g) || []).length, 8);
  for (const className of ['app-shell', 'topbar', 'view--chat', 'conversation', 'composer__field', 'send-button']) {
    assert.match(appHtml, new RegExp(`class="[^"]*\\b${className}\\b`));
  }
  assert.doesNotMatch(html, /离线演示|脚本演示|不连接真实数据|虚构示例|刷新后即消失|PRODUCT DEMO|INTERACTIVE PREVIEW/);
  for (const page of ['data-view-panel="space"', 'data-view-panel="timeline"', 'data-view-panel="settings"']) assert.ok(appHtml.includes(page), `${page} should use the actual app path`);
  for (const page of ['data-memory-manager', 'data-memory-detail', 'data-study-manager', 'data-reminder-manager', 'data-settings-editor', 'data-space-editor']) assert.ok(actualViews.includes(page), `${page} should use the actual app path`);
  assert.match(html, /data-demo-back/);
  const sourceFiles = (await readdir(new URL('../web/', import.meta.url))).filter((name) => !['index.html', 'companion-api.js', 'manifest.webmanifest'].includes(name));
  for (const name of sourceFiles) {
    const source = await readFile(new URL(`../web/${name}`, import.meta.url));
    const demo = await readFile(new URL(`../docs/app/${name}`, import.meta.url));
    assert.deepEqual(demo, source, `${name} should match the actual frontend`);
  }
  const actualIcon = await readFile(new URL('../android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', import.meta.url));
  const demoIcon = await readFile(new URL('../docs/app/brand-icon.png', import.meta.url));
  assert.deepEqual(demoIcon, actualIcon);
  const manifest = JSON.parse(await readFile(new URL('../docs/app/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.icons[0].src, './brand-icon.png');
});

test('public demo is self-contained and has no network/data access paths', async () => {
  for (const file of ['index.html', 'styles.css', 'app.js', 'demo-data.js', 'app/companion-api.js', 'app/demo-bridge.js']) {
    const contents = await readFile(new URL(`../docs/${file}`, import.meta.url), 'utf8');
    assert.ok(contents.length > 0, `${file} should not be empty`);
    assert.doesNotMatch(contents, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|https?:\/\/(?!www\.w3\.org)/i);
    assert.doesNotMatch(contents, /欢儿|沈星回|星回|ETHERE_DATA_DIR/);
  }
});

test('demo data feeds the actual space, timeline, memory, reminder and study views', async () => {
  assert.ok((await ethereApi.spacePosts()).posts.length >= 2);
  assert.ok((await ethereApi.timelineCategories()).categories.length >= 2);
  assert.ok((await ethereApi.memories()).memories.length >= 1);
  assert.ok((await ethereApi.memoryV2List({ state: 'remember' })).memories.length >= 1);
  assert.ok((await ethereApi.reminders()).reminders.length >= 1);
  assert.ok((await ethereApi.studyPlan('study-astronomy')).plan.lessons.length >= 3);
  assert.ok((await ethereApi.readDocument('persona')).text);
  const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  for (const [, name] of app.matchAll(/ethereApi\.([A-Za-z][A-Za-z0-9]*)/g)) assert.equal(typeof ethereApi[name], 'function', `mock should implement ${name}`);
});

test('in-memory secondary-page edits keep the same app contracts', async () => {
  const upload = await ethereApi.uploadChatFile('notes.txt', 'data:text/plain;base64,SGVsbG8=');
  assert.equal(upload.type, 'file');
  const before = await ethereApi.timelineCategories();
  const updated = await ethereApi.createTimelineCategory({ id: 'demo-new-category', name: '想法', color: '#777dc5', baseRevision: before.revision });
  assert.equal(updated.revision, before.revision + 1);
  assert.ok(updated.categories.some((item) => item.id === 'demo-new-category'));
  const start = new Date().toISOString().slice(0, 10);
  const stats = await ethereApi.timelineStats({ start, end: start });
  assert.equal(stats.totalMinutes, 80);
  assert.equal(stats.groups[0].children.reduce((sum, child) => sum + child.minutes, 0), 80);
  const original = (await ethereApi.spacePosts()).posts.find((post) => post.id === 'post-1');
  const revised = await ethereApi.updateSpacePost(original.id, { contentMarkdown: original.contentMarkdown, images: [{ id: original.images[0].id }] });
  assert.equal(revised.post.images[0].originalUrl, original.images[0].originalUrl);
  await ethereApi.archiveMemory('core-learning');
  assert.ok((await ethereApi.memories({ status: 'archived' })).memories.some((item) => item.id === 'core-learning'));
  assert.ok(!(await ethereApi.memories({ status: 'active' })).memories.some((item) => item.id === 'core-learning'));
  await ethereApi.restoreMemory('core-learning');
  assert.ok((await ethereApi.memories({ status: 'active' })).memories.some((item) => item.id === 'core-learning'));
});

test('external scenarios become ordinary chat events and existing card kinds', async () => {
  const memory = ethereApi.demoScenario('memory').events;
  assert.ok(memory.some((event) => event.role === 'activity' && !event.card));
  const study = ethereApi.demoScenario('study').events;
  assert.ok(study.some((event) => event.card?.kind === 'study-plan'));
  const approval = ethereApi.demoScenario('core').events;
  assert.ok(approval.some((event) => event.approval?.kind === 'memory-change'));
  assert.equal(approval[0].role, 'user');
  assert.equal(approval[1].role, 'assistant');
  assert.equal(approval.at(-1).role, 'assistant');
  const incoming = ethereApi.demoScenario('call-incoming').events;
  assert.ok(incoming.some((event) => event.content.includes('发起来电')));
  const answered = ethereApi.demoScenario('call-answered').events;
  assert.ok(answered.some((event) => event.role === 'assistant'));
  const call = ethereApi.demoScenario('call-ended').events;
  assert.ok(call.some((event) => event.content.startsWith('语音通话已结束')));
  const attention = ethereApi.demoScenario('attention').events;
  assert.equal(attention[0].role, 'user');
  assert.equal(attention[1].role, 'assistant');
  const reminder = ethereApi.demoScenario('reminder').events;
  assert.ok(reminder.some((event) => event.role === 'assistant' && event.source === 'reminder' && event.content.includes('八点半到了')));
  const checkin = ethereApi.demoScenario('checkin').events;
  assert.equal(checkin.filter((event) => event.role === 'assistant' && event.source === 'checkin').length, 2);
  assert.ok(checkin.findIndex((event) => event.content.includes('还没开始')) < checkin.findIndex((event) => event.content.includes('我又来啦')));
  const after = await ethereApi.chatEvents(0);
  assert.ok(after.events.length >= memory.length + study.length + approval.length + incoming.length + answered.length + call.length + attention.length);
});

test('animated scenes emit the user first, stream one assistant message, then finish it', async () => {
  const batches = [];
  const close = ethereApi.openChatEventStream(0, { onBatch: (batch) => batches.push(batch) });
  const result = await ethereApi.demoScenarioAnimated('memory');
  close();
  assert.equal(result.cancelled, false);
  assert.equal(result.events[0].role, 'user');
  const assistant = result.events.find((event) => event.role === 'assistant');
  assert.ok(assistant);
  const updates = batches.flatMap((batch) => batch.events).filter((event) => event.id === assistant.id);
  assert.ok(updates.some((event) => event.status === 'streaming' && event.content.length > 0 && event.content.length < assistant.content.length));
  assert.equal(updates.at(-1).status, 'completed');
  assert.equal(updates.at(-1).content, assistant.content);
  assert.equal(batches[0].events[0].role, 'user');
  assert.equal(new Set(updates.map((event) => event.id)).size, 1);
  assert.equal((await ethereApi.chatEvents(0)).events.filter((event) => event.id === assistant.id).length, 1);
});

test('animated study card appears after the lead-in reply, not with the initial user message', async () => {
  const batches = [];
  const close = ethereApi.openChatEventStream(0, { onBatch: (batch) => batches.push(batch) });
  await ethereApi.demoScenarioAnimated('study');
  close();
  const events = batches.flatMap((batch) => batch.events);
  const cardIndex = events.findIndex((event) => event.card?.kind === 'study-plan');
  const leadInIndex = events.findIndex((event) => event.role === 'assistant' && event.status === 'completed');
  assert.ok(leadInIndex > 0);
  assert.ok(cardIndex > leadInIndex);
  assert.equal(events[0].role, 'user');
});

test('call preview opens as an incoming call before the conversation screen', async () => {
  const bridge = await readFile(new URL('../docs/app/demo-bridge.js', import.meta.url), 'utf8');
  const outer = await readFile(new URL('../docs/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../docs/styles.css', import.meta.url), 'utf8');
  assert.match(bridge, /if \(name === 'call'\) return void openIncoming\(request\)/);
  assert.match(bridge, /data-demo-answer/);
  assert.match(bridge, /ethereApi\.demoScenarioAnimated\('call-answered'\);\s*openCall\(\)/);
  assert.doesNotMatch(bridge, /querySelector\('\[data-demo-answer\]'\)\.focus\(/);
  assert.match(bridge, /ethere-demo-theme/);
  assert.match(outer, /phone\.classList\.toggle\('is-dark'/);
  assert.match(styles, /\.phone\.is-dark[^\n]*\.phone__status/);
});
