import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceLabServer, validateText } from '../server.mjs';

test('input validation rejects empty and oversized text', () => {
  assert.equal(validateText('  你好  '), '你好');
  assert.throws(() => validateText(' '));
  assert.throws(() => validateText('a'.repeat(401)));
});

test('local server serves only its allowlisted files and rejects cross-site writes', async () => {
  const server = createVoiceLabServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /语音对话实验室/);
    const secret = await fetch(`${base}/secrets/private-key`);
    assert.equal(secret.status, 404);
    const crossSite = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '测试' }),
    });
    assert.equal(crossSite.status, 403);
    const removedVoice = await fetch(`${base}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '测试', engine: 'piper' }),
    });
    assert.equal(removedVoice.status, 400);
    assert.match((await removedVoice.json()).error, /仅支持 Fish/u);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

