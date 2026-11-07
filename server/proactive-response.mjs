export const SILENT_REPLY = 'ETHERE_SILENT';

export function proactiveVisibleText(result) {
  const timeline = Array.isArray(result?.timeline) ? result.timeline : [];
  const finalSegment = timeline.length ? timeline.at(-1) : null;
  const text = String(finalSegment ? (finalSegment.type === 'assistant' ? finalSegment.text : '') : result?.text || '').trim();
  if (text.split(/\r?\n/).some((line) => line.trim().replace(/^`+|`+$/g, '') === SILENT_REPLY)) return '';
  return text;
}
