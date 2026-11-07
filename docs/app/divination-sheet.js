import { castCoinLine, castPlumNumbers, formatCoinReading, formatPlumReading } from './divination.js';

const STORAGE_KEY = 'ethere.divination-draft.v1';
const LINE_NAMES = { 6: '老阴', 7: '少阳', 8: '少阴', 9: '老阳' };

function readDraft(storage) {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY));
    const lines = Array.isArray(value?.lines) ? value.lines.slice(0, 6).filter((line) =>
      LINE_NAMES[line?.value] && Array.isArray(line.coins) && line.coins.length === 3
        && line.coins.every((coin) => coin === '字' || coin === '背')
        && line.coins.reduce((sum, coin) => sum + (coin === '字' ? 3 : 2), 0) === line.value) : [];
    const plum = Number.isSafeInteger(value?.plum?.first) && Number.isSafeInteger(value?.plum?.second)
      && value.plum.first >= 1 && value.plum.first <= 999 && value.plum.second >= 1 && value.plum.second <= 999
      ? castPlumNumbersFromSaved(value.plum.first, value.plum.second) : null;
    return {
      mode: value?.mode === 'plum' ? 'plum' : 'coins', lines, plum,
      coinAt: Number.isFinite(value?.coinAt) ? value.coinAt : null,
      plumAt: Number.isFinite(value?.plumAt) ? value.plumAt : null,
      coinSent: value?.coinSent === true, plumSent: value?.plumSent === true,
    };
  } catch { return { mode: 'coins', lines: [], plum: null, coinAt: null, plumAt: null, coinSent: false, plumSent: false }; }
}

function castPlumNumbersFromSaved(first, second) {
  const trigrams = ['乾', '兑', '离', '震', '巽', '坎', '艮', '坤'];
  const upperNumber = first % 8 || 8;
  const lowerNumber = second % 8 || 8;
  return { first, second, upperNumber, lowerNumber, upper: trigrams[upperNumber - 1],
    lower: trigrams[lowerNumber - 1], movingLine: (first + second) % 6 || 6 };
}

