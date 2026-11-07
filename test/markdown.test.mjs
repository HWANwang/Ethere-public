import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownMarkup } from '../web/markdown.js';

test('chat markdown renders tables, lists, headings, code, and links', () => {
  const html = markdownMarkup(`# 小结

| 项目 | 状态 |
| --- | --- |
| 时间轴 | **进行中** |

- 第一项
- 第二项

\`inline\`

\`\`\`js
const ok = true;
\`\`\`

[文档](https://example.com)`);
  assert.match(html, /<h1>小结<\/h1>/);
  assert.match(html, /markdown-table-wrap/);
  assert.match(html, /<strong>进行中<\/strong>/);
  assert.match(html, /<ul><li>第一项<\/li><li>第二项<\/li><\/ul>/);
  assert.match(html, /<code>inline<\/code>/);
  assert.match(html, /language-js/);
  assert.match(html, /href="https:\/\/example\.com"/);
});

test('chat markdown renders task lists as disabled checkboxes', () => {
  const html = markdownMarkup('- [x] 已完成\n- [ ] 未完成');
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /aria-label="已完成"/);
  assert.match(html, /type="checkbox" disabled aria-label="未完成"/);
  assert.doesNotMatch(html, /\[x\]|\[ \]/);
});

test('ordered list remains one list across blank lines and preserves numbering while streaming', () => {
  const partial = markdownMarkup('1. 第一项\n\n2. 第二项\n\n3.');
  assert.match(partial, /<ol><li>第一项<\/li><li>第二项<\/li><\/ol>/);
  const complete = markdownMarkup('1. 第一项\n\n2. 第二项\n\n3. 第三项');
  assert.match(complete, /<ol><li>第一项<\/li><li>第二项<\/li><li>第三项<\/li><\/ol>/);
  assert.equal((complete.match(/<ol/g) || []).length, 1);
  assert.match(markdownMarkup('4. 后续'), /<ol start="4"><li>后续<\/li><\/ol>/);
});

test('chat markdown escapes raw HTML and unsafe links', () => {
  const html = markdownMarkup('<script>alert(1)</script> [危险](javascript:alert(1))');
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /&lt;script&gt;/);
});
