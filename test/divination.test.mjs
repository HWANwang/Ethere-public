import test from 'node:test';
import assert from 'node:assert/strict';
import { castCoinLine, castPlumNumbers, formatCoinReading, formatPlumReading, randomInt } from '../web/divination.js';

test('randomInt stays inclusive and rejects the biased uint32 tail', () => {
  assert.equal(randomInt(2, () => 0), 1);
  assert.equal(randomInt(2, () => 1), 2);
  const values = [0xffff_ffff, 0];
  assert.equal(randomInt(999, () => values.shift()), 1);
  assert.equal(values.length, 0);
});

test('three coins cover all four line types with their changing status', () => {
  for (const [raw, expected, name, changing] of [
    [[0, 0, 0], 6, '老阴', true],
    [[1, 0, 0], 7, '少阳', false],
    [[1, 1, 0], 8, '少阴', false],
    [[1, 1, 1], 9, '老阳', true],
  ]) {
    const values = [...raw];
    const line = castCoinLine(() => values.shift());
    assert.equal(line.value, expected);
    assert.equal(line.name, name);
    assert.equal(line.changing, changing);
  }
});

test('six casts are sent bottom-to-top with original faces and without redrawing', () => {
  const values = [0, 1, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1];
  const lines = Array.from({ length: 6 }, () => castCoinLine(() => values.shift()));
  const text = formatCoinReading(lines);
  assert.match(text, /第 1 摇是最下方初爻/);
  assert.match(text, /第 6 摇是最上方上爻/);
  assert.match(text, /第 1 摇：背、字、背 → 7（少阳）/);
  assert.match(text, /第 3 摇：背、背、背 → 6（老阴，动爻）/);
  assert.doesNotMatch(text, /起卦时间|北京时间|请先核对|不要重新随机起卦/);
  assert.throws(() => formatCoinReading(lines.slice(0, 5)), /六次完整/);
});

test('plum two-number method handles remainder zero and preserves both numbers', () => {
  const values = [7, 7];
  const reading = castPlumNumbers(() => values.shift());
  assert.deepEqual([reading.first, reading.second, reading.upper, reading.lower, reading.movingLine],
    [8, 8, '坤', '坤', 4]);
  const text = formatPlumReading(reading);
  assert.match(text, /第一个数：8；第二个数：8/);
  assert.match(text, /动第 4 爻/);
  assert.doesNotMatch(text, /起卦时间|北京时间|请根据这两个固定数字|不要重新随机起卦/);
  assert.equal(castPlumNumbers(() => 0).movingLine, 2);
});