export function createDivinationSheet({ root, storage, send, getAssistantName = () => 'Ethere' }) {
  const sheet = root.querySelector('[data-divination-sheet]');
  const coinView = sheet.querySelector('[data-divination-coins]');
  const plumView = sheet.querySelector('[data-divination-plum]');
  const result = sheet.querySelector('[data-divination-results]');
  const coinFaces = [...sheet.querySelectorAll('[data-divination-coin]')];
  const progress = sheet.querySelector('[data-divination-progress]');
  const castButton = sheet.querySelector('[data-divination-cast]');
  const drawButton = sheet.querySelector('[data-divination-draw]');
  const sendButton = sheet.querySelector('[data-divination-send]');
  const resetButton = sheet.querySelector('[data-divination-reset]');
  const grip = sheet.querySelector('[data-divination-grip]');
  const draft = readDraft(storage);
  let closeTimer = 0;
  let resetTimer = 0;
  let rolling = false;
  let dragStart = null;
  let skipGripClick = false;

  function save() { try { storage.setItem(STORAGE_KEY, JSON.stringify(draft)); } catch { /* The cast still works without local storage. */ } }

  function render() {
    const isCoin = draft.mode === 'coins';
    coinView.hidden = !isCoin;
    plumView.hidden = isCoin;
    sheet.querySelectorAll('[data-divination-mode]').forEach((button) => {
      const selected = button.dataset.divinationMode === draft.mode;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    const latest = draft.lines.at(-1);
    coinFaces.forEach((node, index) => {
      node.textContent = latest?.coins[index] || '·';
      node.classList.toggle('is-face', Boolean(latest));
    });
    progress.textContent = draft.lines.length === 6 ? '六次已完成 · 第 1 摇在最下方' : `第 ${draft.lines.length + 1} / 6 摇 · 从下往上`;
    castButton.disabled = draft.lines.length === 6 || rolling;
    castButton.textContent = draft.lines.length === 6 ? '六次已完成' : '摇一次';
    const plum = draft.plum;
    sheet.querySelector('[data-divination-first]').textContent = plum?.first ?? '—';
    sheet.querySelector('[data-divination-second]').textContent = plum?.second ?? '—';
    const plumSummary = sheet.querySelector('[data-divination-plum-summary]');
    plumSummary.textContent = plum
      ? `上卦 ${plum.upper} · 下卦 ${plum.lower} · 第 ${plum.movingLine} 爻动` : '点击后随机报两个数';
    drawButton.textContent = plum ? '已取得两个数' : '随机报数';
    drawButton.disabled = Boolean(plum);
    result.hidden = !isCoin || !draft.lines.length;
    result.innerHTML = draft.lines.map((line, index) =>
      `<li><span>第 ${index + 1} 摇</span><small>${line.coins.join(' · ')}</small><strong>${line.value}</strong><em>${LINE_NAMES[line.value]}${line.value === 6 || line.value === 9 ? ' · 动' : ''}</em></li>`).join('');
    const ready = isCoin ? draft.lines.length === 6 : Boolean(plum);
    const sent = isCoin ? draft.coinSent : draft.plumSent;
    sendButton.disabled = !ready || sent;
    sendButton.textContent = `${sent ? '已发给' : '发给'} ${getAssistantName()}`;
    resetButton.hidden = isCoin ? !draft.lines.length : !plum;
  }

  function open() {
    clearTimeout(closeTimer);
    sheet.hidden = false;
    render();
    requestAnimationFrame(() => sheet.classList.add('is-open'));
  }

  function close() {
    sheet.classList.remove('is-open');
    sheet.classList.remove('is-expanded');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!sheet.classList.contains('is-open')) sheet.hidden = true; }, 180);
  }

  function resetCurrent() {
    if (draft.mode === 'coins') { draft.lines = []; draft.coinAt = null; draft.coinSent = false; }
    else { draft.plum = null; draft.plumAt = null; draft.plumSent = false; }
    resetButton.textContent = '重新开始';
    save();
    render();
  }

  sheet.addEventListener('click', (event) => {
    const mode = event.target.closest('[data-divination-mode]');
    if (mode) { draft.mode = mode.dataset.divinationMode; save(); render(); return; }
    if (event.target.closest('[data-divination-close]')) { close(); return; }
    if (event.target.closest('[data-divination-expand]')) {
      if (skipGripClick) { skipGripClick = false; return; }
      sheet.classList.toggle('is-expanded'); return;
    }
    if (event.target.closest('[data-divination-cast]') && draft.lines.length < 6 && !rolling) {
      rolling = true;
      if (!draft.coinAt) draft.coinAt = Date.now();
      draft.lines.push(castCoinLine());
      save();
      coinFaces.forEach((node) => node.classList.add('is-rolling'));
      setTimeout(() => { rolling = false; coinFaces.forEach((node) => node.classList.remove('is-rolling')); render(); }, 190);
      return;
    }
    if (event.target.closest('[data-divination-draw]') && !draft.plum) {
      draft.plumAt = Date.now();
      draft.plum = castPlumNumbers();
      save(); render(); return;
    }
    if (event.target.closest('[data-divination-reset]')) {
      if (resetButton.dataset.confirm === 'true') {
        clearTimeout(resetTimer); resetButton.dataset.confirm = ''; resetCurrent();
      } else {
        resetButton.dataset.confirm = 'true'; resetButton.textContent = '确认重来';
        resetTimer = setTimeout(() => { resetButton.dataset.confirm = ''; resetButton.textContent = '重新开始'; }, 3500);
      }
      return;
    }
    if (event.target.closest('[data-divination-send]') && !sendButton.disabled) {
      const message = draft.mode === 'coins'
        ? formatCoinReading(draft.lines) : formatPlumReading(draft.plum);
      send(message);
      if (draft.mode === 'coins') draft.coinSent = true;
      else draft.plumSent = true;
      save(); render(); close();
    }
  });

  grip.addEventListener('pointerdown', (event) => { dragStart = { y: event.clientY, id: event.pointerId }; });
  grip.addEventListener('pointerup', (event) => {
    if (!dragStart || dragStart.id !== event.pointerId) return;
    const distance = event.clientY - dragStart.y;
    dragStart = null;
    if (distance < -28) { sheet.classList.add('is-expanded'); skipGripClick = true; }
    else if (distance > 28) { sheet.classList.remove('is-expanded'); skipGripClick = true; }
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !sheet.hidden) { event.preventDefault(); close(); } });

  render();
  return { open, close, refresh: render, isOpen: () => !sheet.hidden && sheet.classList.contains('is-open') };
}
