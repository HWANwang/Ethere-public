import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('composer entry opens an undimmed half sheet and sends through the chat queue', async () => {
  const [html, css, app] = await Promise.all([
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../web/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../web/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /data-open-divination/);
  assert.match(html, /data-divination-sheet/);
  assert.match(html, /data-divination-mode="coins"/);
  assert.match(html, /data-divination-mode="plum"/);
  assert.doesNotMatch(html, /和 Ethere 一起看看|<strong>起卦<\/strong>|随机取得两个数，原数会保留下来/);
  assert.match(html, /data-divination-plum-summary>点击后随机报两个数<\/p>/);
  assert.doesNotMatch(html, /data-divination-question/);
  assert.match(css, /\.divination-sheet \{[^}]*height:min\(58%,480px\)/);
  assert.match(css, /\.divination-sheet__header \{[^}]*position:absolute/);
  assert.doesNotMatch(css, /\.divination-sheet[^\n]*backdrop/);
  assert.match(app, /createDivinationSheet\(\{ root: document/);
  assert.match(app, /pendingChatSends\.push\(\{ message: text, images: \[\], files: \[\], messageId, quote: null \}\)/);
});
