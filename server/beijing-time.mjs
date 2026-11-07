const BEIJING_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatBeijingTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('无效的消息时间');
  const parts = Object.fromEntries(BEIJING_TIME_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function withBeijingTime(text, occurredAt = new Date()) {
  const message = String(text || '').trim();
  const prefix = `[消息时间：${formatBeijingTime(occurredAt)} 北京时间]`;
  return message ? `${prefix}\n\n${message}` : prefix;
}
