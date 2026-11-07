import test from 'node:test';
import assert from 'node:assert/strict';
import { BargeInGate, END_SILENCE_MS, MAX_UTTERANCE_MS, shouldFinishUtterance } from '../web/voice-turn.js';

test('slow speaker can pause briefly without sending', () => {
  assert.equal(shouldFinishUtterance({ now: 2_000, startedAt: 100, lastVoiceAt: 1_000 }), false);
  assert.equal(shouldFinishUtterance({ now: 1_000 + END_SILENCE_MS, startedAt: 100, lastVoiceAt: 1_000 }), true);
  assert.equal(shouldFinishUtterance({ now: 100 + MAX_UTTERANCE_MS, startedAt: 100, lastVoiceAt: 100 + MAX_UTTERANCE_MS }), true);
});

test('barge-in ignores brief noise and speaker baseline but accepts sustained voice', () => {
  const gate = new BargeInGate();
  const frame = new Float32Array(256);
  for (const at of [100, 200, 300, 400]) assert.equal(gate.observe(.03, at, frame, { playing: true }), false);
  assert.equal(gate.observe(.055, 600, frame, { playing: true }), false);
  assert.equal(gate.observe(.01, 700, frame, { playing: true }), false);
  for (const at of [800, 1000, 1200]) assert.equal(gate.observe(.09, at, frame, { playing: true }), false);
  assert.equal(gate.observe(.09, 1400, frame, { playing: true }), true);
  gate.reset();
  assert.equal(gate.preroll.length, 0);
});
