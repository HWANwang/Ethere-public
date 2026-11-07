const TRIGRAMS = ['乾', '兑', '离', '震', '巽', '坎', '艮', '坤'];
const LINE_NAMES = { 6: '老阴', 7: '少阳', 8: '少阴', 9: '老阳' };
const UINT32_RANGE = 0x1_0000_0000;

function secureUint32() {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0];
}

export function randomInt(max, nextUint32 = secureUint32) {
  if (!Number.isSafeInteger(max) || max < 1 || max > UINT32_RANGE) throw new RangeError('随机范围无效');
  const ceiling = Math.floor(UINT32_RANGE / max) * max;
  let value;
  do { value = nextUint32() >>> 0; } while (value >= ceiling);
  return value % max + 1;
}

export function castCoinLine(nextUint32 = secureUint32) {
  const coins = Array.from({ length: 3 }, () => randomInt(2, nextUint32) === 1 ? '背' : '字');
  const value = coins.reduce((sum, coin) => sum + (coin === '字' ? 3 : 2), 0);
  return { coins, value, name: LINE_NAMES[value], changing: value === 6 || value === 9 };
}

export function castPlumNumbers(nextUint32 = secureUint32) {
  const first = randomInt(999, nextUint32);
  const second = randomInt(999, nextUint32);
  const upperNumber = first % 8 || 8;
  const lowerNumber = second % 8 || 8;
  return {
    first, second, upperNumber, lowerNumber,
    upper: TRIGRAMS[upperNumber - 1], lower: TRIGRAMS[lowerNumber - 1],
    movingLine: (first + second) % 6 || 6,
  };
}

export function formatCoinReading(lines) {
  if (!Array.isArray(lines) || lines.length !== 6 || lines.some((line) => !LINE_NAMES[line?.value] || line?.coins?.length !== 3)) {
    throw new Error('六爻必须有六次完整的摇币记录');
  }
  return [
    '【六爻摇币记录】',
    '六次结果按摇出顺序记录；第 1 摇是最下方初爻，第 6 摇是最上方上爻：',
    ...lines.map((line, index) => `- 第 ${index + 1} 摇：${line.coins.join('、')} → ${line.value}（${LINE_NAMES[line.value]}${line.value === 6 || line.value === 9 ? '，动爻' : ''}）`),
  ].join('\n');
}

export function formatPlumReading(reading) {
  if (!reading || !Number.isSafeInteger(reading.first) || !Number.isSafeInteger(reading.second)) throw new Error('缺少报数结果');
  const upperNumber = reading.first % 8 || 8;
  const lowerNumber = reading.second % 8 || 8;
  const movingLine = (reading.first + reading.second) % 6 || 6;
  return [
    '【梅花易数·随机报数】',
    `第一个数：${reading.first}；第二个数：${reading.second}。`,
    `按两数法：第一数除以 8 取上卦，为 ${upperNumber}（${TRIGRAMS[upperNumber - 1]}）；第二数除以 8 取下卦，为 ${lowerNumber}（${TRIGRAMS[lowerNumber - 1]}）；两数之和除以 6，动第 ${movingLine} 爻。余数为 0 时分别按 8 或 6 计。`,
  ].join('\n');
}
