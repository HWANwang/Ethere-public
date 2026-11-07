import { BargeInGate, shouldFinishUtterance } from './voice-turn.js';

const $ = selector => document.querySelector(selector);
const messages = $('#messages');
const draft = $('#draft');
const mic = $('#mic');
const send = $('#send');
const continuous = $('#continuous');
const streamMode = $('#stream-mode');
const audio = new Audio();
const savedSegments = new WeakMap();
let busy = false;
let playing = false;
let segmentQueue = [];
let streamFinished = true;
let mutedUntilDone = false;
let micStream;
let audioContext;
let processor;
let captureMode = null;
let captured = [];
let preroll = [];
let speechStartedAt = 0;
let lastVoiceAt = 0;
let captureStartedAt = 0;
let currentAudioUrl;
let toastTimer;
let currentChatAbort = null;
let activeTurnDone = Promise.resolve();
let finishActiveTurn = () => {};
let recognizing = false;
const bargeInGate = new BargeInGate();

function beginTurn() {
  activeTurnDone = new Promise(resolve => { finishActiveTurn = resolve; });
  currentChatAbort = new AbortController();
  bargeInGate.reset();
  return currentChatAbort;
}
function endTurn() {
  currentChatAbort = null;
  finishActiveTurn();
  finishActiveTurn = () => {};
}
function interruptTurn() {
  currentChatAbort?.abort();
  stopPlayback(false);
  streamFinished = true;
  setState('已打断，请继续说…');
}

function toast(text) {
  const box = $('#toast');
  box.textContent = text;
  box.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('visible'), 4500);
}
function setState(text) { $('#listen-state').textContent = text; }
function setBusy(value) {
  busy = value;
  send.disabled = value;
  $('#sample-play').disabled = value;
  draft.disabled = value;
}
function engine() { return document.querySelector('input[name="engine"]:checked').value; }
async function requestJson(route, data, signal) {
  const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
async function health() {
  try {
    const data = await (await fetch('/api/health')).json();
    const fields = [['fish', 'Fish 密钥'], ['asr', '本地识别'], ['chat', '独立 Codex']];
    $('#health').innerHTML = fields.map(([name, label]) => `<span class="${data[name] ? 'ready' : 'off'}">${label}${data[name] ? '就绪' : '未就绪'}</span>`).join('');
  } catch { $('#health').textContent = '服务未就绪，请重新打开测试页。'; }
}
function addMessage(role, text, timings = {}) {
  const empty = messages.querySelector('.empty-state');
  if (empty) empty.remove();
  const item = document.createElement('div');
  item.className = `message ${role}`;
  const label = document.createElement('div');
  label.className = 'role';
  label.textContent = role === 'user' ? '你' : '测试回复';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  const meta = document.createElement('div');
  meta.className = 'meta';
  if (role === 'assistant') {
    meta.textContent = timings.chat ? `Codex ${formatTime(timings.chat)}` : '';
    const replay = document.createElement('button');
    replay.textContent = '重播';
    replay.onclick = () => {
      const segments = savedSegments.get(item);
      if (segments?.length) {
        stopPlayback();
        mutedUntilDone = false;
        segmentQueue = segments.map(url => ({ url, item }));
        playNextSegment();
      } else if (item.dataset.audioUrl) play(item.dataset.audioUrl, false);
      else toast('还没有生成音频');
    };
    const resynth = document.createElement('button');
    resynth.textContent = '整段朗读';
    resynth.onclick = () => voiceFor(bubble.textContent, item, false);
    meta.append(replay, resynth);
  } else if (timings.asr) meta.textContent = `识别 ${formatTime(timings.asr)}`;
  item.append(label, bubble, meta);
  messages.append(item);
  messages.scrollTop = messages.scrollHeight;
  return item;
}
function formatTime(ms) { return `${(ms / 1000).toFixed(1)}s`; }
function stopPlayback(rearm = true) {
  audio.pause();
  audio.currentTime = 0;
  segmentQueue = [];
  mutedUntilDone = true;
  playing = false;
  setState('播放已停止');
  if (rearm && continuous.checked && !busy && streamFinished) armCapture('auto');
}
function play(url, rearm = true) {
  audio.pause();
  segmentQueue = [];
  audio.src = url;
  playing = true;
  bargeInGate.reset();
  setState('正在朗读…');
  audio.onended = () => {
    playing = false;
    setState('朗读结束');
    if (rearm && continuous.checked && !busy) armCapture('auto');
  };
  audio.play().catch(() => { playing = false; toast('浏览器阻止了自动播放，请点“重播”。'); });
}
function playNextSegment() {
  if (playing || mutedUntilDone) return;
  const next = segmentQueue.shift();
  if (!next) {
    if (streamFinished && continuous.checked && !busy) armCapture('auto');
    return;
  }
  playing = true;
  bargeInGate.reset();
  audio.src = next.url;
  setState('正在朗读…');
  audio.onended = () => {
    playing = false;
    playNextSegment();
  };
  audio.play().catch(() => {
    playing = false;
    segmentQueue = [];
    toast('浏览器阻止了自动播放，请点“重播”。');
  });
}
function queueSegment(item, base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
  const stored = savedSegments.get(item) || [];
  stored.push(url);
  savedSegments.set(item, stored);
  if (!mutedUntilDone) {
    segmentQueue.push({ url, item });
    playNextSegment();
  }
}
async function voiceFor(text, item, rearm = true) {
  const selected = engine();
  setState('正在用 Fish 合成…');
  const started = performance.now();
  const response = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.slice(0, 400), engine: selected }), signal: currentChatAbort?.signal });
  if (!response.ok) { const error = await response.json(); throw new Error(error.error || `语音合成失败 ${response.status}`); }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  if (item.dataset.audioUrl) URL.revokeObjectURL(item.dataset.audioUrl);
  item.dataset.audioUrl = url;
  const meta = item.querySelector('.meta');
  const duration = Math.round(performance.now() - started);
  const info = document.createElement('span');
  info.textContent = `Fish ${formatTime(duration)}`;
  meta.prepend(info);
  play(url, rearm);
  return duration;
}
async function processTurn(text, asrMs = 0) {
  const clean = text.trim();
  if (!clean || busy) return;
  if (streamMode.checked) return processStreamTurn(clean, asrMs);
  stopPlayback();
  mutedUntilDone = false;
  captureMode = null;
  mic.classList.remove('recording');
  setBusy(true);
  const controller = beginTurn();
  addMessage('user', clean, { asr: asrMs });
  draft.value = '';
  setState('Codex 正在回复…');
  try {
    const reply = await requestJson('/api/chat', { text: clean }, controller.signal);
    const item = addMessage('assistant', reply.text, { chat: reply.elapsedMs });
    try { await voiceFor(reply.text, item); }
    catch (error) { if (error.name !== 'AbortError') { toast(error.message); setState('文字回复完成，语音失败'); } }
  } catch (error) {
    if (error.name !== 'AbortError') { toast(error.message); setState('回复失败'); }
  } finally {
    setBusy(false);
    endTurn();
    if (continuous.checked && !captureMode && !playing && !recognizing) armCapture('auto');
  }
}

