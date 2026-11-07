import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { VoiceCodexClient } from './codex-app-server.mjs';
import { SentenceSegmenter } from './sentence-segmenter.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.VOICE_LAB_PORT || 4189);
const PYTHON = process.env.VOICE_LAB_PYTHON || path.join(ROOT, '.venv', 'Scripts', 'python.exe');
const CODEX = process.env.VOICE_LAB_CODEX || 'codex';
const VOICE_ID = '3581b26bce1840f4a70dd0269946120c';
const VOICE_IDS = new Set([VOICE_ID, '341cfd4c96c04c14a93cfef439e02714', '1bba004267fc49dd9c1192ba36195cd8', '74b14e03c1a64fbdb50a2377afd79042']);
const RUNTIME = path.join(ROOT, 'runtime');
const THREAD_FILE = path.join(RUNTIME, 'thread.json');
const MODEL_ASR = path.join(ROOT, 'models', 'asr', 'sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16');

export function validateText(value, maximum = 400) {
  if (typeof value !== 'string') throw new Error('请输入文字');
  const clean = value.trim();
  if (!clean || clean.length > maximum) throw new Error(`文字长度须为 1–${maximum} 字`);
  return clean;
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function bodyJson(req, maximum = 100_000) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maximum) throw new Error('请求过大');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求格式错误');
  }
}

class AudioWorker {
  child = null;
  nextId = 0;
  pending = new Map();
  partial = '';

  ensure() {
    if (this.child) return;
    const child = spawn(PYTHON, [path.join(ROOT, 'worker.py')], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OMP_NUM_THREADS: '2', ORT_LOGGING_LEVEL: '3', PYTHONIOENCODING: 'utf-8' },
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      this.partial += chunk;
      for (;;) {
        const pos = this.partial.indexOf('\n');
        if (pos < 0) break;
        const line = this.partial.slice(0, pos);
        this.partial = this.partial.slice(pos + 1);
        try {
          const result = JSON.parse(line);
          const pending = this.pending.get(result.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(result.id);
          result.ok ? pending.resolve(result) : pending.reject(new Error(result.error || '本地模型运行失败'));
        } catch {
          // Malformed worker output never reaches the browser.
        }
      }
    });
    child.stderr.on('data', () => {});
    const fail = () => {
      if (this.child !== child) return;
      this.child = null;
      this.partial = '';
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('本地语音进程已退出'));
      }
      this.pending.clear();
    };
    child.on('error', fail);
    child.on('exit', fail);
  }

  ask(op, data, timeoutMs = 30_000) {
    this.ensure();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('本地语音处理超时'));
        this.child?.kill();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, ...data }) + '\n', error => {
        if (error && this.pending.has(id)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error('无法启动本地语音进程'));
        }
      });
    });
  }
}

const audioWorker = new AudioWorker();
async function getFishKey() {
  const key = process.env.FISH_API_KEY?.trim();
  if (!key) throw new Error('未配置 FISH_API_KEY');
  return key;
}

async function fishTts(text, voiceId = VOICE_ID) {
  if (!VOICE_IDS.has(voiceId)) throw new Error('不支持的音色');
  const key = await getFishKey();
  const started = performance.now();
  const response = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      model: 's2.1-pro-free',
    },
    body: JSON.stringify({ text, reference_id: voiceId, format: 'mp3', latency: 'balanced' }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Fish 语音服务返回 HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100) throw new Error('Fish 返回的音频为空');
  return { bytes, contentType: 'audio/mpeg', elapsedMs: Math.round(performance.now() - started) };
}

const appServer = new VoiceCodexClient({ command: CODEX });
const VOICE_INSTRUCTIONS = '你在独立语音体验测试中，不连接 Ethere，不读写文件，不调用工具。像自然聊天一样用中文回应：温暖、具体、简短，尽量用两三句完整短句，每句有标点。不要播报技术状态。';
let appThreadReady = null;
let activeChat = false;
appServer.onClose(() => { appThreadReady = null; });

async function ensureVoiceThread() {
  if (!appThreadReady) {
    appThreadReady = (async () => {
      await appServer.initialize();
      await mkdir(RUNTIME, { recursive: true });
      let threadId = null;
      try { threadId = JSON.parse(await readFile(THREAD_FILE, 'utf8')).threadId; } catch { }
      if (threadId) {
        await appServer.request('thread/resume', {
          threadId, cwd: ROOT, model: 'gpt-6-luna', sandbox: 'read-only',
          approvalPolicy: 'never', developerInstructions: VOICE_INSTRUCTIONS,
        });
      } else {
        const result = await appServer.request('thread/start', {
          cwd: ROOT, model: 'gpt-6-luna', sandbox: 'read-only',
          approvalPolicy: 'never', developerInstructions: VOICE_INSTRUCTIONS,
        });
        threadId = result?.thread?.id || result?.threadId;
        if (!threadId) throw new Error('Codex 未返回测试线程 ID');
        await writeFile(THREAD_FILE, JSON.stringify({ threadId }), 'utf8');
      }
      return threadId;
    })().catch(error => { appThreadReady = null; throw error; });
  }
  return appThreadReady;
}

