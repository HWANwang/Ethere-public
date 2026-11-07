import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.VOICE_LAB_URL || 'http://127.0.0.1:4189';
const root = path.resolve(import.meta.dirname, '..');
const sample = '早上好，今天不用着急，我们慢慢开始。';

async function postJson(route, body) {
  const response = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(100_000),
  });
  if (!response.ok) throw new Error(`${route} HTTP ${response.status}: ${(await response.text()).slice(0, 250)}`);
  return response;
}

const healthResponse = await fetch(base + '/api/health');
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
console.log('health', health);

if (health.asr) {
  const wav = await readFile(path.join(root, 'models', 'asr', 'sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16', 'test_wavs', '0.wav'));
  const result = await (await postJson('/api/asr', { audioBase64: wav.toString('base64') })).json();
  assert.ok(result.text.length > 4);
  console.log('asr', { characters: result.text.length, elapsedMs: result.elapsedMs });
}

if (health.fish) {
  const response = await postJson('/api/tts', { text: sample, engine: 'fish' });
  const bytes = (await response.arrayBuffer()).byteLength;
  assert.ok(bytes > 1000);
  console.log('fish', { bytes, elapsedMs: response.headers.get('x-engine-time-ms') });
}

if (process.env.SKIP_CODEX !== '1') {
  const chat = await (await postJson('/api/chat', { text: '早上好，我在测试语音对话。请自然地回我一句。' })).json();
  assert.ok(chat.text.length > 0);
  console.log('codex', { characters: chat.text.length, elapsedMs: chat.elapsedMs, text: chat.text });
  if (health.fish) {
    const response = await postJson('/api/tts', { text: chat.text.slice(0, 400), engine: 'fish' });
    assert.ok((await response.arrayBuffer()).byteLength > 1000);
    console.log('chain', 'Codex reply synthesized by Fish');
  }
}

