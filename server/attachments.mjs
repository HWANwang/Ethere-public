import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const SUPPORTED_FILE_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.md']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 120_000;

const SUPPORTED_IMAGE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

export function createAttachmentStore({ dataRoot, maxImageBytes = 6 * 1024 * 1024 } = {}) {
  if (!dataRoot) throw new Error('缺少附件数据目录');

  return {
    async saveChatFile({ name, dataUrl } = {}) {
      const safeName = basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
      const extension = extname(safeName).toLowerCase();
      if (!safeName || !SUPPORTED_FILE_EXTENSIONS.has(extension)) throw httpError(415, '仅支持 PDF、Word（.docx）、TXT、MD 文件');
      const match = /^data:[^;,]*;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
      if (!match) throw httpError(400, '文件内容格式错误');
      const buffer = Buffer.from(match[1], 'base64');
      if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw httpError(413, '文件不能为空，且不能超过 8 MB');
      const extractedText = await extractFileText(buffer, extension);
      if (!extractedText.trim()) throw httpError(422, '没有提取到文字；扫描版 PDF 暂不支持');
      const id = randomUUID();
      const directory = join(dataRoot, 'attachments', 'chat-files');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${id}${extension}`), buffer, { flag: 'wx' });
      await writeFile(join(directory, `${id}.extracted.txt`), extractedText, { flag: 'wx' });
      await writeFile(join(directory, `${id}.json`), JSON.stringify({ id, name: safeName, extension, size: buffer.length }), { flag: 'wx' });
      return { id, type: 'file', name: safeName, size: buffer.length };
    },
    async resolveChatFiles(ids = []) {
      if (!Array.isArray(ids) || ids.length > 3) throw httpError(400, '单条消息最多附带 3 个文件');
      const directory = join(dataRoot, 'attachments', 'chat-files');
      return Promise.all(ids.map(async (id) => {
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw httpError(400, '文件引用无效');
        let metadata;
        try { metadata = JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')); }
        catch { throw httpError(404, '文件未找到，请重新选择'); }
        if (metadata.id !== id || !SUPPORTED_FILE_EXTENSIONS.has(metadata.extension)) throw httpError(400, '文件信息无效');
        return { type: 'file', id, name: metadata.name, size: metadata.size,
          absolutePath: join(directory, `${id}${metadata.extension}`),
          extractedPath: join(directory, `${id}.extracted.txt`),
          extractedText: await readFile(join(directory, `${id}.extracted.txt`), 'utf8') };
      }));
    },
    async saveChatImages(images = []) {
      if (!Array.isArray(images)) throw httpError(400, '图片格式错误');
      if (images.length > 4) throw httpError(400, '单条消息最多发送 4 张图片');

      const saved = [];
      for (const image of images) {
        const { mimeType, buffer } = decodeImageDataUrl(image?.dataUrl, maxImageBytes);
        const now = new Date();
        const directory = join(
          dataRoot,
          'attachments',
          'chat',
          String(now.getFullYear()),
          String(now.getMonth() + 1).padStart(2, '0'),
        );
        await mkdir(directory, { recursive: true });
        const absolutePath = join(directory, `${randomUUID()}${SUPPORTED_IMAGE_TYPES.get(mimeType)}`);
        await writeFile(absolutePath, buffer, { flag: 'wx' });
        saved.push({ type: 'image', mimeType, absolutePath, size: buffer.length });
      }
      return saved;
    },
  };
}

async function extractFileText(buffer, extension) {
  if (extension === '.txt' || extension === '.md') {
    if (buffer.includes(0)) throw httpError(415, 'TXT 和 MD 需要是 UTF-8 文本');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '').slice(0, MAX_EXTRACTED_CHARS); }
    catch { throw httpError(415, 'TXT 和 MD 需要是 UTF-8 文本'); }
  }
  if (extension === '.docx') {
    if (buffer.subarray(0, 2).toString() !== 'PK') throw httpError(415, 'Word 文件格式不正确，请使用 .docx');
    try {
      const mammoth = await import('mammoth');
      return (await mammoth.extractRawText({ buffer })).value.slice(0, MAX_EXTRACTED_CHARS);
    } catch { throw httpError(422, '无法读取 Word 正文，请检查文件是否损坏'); }
  }
  if (buffer.subarray(0, 5).toString() !== '%PDF-') throw httpError(415, 'PDF 文件格式不正确');
  let pdf;
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true }).promise;
    const pages = [];
    for (let number = 1; number <= Math.min(pdf.numPages, 250); number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str || '').join(' '));
      if (pages.join('\n').length >= MAX_EXTRACTED_CHARS) break;
    }
    return pages.join('\n\n').slice(0, MAX_EXTRACTED_CHARS);
  } catch { throw httpError(422, '无法读取 PDF 正文；扫描版 PDF 暂不支持'); }
  finally { await pdf?.destroy?.(); }
}

export function decodeImageDataUrl(dataUrl, maxImageBytes = 6 * 1024 * 1024) {
  if (typeof dataUrl !== 'string') throw httpError(400, '图片内容缺失');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match || !SUPPORTED_IMAGE_TYPES.has(match[1])) throw httpError(415, '仅支持 JPEG、PNG 或 WebP 图片');

  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw httpError(400, '图片内容为空');
  if (buffer.length > maxImageBytes) throw httpError(413, '压缩后的图片不能超过 6 MB');
  return { mimeType: match[1], buffer };
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
