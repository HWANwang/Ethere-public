import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createAttachmentStore, decodeImageDataUrl } from '../server/attachments.mjs';

const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('chat images are decoded and stored under the private data directory with an opaque name', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-attachments-test-'));
  const store = createAttachmentStore({ dataRoot });
  const [saved] = await store.saveChatImages([{ name: 'personal-name.png', dataUrl: ONE_PIXEL_PNG }]);

  assert.equal(saved.type, 'image');
  assert.equal(saved.mimeType, 'image/png');
  assert.match(saved.absolutePath, /attachments[\\/]chat/);
  assert.doesNotMatch(basename(saved.absolutePath), /personal-name/);
  assert.ok((await readFile(saved.absolutePath)).length > 0);
});

test('image decoder rejects unsupported and oversized content', () => {
  assert.throws(() => decodeImageDataUrl('data:image/svg+xml;base64,PHN2Zy8+'), /仅支持/);
  assert.throws(() => decodeImageDataUrl(ONE_PIXEL_PNG, 2), /6 MB/);
});

test('chat text files are uploaded once and resolved by opaque file id', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-file-test-'));
  const store = createAttachmentStore({ dataRoot });
  const dataUrl = `data:text/plain;base64,${Buffer.from('一段待阅读的文字').toString('base64')}`;
  const uploaded = await store.saveChatFile({ name: 'notes.md', dataUrl });
  assert.equal(uploaded.type, 'file');
  assert.equal(uploaded.name, 'notes.md');
  const [resolved] = await store.resolveChatFiles([uploaded.id]);
  assert.equal(resolved.extractedText, '一段待阅读的文字');
  assert.match(resolved.absolutePath, /chat-files/);
  await assert.rejects(store.resolveChatFiles(['../outside']), /文件引用无效/);
});

test('TXT upload keeps the original and extracted copy at distinct paths', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-txt-test-'));
  const store = createAttachmentStore({ dataRoot });
  const uploaded = await store.saveChatFile({ name: 'notes.txt', dataUrl: `data:text/plain;base64,${Buffer.from('今天的笔记').toString('base64')}` });
  const [resolved] = await store.resolveChatFiles([uploaded.id]);
  assert.notEqual(resolved.absolutePath, resolved.extractedPath);
  assert.equal((await readFile(resolved.absolutePath)).toString(), '今天的笔记');
  assert.equal(resolved.extractedText, '今天的笔记');
});

test('file uploads reject unsupported formats and unreadable PDFs', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-file-reject-test-'));
  const store = createAttachmentStore({ dataRoot });
  await assert.rejects(store.saveChatFile({ name: 'script.exe', dataUrl: 'data:application/octet-stream;base64,YQ==' }), /仅支持/);
  await assert.rejects(store.saveChatFile({ name: 'scan.pdf', dataUrl: 'data:application/pdf;base64,YQ==' }), /PDF 文件格式不正确/);
});

test('PDF upload extracts selectable text for the model', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ethere-pdf-test-'));
  const store = createAttachmentStore({ dataRoot });
  const content = 'BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const uploaded = await store.saveChatFile({ name: 'sample.pdf', dataUrl: `data:application/pdf;base64,${Buffer.from(pdf).toString('base64')}` });
  const [resolved] = await store.resolveChatFiles([uploaded.id]);
  assert.match(resolved.extractedText, /Hello PDF/);
});
