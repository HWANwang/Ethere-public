import { BargeInGate, SentenceSegmenter, shouldFinishUtterance } from './voice-turn.js';

export function createVoiceCall({ api, nativePermissions = null, sendText, interruptTurn, showToast, getVoiceId = () => '', getAssistantName = () => 'Ethere' }) {
  const panel = document.querySelector('[data-voice-call]');
  const status = panel.querySelector('[data-voice-call-state]');
  const muteButton = panel.querySelector('[data-voice-call-mute]');
  const outputButton = panel.querySelector('[data-voice-call-output]');
  const routeSheet = panel.querySelector('[data-voice-call-routes]');
  const routeOptions = panel.querySelector('[data-voice-route-options]');
  const audio = new Audio();
  audio.preload = 'auto';
  const bargeIn = new BargeInGate();
  let stream = null;
  let context = null;
  let processor = null;
  let active = false;
  let callId = '';
  let callStartedAt = 0;
  let muted = false;
  let busy = false;
  let playing = false;
  let recognizing = false;
  let captureMode = false;
  let captured = [];
  let preroll = [];
  let startedAt = 0;
  let lastVoiceAt = 0;
  let speechAbort = null;
  let speechChain = Promise.resolve();
  let speechGeneration = 0;
  let queuedSpeechCount = 0;
  let resolvePlayback = null;
  let activeTurnDone = Promise.resolve();
  let resolveTurn = () => {};
  let turnTiming = null;
  let callEventChain = Promise.resolve();
  const setState = (text) => { status.textContent = text; };
  const recordCallEvent = (event) => {
    if (!api.recordCallEvent) return;
    callEventChain = callEventChain.then(() => api.recordCallEvent(event)).catch(() => {});
  };

  function resetCapture() { captured = []; preroll = []; startedAt = 0; lastVoiceAt = 0; captureMode = true; if (active && !muted) setState('正在聆听…'); }
  function stopSpeech() {
    speechGeneration += 1;
    speechAbort?.abort();
    speechAbort = null;
    resolvePlayback?.();
    resolvePlayback = null;
    audio.pause();
    audio.removeAttribute('src');
    playing = false;
    speechChain = Promise.resolve();
    queuedSpeechCount = 0;
  }
  function interrupt() {
    stopSpeech();
    if (busy) void interruptTurn().catch(() => {});
    setState('我在听，继续说…');
  }
  async function start(direction = 'outgoing', openingText = '') {
    if (active) return;
    const health = await api.voiceHealth();
    if (!health.available) throw new Error('电脑端语音服务尚未就绪');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不能使用麦克风');
    if (nativePermissions?.requestMicrophonePermission) {
      const result = await nativePermissions.requestMicrophonePermission();
      if (result.status !== 'granted') throw new Error('需要麦克风权限才能通话');
    }
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false });
    try {
      if (nativePermissions?.startCallForeground) await nativePermissions.startCallForeground({ name: getAssistantName() });
      context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(2048, 1, 1);
      source.connect(processor);
      processor.connect(context.destination);
      processor.onaudioprocess = onAudioProcess;
      active = true;
      callId = crypto.randomUUID();
      callStartedAt = Date.now();
      callEventChain = Promise.resolve();
      recordCallEvent({ callId, event: 'started', direction });
      muted = false;
      muteButton?.classList.remove('is-muted');
      if (muteButton) muteButton.querySelector('span').textContent = '静音';
      panel.hidden = false;
      if (direction === 'incoming' && String(openingText || '').trim()) {
        const firstLine = String(openingText).trim();
        captureMode = false;
        bargeIn.reset();
        setState('正在说话…');
        recordCallEvent({ callId, event: 'opening', text: firstLine });
        const segmenter = new SentenceSegmenter();
        for (const sentence of [...segmenter.push(firstLine), ...segmenter.finish()]) {
          for (let offset = 0; offset < sentence.length; offset += 400) queueSpeech(sentence.slice(offset, offset + 400));
        }
      } else resetCapture();
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      if (nativePermissions?.stopCallForeground) void nativePermissions.stopCallForeground().catch(() => {});
      throw error;
    }
  }
  async function end() {
    if (!active && !stream) return;
    const endedCallId = callId;
    const durationSeconds = Math.max(0, Math.round((Date.now() - callStartedAt) / 1000));
    active = false;
    callId = '';
    if (endedCallId) recordCallEvent({ callId: endedCallId, event: 'ended', durationSeconds });
    captureMode = false;
    stopSpeech();
    if (busy) void interruptTurn().catch(() => {});
    processor?.disconnect();
    if (processor) processor.onaudioprocess = null;
    processor = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    await context?.close().catch(() => {});
    context = null;
    panel.hidden = true;
    if (routeSheet) routeSheet.hidden = true;
    if (nativePermissions?.stopCallForeground) void nativePermissions.stopCallForeground().catch(() => {});
  }

  function onAudioProcess(event) {
    event.outputBuffer.getChannelData(0).fill(0);
    if (!active || muted) return;
    const frame = new Float32Array(event.inputBuffer.getChannelData(0));
    const now = performance.now();
    let power = 0;
    for (const sample of frame) power += sample * sample;
    const rms = Math.sqrt(power / frame.length);
    if (!captureMode && !recognizing && (busy || playing || queuedSpeechCount > 0)) {
      if (bargeIn.observe(rms, now, frame, { playing })) {
        const leadIn = [...bargeIn.preroll];
        interrupt();
        resetCapture();
        captured = leadIn;
        startedAt = now;
        lastVoiceAt = now;
        bargeIn.reset();
      }
      return;
    }
    if (!captureMode) { bargeIn.reset(); return; }
    if (!startedAt) {
      preroll.push(frame);
      if (preroll.length > 12) preroll.shift();
      if (rms > .018) { startedAt = now; lastVoiceAt = now; captured = [...preroll]; preroll = []; setState('听到了，继续说…'); }
    } else {
      captured.push(frame);
      if (rms > .018) lastVoiceAt = now;
      if (shouldFinishUtterance({ now, startedAt, lastVoiceAt })) void finishCapture();
    }
  }

  async function finishCapture() {
    if (!captureMode) return;
    const frames = captured;
    captureMode = false;
    captured = [];
    if (!frames.length || frames.reduce((sum, frame) => sum + frame.length, 0) / context.sampleRate < .35) { if (active) resetCapture(); return; }
    recognizing = true;
    const turnStartedAt = performance.now();
    setState('正在听懂你说的话…');
    let result;
    try {
      const wav = encodeWav(frames, context.sampleRate);
      let binary = '';
      for (let offset = 0; offset < wav.length; offset += 8192) binary += String.fromCharCode(...wav.subarray(offset, offset + 8192));
      result = await api.voiceAsr(btoa(binary));
    } catch (error) {
      if (active) { showToast(error.message || '语音识别失败'); setState('没听清，再说一次？'); resetCapture(); }
      return;
    } finally {
      recognizing = false;
    }
    try {
      await activeTurnDone;
      if (active && result.text?.trim()) await processTurn(result.text.trim(), { turnStartedAt, asrMs: Math.round(performance.now() - turnStartedAt) });
      else if (active) resetCapture();
    } finally {
      if (active && !busy && !playing && queuedSpeechCount === 0 && !captureMode) resetCapture();
    }
  }

  async function processTurn(text, timing = {}) {
    if (!active) return;
    busy = true;
    captureMode = false;
    stopSpeech();
    const turnGeneration = speechGeneration;
    bargeIn.reset();
    setState('正在回应…');
    activeTurnDone = new Promise((resolve) => { resolveTurn = resolve; });
    const segmenter = new SentenceSegmenter();
    const ready = [];
    let allText = '';
    let speechStarted = false;
    let startTimer = 0;
    turnTiming = { callId, turnStartedAt: timing.turnStartedAt ?? performance.now(), asrMs: timing.asrMs ?? null,
      firstDeltaMs: null, firstTtsMs: null, firstPlayMs: null, replyDoneMs: null, reported: false };
    const currentTiming = turnTiming;
    const beginSpeech = () => {
      if (speechStarted || !active) return;
      ready.push(...segmenter.flushPartial());
      if (!ready.length) { startTimer = 0; return; }
      speechStarted = true;
      for (const segment of ready.splice(0)) queueSpeech(segment, currentTiming);
    };
    try {
      await sendText(text, {
        onDelta(delta) {
          if (turnGeneration !== speechGeneration || !active) return;
          if (currentTiming.firstDeltaMs == null) currentTiming.firstDeltaMs = Math.round(performance.now() - currentTiming.turnStartedAt);
          allText += delta;
          for (const segment of segmenter.push(delta)) { if (speechStarted) queueSpeech(segment, currentTiming); else ready.push(segment); }
          if (!speechStarted && !startTimer) startTimer = window.setTimeout(beginSpeech, ready.length ? 650 : 1400);
        },
      });
      if (turnGeneration !== speechGeneration || !active) return;
      currentTiming.replyDoneMs = Math.round(performance.now() - currentTiming.turnStartedAt);
      window.clearTimeout(startTimer);
      if (!speechStarted) {
        for (let offset = 0; offset < allText.length; offset += 400) queueSpeech(allText.slice(offset, offset + 400), currentTiming);
      } else {
        for (const segment of ready) queueSpeech(segment, currentTiming);
        for (const segment of segmenter.finish()) queueSpeech(segment, currentTiming);
      }
      if (!allText.trim()) setState('暂时没有听到回复');
    } catch (error) {
      window.clearTimeout(startTimer);
      if (turnGeneration === speechGeneration) {
        reportVoiceTiming(currentTiming, error.message || 'chat_failed');
        if (active) { showToast(error.message || '通话回复失败'); setState('回复暂时中断，再说一次？'); }
      }
    } finally {
      busy = false;
      resolveTurn();
      if (active && !playing && !recognizing && !captureMode && queuedSpeechCount === 0) resetCapture();
    }
  }

  function reportVoiceTiming(timing, error = '') {
    if (!timing || timing.reported) return;
    timing.reported = true;
    void api.reportVoiceTiming?.({ callId: timing.callId, asrMs: timing.asrMs, firstDeltaMs: timing.firstDeltaMs,
      firstTtsMs: timing.firstTtsMs, firstPlayMs: timing.firstPlayMs, replyDoneMs: timing.replyDoneMs, error }).catch(() => {});
  }

  function queueSpeech(text, timing) {
    if (!text.trim() || !active) return;
    const generation = speechGeneration;
    queuedSpeechCount += 1;
    speechChain = speechChain.then(async () => {
      if (!active || generation !== speechGeneration) return;
      speechAbort = new AbortController();
      const blob = await api.voiceTts(text.slice(0, 400), getVoiceId(), speechAbort.signal);
      if (!active || generation !== speechGeneration) return;
      if (timing && timing.firstTtsMs == null) timing.firstTtsMs = Math.round(performance.now() - timing.turnStartedAt);
      const url = URL.createObjectURL(blob);
      try {
        audio.src = url;
        playing = true;
        setState('正在说话…');
        await new Promise((resolve, reject) => {
          resolvePlayback = resolve;
          audio.onended = () => { resolvePlayback = null; resolve(); };
          audio.onerror = () => { resolvePlayback = null; reject(new Error('语音播放失败')); };
          audio.play().then(() => {
            if (timing && timing.firstPlayMs == null) {
              timing.firstPlayMs = Math.round(performance.now() - timing.turnStartedAt);
              reportVoiceTiming(timing);
            }
          }).catch((error) => { resolvePlayback = null; reject(error); });
        });
      } finally { playing = false; URL.revokeObjectURL(url); }
    }).catch((error) => {
      if (error.name !== 'AbortError') reportVoiceTiming(timing, error.message || 'playback_failed');
      if (active && error.name !== 'AbortError' && generation === speechGeneration) { showToast(error.message || '语音暂时不可用'); setState('文字已保存，语音暂时不可用'); }
    }).finally(() => {
      if (generation === speechGeneration) queuedSpeechCount = Math.max(0, queuedSpeechCount - 1);
      if (active && !busy && !playing && !recognizing && queuedSpeechCount === 0 && generation === speechGeneration) resetCapture();
    });
  }

  muteButton?.addEventListener('click', () => {
    if (!active) return;
    muted = !muted;
    for (const track of stream?.getAudioTracks() || []) track.enabled = !muted;
    muteButton.classList.toggle('is-muted', muted);
    muteButton.querySelector('span').textContent = muted ? '取消静音' : '静音';
    setState(muted ? '麦克风已静音' : '正在聆听…');
    if (!muted && !busy && !playing) resetCapture();
  });
  function closeAudioPicker() {
    if (!routeSheet || routeSheet.hidden) return false;
    routeSheet.hidden = true;
    return true;
  }
  outputButton?.addEventListener('click', async () => {
    if (!nativePermissions?.listAudioOutputs || !routeSheet || !routeOptions) return showToast('请在手机上切换音频输出');
    try {
      const { devices = [], selectedId = 0 } = await nativePermissions.listAudioOutputs();
      routeOptions.replaceChildren();
      if (!devices.length) return showToast('没有可切换的音频设备');
      for (const device of devices) {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.textContent = device.label;
        choice.className = Number(device.id) === Number(selectedId) ? 'is-active' : '';
        choice.addEventListener('click', async () => {
          choice.disabled = true;
          try { await nativePermissions.selectAudioOutput({ id: Number(device.id) }); routeSheet.hidden = true; }
          catch (error) { showToast(error.message || '音频切换失败'); choice.disabled = false; }
        });
        routeOptions.append(choice);
      }
      routeSheet.hidden = false;
    } catch (error) { showToast(error.message || '无法读取音频设备'); }
  });
  panel.querySelector('[data-close-voice-routes]')?.addEventListener('click', closeAudioPicker);
  panel.querySelector('[data-voice-call-end]').addEventListener('click', () => { void end(); });
  return { start, end, closeAudioPicker, isOpen: () => !panel.hidden };
}

function encodeWav(frames, inputRate) {
  const count = frames.reduce((sum, frame) => sum + frame.length, 0);
  const input = new Float32Array(count);
  let at = 0;
  for (const frame of frames) { input.set(frame, at); at += frame.length; }
  const outputRate = 16000;
  const outputCount = Math.floor(count * outputRate / inputRate);
  const view = new DataView(new ArrayBuffer(44 + outputCount * 2));
  const write = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + outputCount * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, outputRate, true); view.setUint32(28, outputRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, outputCount * 2, true);
  for (let i = 0; i < outputCount; i++) {
    const source = i * inputRate / outputRate;
    const index = Math.floor(source);
    const sample = input[index] * (1 - (source - index)) + (input[Math.min(index + 1, input.length - 1)] || 0) * (source - index);
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
  }
  return new Uint8Array(view.buffer);
}