async function codexChat(userText, { onDelta = () => {}, signal } = {}) {
  if (activeChat) throw new Error('上一轮对话仍在生成，请稍等');
  activeChat = true;
  const started = performance.now();
  let unsubscribe = () => {};
  let unsubscribeClose = () => {};
  let timer;
  let abortHandler;
  try {
    const threadId = await ensureVoiceThread();
    let turnId = '';
    let output = '';
    let firstDeltaMs = null;
    let settle;
    let fail;
    let ended = false;
    const completion = new Promise((resolve, reject) => {
      settle = value => { if (!ended) { ended = true; resolve(value); } };
      fail = error => { if (!ended) { ended = true; reject(error); } };
    });
    // A failed turn/start may reject before completion is awaited.
    completion.catch(() => {});
    abortHandler = () => {
      if (turnId) void appServer.request('turn/interrupt', { threadId, turnId }).catch(() => {});
    };
    signal?.addEventListener('abort', abortHandler, { once: true });
    unsubscribeClose = appServer.onClose(fail);
    unsubscribe = appServer.onMessage(message => {
      const params = message?.params || {};
      if (params.threadId && params.threadId !== threadId) return;
      const eventTurnId = params.turnId || params.turn?.id || '';
      if (turnId && eventTurnId && eventTurnId !== turnId) return;
      if (!turnId && eventTurnId) turnId = eventTurnId;
      if (message.id != null && /requestApproval$/u.test(message.method || '')) {
        appServer.respond(message.id, { decision: 'decline' });
        return;
      }
      if (message.method === 'item/agentMessage/delta') {
        const delta = typeof params.delta === 'string' ? params.delta : params.delta?.text || '';
        if (delta) {
          if (firstDeltaMs == null) firstDeltaMs = Math.round(performance.now() - started);
          output += delta;
          onDelta(delta);
        }
      }
      if (message.method === 'item/completed' && params.item?.type === 'agentMessage' && !output) {
        const fallback = params.item?.text || params.item?.content?.map(part => part.text || '').join('') || '';
        if (fallback) {
          firstDeltaMs = Math.round(performance.now() - started);
          output = fallback;
          onDelta(fallback);
        }
      }
      if (message.method === 'turn/failed') fail(new Error(params.turn?.error?.message || 'Codex 回复失败'));
      if (message.method === 'turn/completed') {
        const status = params.turn?.status || 'unknown';
        if (status !== 'completed') fail(new Error(`Codex 回合状态：${status}`));
        else settle(status);
      }
    });
    timer = setTimeout(() => {
      abortHandler();
      fail(new Error('Codex 回复超时'));
    }, 90_000);
    const result = await appServer.request('turn/start', {
      threadId, cwd: ROOT, model: 'gpt-6-luna', effort: 'low',
      input: [{ type: 'text', text: userText }],
      approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' },
    });
    turnId = result?.turn?.id || result?.turnId || turnId;
    if (signal?.aborted) abortHandler();
    await completion;
    if (!output.trim()) throw new Error('Codex 没有返回文字');
    return { text: output.trim(), elapsedMs: Math.round(performance.now() - started), firstDeltaMs };
  } finally {
    clearTimeout(timer);
    unsubscribe();
    unsubscribeClose();
    if (abortHandler) signal?.removeEventListener('abort', abortHandler);
    activeChat = false;
  }
}

async function serveStatic(urlPath, res) {
  const assets = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/voice-turn.js': ['voice-turn.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/stream.css': ['stream.css', 'text/css; charset=utf-8'],
  };
  const asset = assets[urlPath];
  if (!asset) { json(res, 404, { error: '未找到' }); return; }
  const bytes = await readFile(path.join(ROOT, 'web', asset[0]));
  res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
}

