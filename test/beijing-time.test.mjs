import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBeijingTime, withBeijingTime } from '../server/beijing-time.mjs';

test('server formats model-visible timestamps in Beijing time', () => {
  const time = new Date('2026-10-29T03:18:41.000Z');
  assert.equal(formatBeijingTime(time), '2026-10-29 11:18:41');
  assert.equal(withBeijingTime('正在吃饭', time), '[消息时间：2026-10-29 11:18:41 北京时间]\n\n正在吃饭');
});