async function processStreamTurn(clean, asrMs) {
  stopPlayback();
  mutedUntilDone = false;
  streamFinished = false;
  captureMode = null;
  mic.classList.remove('recording');
  setBusy(true);
  const controller = beginTurn();
  addMessage('user', clean, { asr: asrMs });
  const item = addMessage('assistant', '');
  const bubble = item.querySelector('.bubble');
  const meta = item.querySelector('.meta');
  draft.value = '';
  setState('Codex 正在回复…');
  let sawDone = false;
  try {
    const response = await fetch('/api/chat-stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.json();
      throw new Error(detail.error || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handle = event => {
      if (event.type === 'delta') {
        const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
        bubble.textContent += event.text;
        if (nearBottom) messages.scrollTop = messages.scrollHeight;
      } else if (event.type === 'audio') {
        queueSegment(item, event.audioBase64);
      } else if (event.type === 'audio_error') {
        toast(`第 ${event.index} 段朗读失败：${event.message}`);
      } else if (event.type === 'done') {
        sawDone = true;
        streamFinished = true;
        meta.prepend(document.createTextNode(`首字 ${formatTime(event.firstDeltaMs || 0)} · 首段音频 ${event.firstAudioMs ? formatTime(event.firstAudioMs) : '失败'} · 模型 ${formatTime(event.modelMs)} `));
        setState(playing || segmentQueue.length ? '正在朗读…' : '回复完成');
      } else if (event.type === 'error') throw new Error(event.message || '流式回复失败');
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) handle(JSON.parse(line));
      }
    }
    if (!sawDone) throw new Error('流式回复提前中断');
  } catch (error) {
    streamFinished = true;
    if (!bubble.textContent) item.remove();
    if (error.name !== 'AbortError') { toast(error.message); setState('回复失败'); }
  } finally {
    setBusy(false);
    endTurn();
    if (continuous.checked && !captureMode && !playing && !segmentQueue.length && !recognizing) armCapture('auto');
  }
}

