const SHARE_URL = /https?:\/\/[^\s<>"']+/i;

export function sharedTextForComposer(value) {
  const text = String(value || '').trim();
  const match = text.match(SHARE_URL);
  return match ? match[0].replace(/[.,!?，。！？）)]*$/, '') : text;
}

export function appendSharedText(draft, shared) {
  const current = String(draft || '').trimEnd();
  const incoming = sharedTextForComposer(shared);
  if (!incoming || current.includes(incoming)) return current;
  return current ? `${current}\n${incoming}` : incoming;
}

export function sharedFileKind(item) {
  const name = String(item?.name || '');
  const mime = String(item?.mime || '').toLowerCase();
  if (item?.image === true || mime.startsWith('image/') || /\.(?:png|jpe?g|webp|gif|heic)$/i.test(name)) return 'image';
  if (/\.(?:pdf|docx|txt|md)$/i.test(name)) return 'file';
  return 'unsupported';
}
