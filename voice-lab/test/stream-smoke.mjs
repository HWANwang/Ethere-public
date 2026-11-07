import assert from 'node:assert/strict';

const started = performance.now();
const response = await fetch('http://127.0.0.1:4189/api/chat-stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '早上好。请用三句简短的话告诉我，今天可以怎么轻松地开始。每句都用句号结束。' }),
  signal: AbortSignal.timeout(100_000),
});
assert.equal(response.status, 200);
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let fullText = '';
let audioCount = 0;
let result;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === 'delta') fullText += event.text;
    if (event.type === 'audio') {
      audioCount++;
      assert.ok(Buffer.from(event.audioBase64, 'base64').byteLength > 1000);
      console.log({ event: 'first-audio-or-segment', segment: event.index, atMs: Math.round(performance.now() - started), ttsMs: event.ttsMs });
    }
    if (event.type === 'audio_error') console.log({ event: 'audio_error', message: event.message });
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'done') result = event;
  }
}
assert.ok(result, 'stream must end with done');
assert.equal(result.text, fullText.trim());
assert.ok(audioCount > 0, 'Fish must synthesize at least one segment');
console.log({ event: 'done', characters: fullText.length, segments: audioCount,
  firstDeltaMs: result.firstDeltaMs, firstAudioMs: result.firstAudioMs,
  modelMs: result.modelMs, totalMs: result.totalMs });
