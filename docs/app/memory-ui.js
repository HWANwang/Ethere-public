import { markdownMarkup } from './markdown.js';

export function createMemoryUi({ api, root = document, showToast, enterSubpage, leaveSubpage }) {
  const $ = (selector) => root.querySelector(selector);
  const state = { status: 'active', query: '', memories: [], selected: null, editing: null, searchTimer: 0, loadId: 0 };
  $('[data-open-memory]')?.addEventListener('click', open);
  $('[data-close-memory]')?.addEventListener('click', close);
  $('[data-close-memory-detail]')?.addEventListener('click', closeDetail);
  $('[data-edit-memory]')?.addEventListener('click', () => openEditor(state.selected));
  $('[data-close-memory-editor]')?.addEventListener('click', closeEditor);
  $('[data-memory-form]')?.addEventListener('submit', save);
  $('[data-memory-archive]')?.addEventListener('click', primaryAction);
  $('[data-memory-maintenance-toggle]')?.addEventListener('click', () => { const detail = $('[data-memory-maintenance-detail]'); detail.hidden = !detail.hidden; $('[data-memory-maintenance-toggle]').setAttribute('aria-expanded', String(!detail.hidden)); });
  $('[data-memory-maintenance-trigger]')?.addEventListener('click', async () => { try { await api.memoryV2MaintenanceTrigger(); showToast('已安排记忆整理'); await loadMaintenance(); } catch (error) { showToast(error.message); } });
  $('[data-memory-maintenance-enabled]')?.addEventListener('click', async () => { try { await api.memoryV2MaintenanceEnabled(state.maintenance?.enabled !== true); await loadMaintenance(); } catch (error) { showToast(error.message); } });
  $('[data-memory-search]')?.addEventListener('input', (event) => { state.query = event.target.value; clearTimeout(state.searchTimer); state.searchTimer = setTimeout(load, 220); });
  root.querySelectorAll('[data-memory-status]').forEach((button) => button.addEventListener('click', () => { state.status = button.dataset.memoryStatus; root.querySelectorAll('[data-memory-status]').forEach((item) => item.classList.toggle('is-active', item === button)); void load(); }));
  $('[data-memory-list]')?.addEventListener('click', (event) => { const button = event.target.closest('[data-memory-id]'); if (!button) return; const memory = state.memories.find((item) => item.id === button.dataset.memoryId); if (memory) void openDetail(memory); });

  async function open() { $('[data-memory-manager]').hidden = false; enterSubpage(); await Promise.all([load(), loadMaintenance()]); }
  function close() { $('[data-memory-manager]').hidden = true; leaveSubpage(); }
  async function loadMaintenance() {
    try {
      const status = await api.memoryV2Maintenance(); state.maintenance = status;
      $('[data-memory-maintenance-summary]').textContent = status.running ? '记忆正在整理' : status.enabled ? '记忆整理已开启' : '记忆整理已暂停';
      $('[data-memory-maintenance-detail-text]').textContent = `${status.pendingSources || 0} 条来源待整理 · ${status.pendingIssues || 0} 条待核对 · ${status.dueWatch || 0} 条待复查${status.lastError ? ` · 上次失败：${status.lastError}` : ''}`;
      $('[data-memory-maintenance-enabled]').textContent = status.enabled ? '暂停整理' : '恢复整理';
    } catch { $('[data-memory-maintenance-summary]').textContent = '记忆整理暂不可用'; $('[data-memory-maintenance-detail-text]').textContent = '电脑端记忆服务未连接'; }
  }
  async function load() {
    const container = $('[data-memory-list]'); const loadId = ++state.loadId; container.innerHTML = '<p class="empty-state">正在读取…</p>';
    try {
      const [core, stats, dynamic] = await Promise.all([api.memories({ status: 'active', query: state.status === 'active' ? state.query : '' }), api.memoryV2Stats().catch(() => null), state.status === 'active' ? null : api.memoryV2List({ state: state.status, status: 'available', limit: 500 })]);
      if (loadId !== state.loadId) return;
      $('[data-memory-active-count]').textContent = `${core.activeCount}/${core.limit}`;
      $('[data-memory-count]').textContent = stats ? `${core.activeCount} 核心 · ${stats.remember} Remember · ${stats.watch} Watch` : `${core.activeCount} 核心`;
      $('[data-memory-remember-count]').textContent = stats?.remember ?? '';
      $('[data-memory-watch-count]').textContent = stats?.watch ?? '';
      state.memories = state.status === 'active' ? (core.memories || []).map((row) => ({ ...row, sourceSystem: 'core' })) : (dynamic?.memories || []).map((row) => ({ ...row, sourceSystem: 'v2' }));
      const query = state.query.trim().toLocaleLowerCase('zh-CN'); if (query) state.memories = state.memories.filter((row) => `${row.title || ''} ${row.contentMarkdown || row.content || ''}`.toLocaleLowerCase('zh-CN').includes(query));
      renderList();
    } catch (error) { if (loadId === state.loadId) { container.innerHTML = '<p class="empty-state">记忆服务暂时不可用</p>'; showToast(error.message); } }
  }
  function renderList() {
    const container = $('[data-memory-list]');
    container.innerHTML = state.memories.length ? state.memories.map((memory) => {
      const isV2 = memory.sourceSystem === 'v2';
      const title = isV2 ? '' : `<strong>${escapeHtml(memory.title || titleFor(memory))}</strong>`;
      const metadata = isV2 ? (memory.memory_type === 'fact' ? '事实' : '判断') : formatDate(memory.updatedAt || memory.updated_at);
      return `<button type="button" class="memory-card${isV2 ? ' memory-card--v2' : ''}" data-memory-id="${escapeHtml(memory.id)}">${title}<div>${markdownMarkup(excerpt(memory.contentMarkdown || memory.content))}</div><span>${metadata}</span></button>`;
    }).join('') : `<p class="empty-state">${state.query ? '没有匹配的记忆' : '这里还没有记忆'}</p>`;
  }
  async function openDetail(memory) {
    state.selected = memory; $('[data-memory-detail-title]').textContent = memory.sourceSystem === 'v2' ? '记忆详情' : (memory.title || titleFor(memory)); $('[data-memory-detail-content]').innerHTML = markdownMarkup(memory.contentMarkdown || memory.content); const action = $('[data-memory-archive]'); action.textContent = memory.sourceSystem === 'v2' ? '忘记这条记忆' : '归档核心记忆'; action.classList.add('danger'); $('[data-memory-detail]').hidden = false; enterSubpage();
    if (memory.sourceSystem !== 'v2') return;
    try {
      const [detail, evidence, related] = await Promise.all([api.memoryV2(memory.id), api.memoryV2Evidence(memory.id, true), api.memoryV2Related(memory.id)]); if (state.selected?.id !== memory.id) return; const rows = evidence.evidence || []; const relations = related.relations || [];
      let extra = `<div class="memory-sources"><strong>状态</strong><p>${detail.memory.memory_type === 'fact' ? '发生过的事实' : '形成的判断'} · ${detail.memory.state === 'watch' ? '继续观察' : '长期记住'}${detail.memory.pending_issue_types?.length ? ' · 待核对' : ''} · 版本 ${detail.memory.version}</p>`;
      if (rows.length) extra += `<strong>证据</strong>${rows.map((row) => `<details><summary>${sourceLabel(row.source_type)} · ${formatDate(row.source_time)}</summary><p>${escapeHtml(row.full_content || row.excerpt || '')}</p></details>`).join('')}`;
      if (relations.length) extra += `<strong>相关记忆</strong>${relations.map((row) => `<p>${escapeHtml(relationLabel(row.relation_type))}：${escapeHtml(excerpt(row.memory?.content, 120))}</p>`).join('')}`;
      $('[data-memory-detail-content]').insertAdjacentHTML('beforeend', `${extra}</div>`);
    } catch { showToast('证据或关系暂时无法读取'); }
  }
  function closeDetail() { $('[data-memory-detail]').hidden = true; state.selected = null; }
  function openEditor(memory) { if (!memory) return; state.editing = memory; const isV2 = memory.sourceSystem === 'v2'; $('[data-memory-editor-heading]').textContent = isV2 ? '更正记忆' : '编辑核心记忆'; $('[data-memory-title]').closest('label').hidden = isV2; $('[data-memory-title]').value = isV2 ? '' : (memory.title || titleFor(memory)); $('[data-memory-content]').value = memory.contentMarkdown || memory.content || ''; $('[data-memory-editor]').hidden = false; enterSubpage(); }
  function closeEditor() { $('[data-memory-editor]').hidden = true; $('[data-memory-title]').closest('label').hidden = false; state.editing = null; }
  async function save(event) { event.preventDefault(); if (!state.editing) return; const title = $('[data-memory-title]').value.trim(); const content = $('[data-memory-content]').value.trim(); if (!content) return showToast('请输入记忆内容'); const button = event.currentTarget.querySelector('[type="submit"]'); button.disabled = true; try { if (state.editing.sourceSystem === 'v2') await api.updateMemoryV2(state.editing.id, { content, reason: '用户在手机记忆页面手动更正' }); else await api.updateMemory(state.editing.id, { title, contentMarkdown: content, baseRevision: state.editing.revision }); closeEditor(); closeDetail(); await load(); showToast('已保存'); } catch (error) { showToast(error.message); } finally { button.disabled = false; } }
  async function primaryAction() { if (!state.selected) return; try { if (state.selected.sourceSystem === 'v2') { if (!window.confirm('忘记后不会再召回这条记忆，确定吗？')) return; await api.reportMemoryV2Issue({ memory_id: state.selected.id, issue_type: 'forget_requested', note: '用户在手机记忆页面明确要求遗忘' }); } else await api.archiveMemory(state.selected.id, { baseRevision: state.selected.revision }); closeDetail(); await load(); showToast('已处理'); } catch (error) { showToast(error.message); } }
  return { open, load };
}
function titleFor(memory) { const text = String(memory.content || '').replace(/\s+/g, ' ').trim(); return text.length > 32 ? `${text.slice(0, 32)}…` : text || '未命名记忆'; }
function excerpt(value, limit = 180) { const text = String(value || '').replace(/[#>*_`~\[\]]/g, '').trim(); return text.length > limit ? `${text.slice(0, limit)}…` : text; }
function sourceLabel(value) { return value === 'chat' ? '聊天' : value === 'timeline' ? '时间线' : '空间'; }
function relationLabel(value) { return value === 'supersedes' ? '取代' : value === 'contradicts' ? '冲突' : '相关'; }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(date); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
