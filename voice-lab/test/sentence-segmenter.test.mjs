import test from 'node:test';
import assert from 'node:assert/strict';
import { SentenceSegmenter } from '../sentence-segmenter.mjs';

test('segments partial deltas at punctuation without losing text', () => {
  const segmenter = new SentenceSegmenter();
  assert.deepEqual(segmenter.push('早上'), []);
  assert.deepEqual(segmenter.push('好。今天'), ['早上好。']);
  assert.deepEqual(segmenter.push('慢慢来。'), ['今天慢慢来。']);
  assert.deepEqual(segmenter.finish(), []);
});

test('flushes unfinished final phrase', () => {
  const segmenter = new SentenceSegmenter();
  segmenter.push('我在这里');
  assert.deepEqual(segmenter.finish(), ['我在这里']);
});
