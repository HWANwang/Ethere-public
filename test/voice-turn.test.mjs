import test from 'node:test';
import assert from 'node:assert/strict';
import { BargeInGate, SentenceSegmenter, shouldFinishUtterance } from '../web/voice-turn.js';

test('slow speech waits through a short pause and ends after sustained silence', () => {
  assert.equal(shouldFinishUtterance({ now: 2200, startedAt: 100, lastVoiceAt: 900 }), false);
  assert.equal(shouldFinishUtterance({ now: 3700, startedAt: 100, lastVoiceAt: 900 }), true);
  assert.equal(shouldFinishUtterance({ now: 45100, startedAt: 100, lastVoiceAt: 44800 }), true);
});

test('spoken assistant text is split by sentences without losing the tail', () => {
  const segmenter = new SentenceSegmenter();
  assert.deepEqual(segmenter.push('先说第一句。再'), ['先说第一句。']);
  assert.deepEqual(segmenter.push('说第二句！最后一点'), ['再说第二句！']);
  assert.deepEqual(segmenter.finish(), ['最后一点']);
});

test('a slow unfinished sentence can start speech early without repeating its tail', () => {
  const segmenter = new SentenceSegmenter();
  assert.deepEqual(segmenter.push('我刚刚想起了一件可以跟你分享的事情'), []);
  assert.deepEqual(segmenter.flushPartial(), ['我刚刚想起了一件可以跟你分享的事情']);
  assert.deepEqual(segmenter.push('，接下来再慢慢说。'), ['，接下来再慢慢说。']);
  assert.deepEqual(segmenter.finish(), []);
});

test('barge-in needs sustained user speech over playback rather than one loud frame', () => {
  const gate = new BargeInGate();
  const frame = new Float32Array(2048);
  assert.equal(gate.observe(.08, 1000, frame, { playing: true }), false);
  assert.equal(gate.observe(.08, 1300, frame, { playing: true }), false);
  assert.equal(gate.observe(.22, 1600, frame, { playing: true }), false);
  assert.equal(gate.observe(.22, 2200, frame, { playing: true }), true);
});
