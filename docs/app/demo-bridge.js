import { ethereApi } from './companion-api.js';

const call = document.querySelector('[data-voice-call]');
const callState = document.querySelector('[data-voice-call-state]');
let callStartedAt = 0;
let callClock = 0;
let sceneRequest = 0;
const syncPhoneTheme = () => window.parent.postMessage({ type: 'ethere-demo-theme', dark: !call.hidden || Boolean(document.querySelector('[data-demo-incoming], [data-demo-attention]')) }, location.origin);

function showChat() {
  for (let attempt = 0; attempt < 12 && window.EthereHandleBack?.(); attempt += 1) { /* unwind the same nested back path as the app */ }
}

function closeCall() {
  if (call.hidden) return;
  call.hidden = true;
  syncPhoneTheme();
  window.clearInterval(callClock);
  callClock = 0;
  const elapsed = Math.floor((Date.now() - callStartedAt) / 1000);
  const duration = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  ethereApi.demoScenario('call-ended', { duration });
}

function openCall() {
  closeAttention();
  showChat();
  const attachmentTrigger = document.querySelector('[data-add-image]');
  if (attachmentTrigger?.getAttribute('aria-expanded') === 'true') attachmentTrigger.click();
  callStartedAt = Date.now();
  call.hidden = false;
  syncPhoneTheme();
  callState.textContent = '正在通话 · 00:00';
  window.clearInterval(callClock);
  callClock = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartedAt) / 1000);
    callState.textContent = `正在通话 · ${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  }, 1000);
}

function closeIncoming(action = '') {
  const panel = document.querySelector('[data-demo-incoming]');
  if (!panel) return;
  panel.remove();
  syncPhoneTheme();
  if (action === 'declined') ethereApi.demoScenario('call-declined');
  if (action === 'snoozed') ethereApi.demoScenario('call-snoozed');
}
async function openIncoming(request = ++sceneRequest) {
  closeCall();
  closeAttention();
  closeIncoming();
  showChat();
  const leadIn = await ethereApi.demoScenarioAnimated('call-incoming');
  if (leadIn.cancelled || request !== sceneRequest) return;
  const panel = document.createElement('section');
  panel.className = 'demo-incoming';
  panel.dataset.demoIncoming = '';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', '语音来电');
  panel.innerHTML = '<div class="demo-incoming__identity"><img src="./brand-icon.png" alt=""><strong data-demo-caller></strong><p>语音来电</p></div><div class="demo-incoming__bottom"><div class="demo-incoming__actions"><button type="button" data-demo-decline><span class="demo-incoming__action-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 15c5-4 13-4 18 0l-2 4-3-1v-3a11 11 0 0 0-8 0v3l-3 1-2-4Z"/></svg></span>挂断</button><button type="button" data-demo-answer><span class="demo-incoming__action-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3.5c.6-.6 1.6-.6 2.1.1l2 2.6c.4.5.4 1.2 0 1.7l-1.3 1.4a15 15 0 0 0 4.9 4.9l1.4-1.3c.5-.4 1.2-.4 1.7 0l2.6 2c.7.5.7 1.5.1 2.1l-1.4 1.5c-.6.7-1.5 1-2.4.9C10.6 20.9 3.1 13.4 3.5 6.9c0-.9.3-1.8 1-2.4L7 3.5Z"/></svg></span>接听</button></div><button class="demo-incoming__snooze" type="button" data-demo-snooze>稍后提醒</button></div>';
  panel.querySelector('[data-demo-caller]').textContent = document.querySelector('[data-voice-call] [data-boss-name]')?.textContent || 'Ethere';
  panel.addEventListener('click', (event) => {
    if (event.target.closest('[data-demo-answer]')) {
      closeIncoming();
      void ethereApi.demoScenarioAnimated('call-answered');
      openCall();
    } else if (event.target.closest('[data-demo-decline]')) closeIncoming('declined');
    else if (event.target.closest('[data-demo-snooze]')) closeIncoming('snoozed');
  });
  document.body.append(panel);
  syncPhoneTheme();
  panel.tabIndex = -1;
  panel.focus({ preventScroll: true });
}

function closeAttention(action = '') {
  const panel = document.querySelector('[data-demo-attention]');
  if (!panel) return;
  panel.remove();
  syncPhoneTheme();
  if (action) ethereApi.demoScenario('attention-result', { action });
}
async function openAttention(request = ++sceneRequest) {
  closeCall();
  closeIncoming();
  closeAttention();
  showChat();
  const leadIn = await ethereApi.demoScenarioAnimated('attention');
  if (leadIn.cancelled || request !== sceneRequest) return;
  const panel = document.createElement('section');
  panel.className = 'demo-attention';
  panel.dataset.demoAttention = '';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Ethere 的留言');
  panel.innerHTML = '<button class="demo-attention__close" data-demo-attention-dismiss type="button" aria-label="关闭">×</button><p>已经看屏幕很久了。要不要起来看看窗外？</p><div class="demo-attention__actions"><button type="button" data-demo-attention-rest>好，休息一下</button><button type="button" data-demo-attention-later>稍后再说</button></div>';
  panel.addEventListener('click', (event) => {
    if (event.target.closest('[data-demo-attention-rest]')) closeAttention('rest');
    else if (event.target.closest('[data-demo-attention-later]')) closeAttention('later');
    else if (event.target.closest('[data-demo-attention-dismiss]')) closeAttention('dismissed');
  });
  document.body.append(panel);
  syncPhoneTheme();
  panel.querySelector('button').focus();
}

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-start-voice-call]')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    openCall();
  } else if (event.target.closest('[data-voice-call-end]') && !call.hidden) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeCall();
  }
}, true);

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!call.hidden) { event.stopImmediatePropagation(); closeCall(); }
  else if (document.querySelector('[data-demo-incoming]')) { event.stopImmediatePropagation(); closeIncoming('declined'); }
  else if (document.querySelector('[data-demo-attention]')) { event.stopImmediatePropagation(); closeAttention('dismissed'); }
}, true);

window.EthereDemoBack = () => {
  if (!call.hidden) { closeCall(); return true; }
  if (document.querySelector('[data-demo-incoming]')) { closeIncoming('declined'); return true; }
  if (document.querySelector('[data-demo-attention]')) { closeAttention('dismissed'); return true; }
  return window.EthereHandleBack?.() || false;
};

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'ethere-demo-scenario') return;
  const name = String(event.data.name || '');
  const request = ++sceneRequest;
  if (name === 'call') return void openIncoming(request);
  if (name === 'attention') return void openAttention(request);
  closeCall();
  closeIncoming();
  closeAttention();
  showChat();
  void ethereApi.demoScenarioAnimated(name);
});