function encodeWav(frames, inputRate) {
  const count = frames.reduce((sum, frame) => sum + frame.length, 0);
  const input = new Float32Array(count);
  let at = 0;
  for (const frame of frames) { input.set(frame, at); at += frame.length; }
  const outputRate = 16000;
  const outputCount = Math.floor(count * outputRate / inputRate);
  const buffer = new ArrayBuffer(44 + outputCount * 2);
  const view = new DataView(buffer);
  const str = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + outputCount * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, outputRate, true); view.setUint32(28, outputRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, outputCount * 2, true);
  for (let i = 0; i < outputCount; i++) {
    const source = i * inputRate / outputRate;
    const index = Math.floor(source);
    const sample = input[index] * (1 - (source - index)) + (input[Math.min(index + 1, input.length - 1)] || 0) * (source - index);
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
  }
  return new Uint8Array(buffer);
}
async function ensureMic() {
  if (micStream) return;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false });
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(micStream);
  processor = audioContext.createScriptProcessor(2048, 1, 1);
  source.connect(processor);
  processor.connect(audioContext.destination);
  processor.onaudioprocess = event => {
    const output = event.outputBuffer.getChannelData(0);
    output.fill(0);
    const frame = new Float32Array(event.inputBuffer.getChannelData(0));
    const now = performance.now();
    let power = 0;
    for (let i = 0; i < frame.length; i++) power += frame[i] * frame[i];
    const rms = Math.sqrt(power / frame.length);
    if (!captureMode && !recognizing && continuous.checked && (busy || playing)) {
      if (bargeInGate.observe(rms, now, frame, { playing })) {
        const leadIn = [...bargeInGate.preroll];
        interruptTurn();
        armCapture('auto', true);
        captured = leadIn;
        speechStartedAt = now;
        lastVoiceAt = now;
        setState('已打断，继续说…');
        bargeInGate.reset();
      }
      return;
    }
    if (!captureMode) { bargeInGate.reset(); return; }
    if (captureMode === 'manual') {
      captured.push(frame);
      if (now - captureStartedAt > 60_000) finishCapture();
      return;
    }
    const speech = rms > 0.018;
    if (!speechStartedAt) {
      preroll.push(frame);
      if (preroll.length > 12) preroll.shift();
      if (speech) { speechStartedAt = now; lastVoiceAt = now; captured = [...preroll]; preroll = []; setState('听到了，继续说…'); }
    } else {
      captured.push(frame);
      if (speech) lastVoiceAt = now;
      if (shouldFinishUtterance({ now, startedAt: speechStartedAt, lastVoiceAt })) finishCapture();
    }
  };
}
function armCapture(mode, force = false) {
  if (!micStream || (!force && (busy || playing || recognizing))) return;
  captured = []; preroll = []; speechStartedAt = 0; lastVoiceAt = 0;
  captureStartedAt = performance.now(); captureMode = mode;
  mic.classList.toggle('recording', mode === 'manual');
  mic.setAttribute('aria-label', mode === 'manual' ? '结束录音并发送' : '正在自动聆听');
  setState(mode === 'manual' ? '正在录音，点麦克风结束' : '正在聆听…');
}
async function finishCapture() {
  if (!captureMode) return;
  const frames = captured;
  captureMode = null;
  captured = []; preroll = [];
  mic.classList.remove('recording');
  mic.setAttribute('aria-label', '开始录音');
  if (!frames.length || frames.reduce((n, frame) => n + frame.length, 0) / audioContext.sampleRate < .35) {
    setState('录音太短'); if (continuous.checked) armCapture('auto'); return;
  }
  setBusy(true);
  recognizing = true;
  setState('正在本地识别…');
  try {
    const wav = encodeWav(frames, audioContext.sampleRate);
    let binary = '';
    for (let i = 0; i < wav.length; i += 8192) binary += String.fromCharCode(...wav.subarray(i, i + 8192));
    const result = await requestJson('/api/asr', { audioBase64: btoa(binary) });
    await activeTurnDone;
    recognizing = false;
    setBusy(false);
    if (!result.text) { setState('没有识别到文字'); if (continuous.checked) armCapture('auto'); return; }
    await processTurn(result.text, result.elapsedMs);
  } catch (error) {
    recognizing = false; setBusy(false); toast(error.message); setState('识别失败');
    if (continuous.checked) armCapture('auto');
  }
}

send.onclick = () => processTurn(draft.value);
draft.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); processTurn(draft.value); } };
mic.onclick = async () => {
  if (captureMode === 'manual') { finishCapture(); return; }
  if (busy || playing) interruptTurn();
  try { await ensureMic(); armCapture('manual', true); }
  catch { toast('无法使用麦克风。请在浏览器里允许这个本机页面使用麦克风。'); }
};
continuous.onchange = async () => {
  if (!continuous.checked) { captureMode = null; mic.classList.remove('recording'); setState('连续模式已关闭'); return; }
  try { await ensureMic(); armCapture('auto'); }
  catch { continuous.checked = false; toast('没有取得麦克风权限。'); }
};
$('#stop-audio').onclick = stopPlayback;
$('#sample-play').onclick = async () => {
  const text = $('#sample').value.trim();
  if (!text) return toast('先输入一句试听文字');
  setBusy(true);
  const item = addMessage('assistant', text);
  try { await voiceFor(text, item, false); }
  catch (error) { item.remove(); toast(error.message); setState('试听失败'); }
  finally { setBusy(false); }
};
health();

