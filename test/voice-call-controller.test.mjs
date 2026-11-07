import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceCall } from '../web/voice-call.js';

test('a spoken turn reaches ASR, chat, TTS, playback, and clean hangup', async () => {
  const originals = new Map();
  const replace = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let clock = 100;
  let processor;
  let foregroundStarts = 0;
  let foregroundStops = 0;
  const asrInputs = [];
  const ttsInputs = [];
  const sentTexts = [];
  const status = { textContent: '' };
  const muteLabel = { textContent: '' };
  const handlers = {};
  const mute = {
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => muteLabel,
    addEventListener: (type, handler) => { handlers.mute = handler; },
  };
  const panel = {
    hidden: true,
    querySelector(selector) {
      if (selector === '[data-voice-call-state]') return status;
      if (selector === '[data-voice-call-mute]') return mute;
      if (selector === '[data-voice-call-end]') return { addEventListener: (type, handler) => { handlers.end = handler; } };
      return null;
    },
  };
  class FakeAudio {
    removeAttribute() {}
    pause() {}
    play() { queueMicrotask(() => this.onended?.()); return Promise.resolve(); }
  }
  class FakeAudioContext {
    sampleRate = 48000;
    destination = {};
    createMediaStreamSource() { return { connect() {} }; }
    createScriptProcessor() { processor = { connect() {}, disconnect() {}, onaudioprocess: null }; return processor; }
    close() { return Promise.resolve(); }
  }
  try {
    replace('document', { querySelector: () => panel });
    replace('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [] }) } });
    replace('window', { setTimeout, clearTimeout });
    replace('performance', { now: () => clock });
    replace('Audio', FakeAudio);
    replace('AudioContext', FakeAudioContext);
    URL.createObjectURL = () => 'blob:voice-test';
    URL.revokeObjectURL = () => {};
    const controller = createVoiceCall({
      api: {
        voiceHealth: async () => ({ available: true }),
        voiceAsr: async (wav) => { asrInputs.push(wav); return { text: '你好' }; },
        voiceTts: async (text) => { ttsInputs.push(text); return new Blob(['audio']); },
      },
      nativePermissions: {
        requestMicrophonePermission: async () => ({ status: 'granted' }),
        startCallForeground: async () => { foregroundStarts += 1; },
        stopCallForeground: async () => { foregroundStops += 1; },
      },
      sendText: async (text, callbacks) => { sentTexts.push(text); callbacks.onDelta('你好呀。'); },
      interruptTurn: async () => {},
      showToast: (message) => assert.fail(message),
    });
    await controller.start();
    assert.equal(panel.hidden, false);
    const speak = (amplitude) => {
      const frame = new Float32Array(2048).fill(amplitude);
      processor.onaudioprocess({
        inputBuffer: { getChannelData: () => frame },
        outputBuffer: { getChannelData: () => new Float32Array(2048) },
      });
      clock += 50;
    };
    for (let i = 0; i < 16; i++) speak(.1);
    for (let i = 0; i < 62; i++) speak(0);
    for (let i = 0; i < 50 && ttsInputs.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(asrInputs.length, 1);
    assert.equal(sentTexts[0], '你好');
    assert.deepEqual(ttsInputs, ['你好呀。']);
    assert.equal(foregroundStarts, 1);
    await controller.end();
    assert.equal(panel.hidden, true);
    assert.equal(foregroundStops, 1);
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('speaking over playback keeps the captured interruption after the old turn ends', async () => {
  const originals = new Map();
  const replace = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let clock = 100;
  let processor;
  let firstResolve;
  let interruptCalls = 0;
  let asrCalls = 0;
  let audioPlays = 0;
  const sentTexts = [];
  const panel = {
    hidden: true,
    querySelector(selector) {
      if (selector === '[data-voice-call-state]') return { textContent: '' };
      if (selector === '[data-voice-call-mute]') return { classList: { remove() {} }, querySelector: () => ({ textContent: '' }), addEventListener() {} };
      if (selector === '[data-voice-call-end]') return { addEventListener() {} };
      return null;
    },
  };
  class FakeAudio {
    removeAttribute() {}
    pause() {}
    play() { audioPlays += 1; return Promise.resolve(); }
  }
  class FakeAudioContext {
    sampleRate = 48000;
    destination = {};
    createMediaStreamSource() { return { connect() {} }; }
    createScriptProcessor() { processor = { connect() {}, disconnect() {}, onaudioprocess: null }; return processor; }
    close() { return Promise.resolve(); }
  }
  try {
    replace('document', { querySelector: () => panel });
    replace('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    replace('window', { setTimeout: (fn, ms) => ms === 900 ? (queueMicrotask(fn), 1) : setTimeout(fn, ms), clearTimeout: (id) => { if (id !== 1) clearTimeout(id); } });
    replace('performance', { now: () => clock });
    replace('Audio', FakeAudio);
    replace('AudioContext', FakeAudioContext);
    URL.createObjectURL = () => 'blob:barge-in-test';
    URL.revokeObjectURL = () => {};
    const controller = createVoiceCall({
      api: {
        voiceHealth: async () => ({ available: true }),
        voiceAsr: async () => ({ text: ++asrCalls === 1 ? '第一句' : '补充' }),
        voiceTts: async () => new Blob(['audio']),
      },
      sendText: (text, callbacks) => {
        sentTexts.push(text);
        callbacks.onDelta(text === '第一句' ? '好。' : '收到。');
        return text === '第一句' ? new Promise((resolve) => { firstResolve = resolve; }) : Promise.resolve();
      },
      interruptTurn: async () => { interruptCalls += 1; firstResolve?.(); },
      showToast: (message) => assert.fail(message),
    });
    await controller.start();
    const frame = (amplitude) => {
      const input = new Float32Array(2048).fill(amplitude);
      processor.onaudioprocess({ inputBuffer: { getChannelData: () => input }, outputBuffer: { getChannelData: () => new Float32Array(2048) } });
      clock += 50;
    };
    for (let i = 0; i < 16; i++) frame(.1);
    for (let i = 0; i < 62; i++) frame(0);
    for (let i = 0; i < 50 && audioPlays === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(audioPlays, 1);
    for (let i = 0; i < 10; i++) frame(.01);
    for (let i = 0; i < 14; i++) frame(.1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(interruptCalls, 1);
    for (let i = 0; i < 2; i++) frame(.1);
    for (let i = 0; i < 62; i++) frame(0);
    for (let i = 0; i < 50 && sentTexts.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(sentTexts, ['第一句', '补充']);
    await controller.end();
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('incoming call plays its prepared opening line immediately and allows barge-in', async () => {
  const originals = new Map();
  const replace = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let processor;
  let clock = 100;
  let interruptedPlayback = 0;
  const spoken = [];
  const events = [];
  const panel = { hidden: true, querySelector(selector) {
    if (selector === '[data-voice-call-state]') return { textContent: '' };
    if (selector === '[data-voice-call-mute]') return { classList: { remove() {} }, querySelector: () => ({ textContent: '' }), addEventListener() {} };
    if (selector === '[data-voice-call-end]') return { addEventListener() {} };
    return null;
  } };
  class FakeAudio {
    removeAttribute() {}
    pause() { interruptedPlayback += 1; }
    play() { return Promise.resolve(); }
  }
  class FakeAudioContext {
    sampleRate = 48000; destination = {};
    createMediaStreamSource() { return { connect() {} }; }
    createScriptProcessor() { processor = { connect() {}, disconnect() {}, onaudioprocess: null }; return processor; }
    close() { return Promise.resolve(); }
  }
  try {
    replace('document', { querySelector: () => panel });
    replace('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    replace('window', { setTimeout, clearTimeout });
    replace('performance', { now: () => clock });
    replace('Audio', FakeAudio);
    replace('AudioContext', FakeAudioContext);
    URL.createObjectURL = () => 'blob:opening-test';
    URL.revokeObjectURL = () => {};
    const controller = createVoiceCall({
      api: { voiceHealth: async () => ({ available: true }), voiceTts: async (text) => { spoken.push(text); return new Blob(['audio']); },
        recordCallEvent: async (event) => { events.push(event); }, voiceAsr: async () => ({ text: '等一下' }) },
      sendText: async () => {}, interruptTurn: async () => {}, showToast: (message) => assert.fail(message),
    });
    await controller.start('incoming', '早上好用户，今天聊聊你的安排吧');
    for (let i = 0; i < 40 && spoken.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(spoken.length > 0);
    assert.equal(spoken.join(''), '早上好用户，今天聊聊你的安排吧');
    for (let i = 0; i < 40 && !events.some((event) => event.event === 'opening'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(events.find((event) => event.event === 'opening')?.text, '早上好用户，今天聊聊你的安排吧');
    for (let i = 0; i < 26; i++) {
      const frame = new Float32Array(2048).fill(i < 10 ? .01 : .1);
      processor.onaudioprocess({ inputBuffer: { getChannelData: () => frame }, outputBuffer: { getChannelData: () => new Float32Array(2048) } });
      clock += 50;
    }
    assert.ok(interruptedPlayback > 0);
    await controller.end();
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
