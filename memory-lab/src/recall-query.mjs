const COMMON = new Set(['现在', '你看', '看看', '这个', '那个', '已经', '还是', '可以', '一下', '真的', '觉得', '时候', '什么', '怎么', '好像', '因为', '所以', '自己', '我们', '他们', '更新', '没有', '之前', '之后']);

export function focusOf(query) {
  const sentences = String(query || '').split(/[。！？!?；;]+/).map((item) => item.trim()).filter(Boolean);
  const last = sentences.at(-1) || String(query || '').trim();
  const clauses = last.split(/[，,]+/).map((item) => item.trim()).filter(Boolean);
  return clauses.length >= 3 ? clauses.slice(-2).join('，') : last;
}

function grams(text) {
  const out = new Set();
  for (const match of String(text || '').matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    for (let i = 0; i < match[0].length - 1; i++) {
      const value = match[0].slice(i, i + 2);
      if (!COMMON.has(value)) out.add(value);
    }
  }
  return out;
}

export function contextualRecallQuery(query, context = [], occurredAt = new Date().toISOString()) {
  const raw = String(query || '').trim();
  const focus = focusOf(raw);
  if (!Array.isArray(context) || !context.length) return { raw, focus, contextQuery: '', contextSeq: [] };
  const terms = grams(focus);
  if (!terms.size) return { raw, focus, contextQuery: '', contextSeq: [] };
  const now = Date.parse(occurredAt);
  const candidates = context.slice(-24).filter((item) => ['user', 'assistant'].includes(item.role) &&
    Number.isFinite(Date.parse(item.createdAt)) &&
    (!Number.isFinite(now) || now >= Date.parse(item.createdAt) && now - Date.parse(item.createdAt) <= 6 * 60 * 60_000));
  const ranked = candidates.map((item, index) => {
    const content = String(item.content || '').slice(0, 800);
    const overlap = [...terms].filter((term) => content.includes(term));
    return { item, content, overlap, score: overlap.length + index / 1000 };
  }).filter((item) => item.overlap.length).sort((a, b) => b.score - a.score).slice(0, 2);
  if (!ranked.length) return { raw, focus, contextQuery: '', contextSeq: [] };
  const snippets = ranked.map(({ content, overlap }) => {
    const sentences = content.split(/[。！？!?；;\n]+/).map((part) => part.trim()).filter(Boolean);
    const matching = sentences.find((part) => overlap.some((term) => part.includes(term))) || content;
    return matching.slice(0, 180);
  });
  return { raw, focus, contextQuery: `${focus}\n前文讨论的话题线索：${snippets.join('；')}`.slice(0, 550),
    contextSeq: ranked.map(({ item }) => item.seq).filter(Number.isFinite) };
}
