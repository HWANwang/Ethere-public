export const AUTO_INJECTION_POLICY = Object.freeze({
  limit: 3,
  threshold: 0.40,
  scoreGap: 0.018,
  lexicalWeight: 0.012,
  maxLexicalBonus: 0.09,
});

// The small IDF bonus corrects near-tie semantic hits with a concrete query term;
// the score gap removes the unrelated tail. Both apply only to passive injection.
export function selectAutoInjection(query, candidates, corpus, policy = AUTO_INJECTION_POLICY) {
  if (!candidates.length) return [];
  const queryGrams = grams(query);
  const documentGrams = corpus.map((item) => grams(item.content || item.memory?.content || ''));
  const frequency = new Map();
  for (const tokens of documentGrams) for (const token of tokens) frequency.set(token, (frequency.get(token) || 0) + 1);
  const scored = candidates.map((item) => {
    const tokens = grams(item.memory.content);
    const overlap = [...queryGrams].filter((token) => tokens.has(token))
      .reduce((sum, token) => sum + Math.log((corpus.length + 1) / ((frequency.get(token) || 0) + 1)), 0);
    const lexicalBonus = Math.min(policy.maxLexicalBonus, overlap * policy.lexicalWeight);
    return { ...item, selectionScore: item.score + lexicalBonus };
  }).sort((a, b) => b.selectionScore - a.selectionScore);
  const best = scored[0].selectionScore;
  return scored.filter((item) => item.selectionScore >= best - policy.scoreGap).slice(0, policy.limit);
}

export function topicalSupport(raw, focus, contextQuery, content) {
  const overlap = (size, text) => {
    const source = ngrams(text, size);
    const target = ngrams(content, size);
    return [...source].filter((token) => target.has(token)).length;
  };
  if (overlap(3, focus)) return 3;
  if (overlap(3, raw)) return 2.5;
  if (overlap(2, focus) >= 2) return 2;
  if (overlap(2, raw) >= 3) return 1.5;
  if (contextQuery && overlap(3, contextQuery) && overlap(2, focus)) return 1;
  if (overlap(2, focus)) return .5;
  return 0;
}

const GENERIC = new Set(['更新','新的','时候','一个','现在','没有','已经','最后','可以','自己','之前','之后','用户','他的','这个','那个','需要','但是','还是','觉得','进行','结果','今天','以后','可能','一些','如果','什么','问题','内容']);
function ngrams(value, size) {
  const output = new Set();
  for (const match of String(value || '').matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const blocked=new Array(match[0].length).fill(false);
    for(const generic of GENERIC){let at=match[0].indexOf(generic);while(at>=0){for(let i=at;i<at+generic.length;i++)blocked[i]=true;at=match[0].indexOf(generic,at+1);}}
    for (let index = 0; index <= match[0].length - size; index++) {
      const token = match[0].slice(index, index + size);
      if (!blocked.slice(index,index+size).some(Boolean)) output.add(token);
    }
  }
  for (const match of String(value || '').matchAll(/[a-zA-Z][a-zA-Z0-9-]{2,}/g))
    output.add(match[0].toLowerCase());
  return output;
}

function grams(value) {
  const output = new Set();
  for (const match of String(value || '').matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    for (let index = 0; index < match[0].length - 1; index++) output.add(match[0].slice(index, index + 2));
  }
  return output;
}