export function createVoiceLabServer() {
  return createServer(async (req, res) => {
    const started = performance.now();
    try {
      if (!['127.0.0.1', 'localhost'].includes((req.headers.host || '').split(':')[0])) {
        json(res, 403, { error: '仅允许本机访问' }); return;
      }
      if (req.method === 'POST' && req.headers.origin && ![`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(req.headers.origin)) {
        json(res, 403, { error: '跨站请求被拒绝' }); return;
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/health') {
        json(res, 200, {
          fish: Boolean(process.env.FISH_API_KEY?.trim()),
          asr: existsSync(path.join(MODEL_ASR, 'tokens.txt')),
          chat: true,
          voiceId: VOICE_ID,
        });
        return;
      }
      if (req.method === 'GET') { await serveStatic(url.pathname, res); return; }
      if (req.method !== 'POST') { json(res, 405, { error: '方法不支持' }); return; }
      if (url.pathname === '/api/asr') {
        const body = await bodyJson(req, 11_000_000);
        if (typeof body.audioBase64 !== 'string' || body.audioBase64.length > 10_700_000) throw new Error('录音格式错误或太长');
        const result = await audioWorker.ask('asr', { audioBase64: body.audioBase64 }, 35_000);
        json(res, 200, { text: result.text, elapsedMs: Math.round(performance.now() - started) });
        return;
      }
      if (url.pathname === '/api/chat') {
        const body = await bodyJson(req);
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        const result = await codexChat(validateText(body.text, 1000), { signal: abort.signal });
        if (!res.destroyed) json(res, 200, result);
        return;
      }
      if (url.pathname === '/api/chat-stream') {
        const body = await bodyJson(req);
        const userText = validateText(body.text, 1000);
        const segmenter = new SentenceSegmenter();
        const abort = new AbortController();
        const streamStarted = performance.now();
        let finished = false;
        let firstAudioMs = null;
        let segmentCount = 0;
        let audioChain = Promise.resolve();
        let speakTimer;
        let speechStarted = false;
        const readySegments = [];
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.on('close', () => { if (!finished) abort.abort(); });
        const emit = event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); };
        const enqueue = segment => {
          const index = ++segmentCount;
          audioChain = audioChain.then(async () => {
            if (res.destroyed) return;
            try {
              const result = await fishTts(segment);
              if (firstAudioMs == null) firstAudioMs = Math.round(performance.now() - streamStarted);
              emit({ type: 'audio', index, text: segment, audioBase64: result.bytes.toString('base64'),
                ttsMs: result.elapsedMs, atMs: Math.round(performance.now() - streamStarted) });
            } catch (error) {
              emit({ type: 'audio_error', index, message: error.message || '语音合成失败' });
            }
          });
        };
        const startSpeech = () => {
          if (speechStarted || abort.signal.aborted) return;
          speechStarted = true;
          for (const segment of readySegments.splice(0)) enqueue(segment);
        };
        try {
          const result = await codexChat(userText, {
            signal: abort.signal,
            onDelta: delta => {
              emit({ type: 'delta', text: delta, atMs: Math.round(performance.now() - streamStarted) });
              for (const segment of segmenter.push(delta)) {
                if (speechStarted) enqueue(segment);
                else readySegments.push(segment);
              }
              // Short replies usually finish before a second Fish request would help.
              // Wait briefly; if the model is still generating, start the first sentence.
              if (readySegments.length && !speechStarted && !speakTimer) {
                speakTimer = setTimeout(startSpeech, 900);
              }
            },
          });
          clearTimeout(speakTimer);
          if (!speechStarted) {
            // One HTTP synthesis preserves prosody and avoids a separate queue wait per sentence.
            for (let offset = 0; offset < result.text.length; offset += 400) enqueue(result.text.slice(offset, offset + 400));
          } else {
            for (const segment of readySegments) enqueue(segment);
            for (const segment of segmenter.finish()) enqueue(segment);
          }
          await audioChain;
          emit({ type: 'done', text: result.text, modelMs: result.elapsedMs,
            firstDeltaMs: result.firstDeltaMs, firstAudioMs, totalMs: Math.round(performance.now() - streamStarted),
            segments: segmentCount });
        } catch (error) {
          emit({ type: 'error', message: error.message || '流式对话失败' });
        } finally {
          clearTimeout(speakTimer);
          finished = true;
          res.end();
        }
        return;
      }
      if (url.pathname === '/api/tts') {
        const body = await bodyJson(req);
        const text = validateText(body.text);
        if (body.engine !== 'fish') throw new Error('仅支持 Fish 音色');
        const result = await fishTts(text, body.voiceId || VOICE_ID);
        res.writeHead(200, {
          'Content-Type': result.contentType,
          'Content-Length': result.bytes.length,
          'Cache-Control': 'no-store',
          'X-Engine-Time-Ms': String(result.elapsedMs),
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(result.bytes);
        return;
      }
      json(res, 404, { error: '未找到' });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      json(res, error.message?.includes('Fish 语音服务返回') ? 502 : 400, { error: error.message || '请求失败' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createVoiceLabServer().listen(PORT, HOST, () => {
    console.log(`Voice Lab ready at http://${HOST}:${PORT}/`);
  });
}

