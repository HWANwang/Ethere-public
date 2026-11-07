import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const MAINTENANCE_POLICY = Object.freeze({ sourceSyncSeconds: 60, userMessages: 40,
  maxSources: 120, maxInputCharacters: 120_000, elapsedHours: 6, issueDelayMinutes: 10,
  dailyHour: 3, dailyMinute: 30, contextBudgetTokens: 120_000, checkpointRatio: .65, compactRatio: .75 });

const SCREEN_RULES = `你是 Ethere 的独立记忆筛选窗口，只看提供的原始来源，不调用工具，不修改文件。
输出严格 JSON：{"remember":[],"watch":[],"discard_summary":""}。每个候选含 id、statement、evidence_refs（来源 ref 数组）、reason。
Remember 是跨对话稳定且确有未来相处价值的事实/判断，包括用户明确表达的长期相处或操作偏好；Watch 是首次出现但值得以后验证的模式。忽略单次工具调用日志、流水账、临时任务进度；推测须保留不确定性。
一批分三遍：第一遍保守抽取；第二遍检查分散证据和遗漏；第三遍按身体、学习、工作、关系、兴趣、互动边界等生活域审计。每遍只返回该遍完整 JSON。证据 ref 必须来自输入。`;
const CURATE_RULES = `你是 Ethere 的独立记忆整理窗口，只根据候选、已有节点、问题单和来源证据输出严格 JSON，不调用工具，不修改文件。
输出 {"memories":[],"links":[],"resolved_issue_ids":[],"discarded_candidates":[]}。每条 memory 含 temp_id、memory_id（更新旧节点才填）、memory_type（fact/judgment）、memory_state（watch/remember）、record_status（available/superseded/forgotten）、content、valid_from、valid_to、evidence_refs、merge_reason。
原子化写入；同主题优先修订旧 ID 并追加新来源；证据只许引用输入给出的 source_type/source_id；不能编造原话、证据或关系。待核对问题优先核查 issue_context_sources，即使筛选窗口未产出新候选，也可据此修订已有节点并追加来源；只有证据足以修订或驳回问题时，才在同一输出中列出 resolved_issue_ids，否则保持待核对。`;

export class MemoryMaintenanceService {
  constructor({ store, recall, backend, dataRoot, sourceInstance, isMainBusy = async () => false,
    now = () => new Date(), policy = MAINTENANCE_POLICY }) {
    if (!sourceInstance) throw new Error('后台维护缺少生产来源身份');
    this.store = store; this.recall = recall; this.backend = backend; this.isMainBusy = isMainBusy; this.sourceInstance = sourceInstance;
    this.now = now; this.policy = policy; this.file = join(dataRoot, 'runtime', 'memory-maintenance.json');
    this.state = null; this.running = false;
  }

  async initialize() {
    try { this.state = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const baselineAt = this.store.db.prepare('SELECT MAX(created_at) value FROM memory_changes').get()?.value || '1970-01-01T00:00:00.000Z';
      this.state = { version: 1, enabled: true, baselineAt, lastSuccessAt: baselineAt,
        threads: { screen: '', curate: '' }, usage: { screen: 0, curate: 0 }, checkpoint: {},
        batch: null, failureCount: 0, nextAttemptAt: '', lastError: '', lastDailyDate: '', lastIssueAttempt: '' };
      await this.#save();
    }
    return this.status();
  }

  status() { return { enabled: this.state?.enabled === true, running: this.running,
    batch: this.state?.batch ? { id: this.state.batch.id, phase: this.state.batch.phase, reason: this.state.batch.reason } : null,
    lastSuccessAt: this.state?.lastSuccessAt || '', lastError: this.state?.lastError || '',
    nextAttemptAt: this.state?.nextAttemptAt || '', threadIds: { ...this.state?.threads },
    usageEstimate: { ...this.state?.usage },
    pendingSources: this.store.db.prepare(`SELECT COUNT(*) n FROM source_records s LEFT JOIN maintenance_processed_sources p ON p.source_id=s.id
      WHERE s.source_instance=? AND s.is_deleted=0 AND julianday(COALESCE(s.occurred_at,s.imported_at))>julianday(?)
      AND (p.source_id IS NULL OR p.content_hash<>s.content_hash)`).get(this.sourceInstance,this.state?.baselineAt||'1970-01-01')?.n||0,
    pendingIssues: this.store.listIssues('pending',100).length,
    dueWatch: this.#dueWatches().length,
    lastBatch: this.state?.checkpoint || null }; }

  async setEnabled(value) { await this.initializeIfNeeded(); this.state.enabled = value === true; await this.#save(); return this.status(); }
  async trigger() { await this.initializeIfNeeded(); this.state.force = true; this.state.nextAttemptAt = ''; await this.#save(); return this.tick(); }
  async initializeIfNeeded() { if (!this.state) await this.initialize(); }
  async close() { await this.backend.close?.(); }

  async tick() {
    await this.initializeIfNeeded();
    if (this.running || !this.state.enabled) return this.status();
    if (this.state.nextAttemptAt && this.now().toISOString() < this.state.nextAttemptAt) return this.status();
    if (await this.isMainBusy()) return this.status();
    this.running = true;
    try {
      if (!this.state.batch) {
        const sources = this.#pendingSources();
        const issues = this.store.listIssues('pending', 50);
        const dueWatches = this.#dueWatches();
        const reason = this.#dueReason(sources, issues, dueWatches);
        if (!reason) return this.status();
        const batchSources = issues.length && ['issue', 'manual', 'elapsed', 'daily'].includes(reason)
          ? this.#withIssueContext(sources, issues) : sources;
        this.state.batch = { id: `maintenance-${randomUUID()}`, reason, phase: 'screen-1',
          startedAt: this.now().toISOString(), sources: batchSources, issues, dueWatches,
          screenOutputs: [], screenOutput: null, curatorInput: null, curatorOutput: null };
        this.state.force = false;
        await this.#save();
      }
      await this.#runBatch();
      this.state.failureCount = 0; this.state.nextAttemptAt = ''; this.state.lastError = '';
    } catch (error) {
      this.state.failureCount = Math.min(8, (this.state.failureCount || 0) + 1);
      this.state.nextAttemptAt = new Date(this.now().getTime() + Math.min(6 * 60 * 60_000, 60_000 * 2 ** (this.state.failureCount - 1))).toISOString();
      this.state.lastError = String(error?.message || error).slice(0, 600);
      await this.#save('failed');
    } finally { this.running = false; }
    return this.status();
  }

  #pendingSources() {
    const rows = this.store.db.prepare(`SELECT s.* FROM source_records s LEFT JOIN maintenance_processed_sources p ON p.source_id=s.id
      WHERE s.source_instance=? AND s.is_deleted=0 AND (s.source_type<>'chat' OR s.role IN ('user','assistant'))
      AND julianday(COALESCE(s.occurred_at,s.imported_at))>julianday(?)
      AND (p.source_id IS NULL OR p.content_hash<>s.content_hash)
      ORDER BY julianday(COALESCE(s.occurred_at,s.imported_at)),s.id LIMIT ?`).all(this.sourceInstance,this.state.baselineAt,this.policy.maxSources);
    const chosen = []; let characters = 0;
    for (const row of rows) {
      const content = String(row.content || '');
      if (chosen.length && characters + content.length > this.policy.maxInputCharacters) break;
      chosen.push({ id: row.id, ref: row.id, source_type: row.source_type, source_id: row.external_id,
        content_hash: row.content_hash, role: row.role, author: row.author,
        content: content.slice(0, this.policy.maxInputCharacters), occurred_at: row.occurred_at });
      characters += content.length;
    }
    return chosen;
  }

  #withIssueContext(pending, issues) {
    const merged = new Map(pending.map((row) => [row.id, row]));
    let remaining = Math.max(0, this.policy.maxInputCharacters - pending.reduce((sum, row) => sum + row.content.length, 0));
    for (const issue of issues.slice(0, 5)) {
      if (!['incorrect', 'outdated', 'mixed'].includes(issue.issue_type)) continue;
      const lower = new Date(Date.parse(issue.created_at) - 60 * 60_000).toISOString();
      const upper = new Date(Math.min(this.now().getTime(), Date.parse(issue.created_at) + 3 * 60 * 60_000)).toISOString();
      const nearby = this.store.db.prepare(`SELECT * FROM source_records WHERE source_instance=? AND is_deleted=0
        AND source_type='chat' AND role IN ('user','assistant') AND julianday(occurred_at)>=julianday(?)
        AND julianday(occurred_at)<=julianday(?) ORDER BY ABS(julianday(occurred_at)-julianday(?)) LIMIT 18`)
        .all(this.sourceInstance, lower, upper, issue.created_at);
      const recent = this.store.db.prepare(`SELECT * FROM source_records WHERE source_instance=? AND is_deleted=0
        AND source_type='chat' AND role IN ('user','assistant') AND julianday(occurred_at)>=julianday(?)
        AND julianday(occurred_at)<=julianday(?) ORDER BY julianday(occurred_at) DESC LIMIT 18`)
        .all(this.sourceInstance, lower, upper);
      const anchored = [...new Map([...nearby, ...recent].map((row) => [row.id, row])).values()]
        .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
      for (const row of anchored) {
        if (merged.has(row.id)) continue;
        const content = String(row.content || '').slice(0, 1800);
        if (content.length > remaining || merged.size >= this.policy.maxSources) continue;
        merged.set(row.id, { id: row.id, ref: row.id, source_type: row.source_type,
          source_id: row.external_id, content_hash: row.content_hash, role: row.role,
          author: row.author, content, occurred_at: row.occurred_at });
        remaining -= content.length;
      }
    }
    return [...merged.values()].sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  }

  #dueWatches() {
    return this.store.db.prepare("SELECT * FROM memories WHERE state='watch' AND record_status='available' AND next_review_at IS NOT NULL AND next_review_at<=? ORDER BY next_review_at LIMIT 20")
      .all(this.now().toISOString()).map((row) => this.store.hydrateMemory(row));
  }

  #dueReason(sources, issues, dueWatches) {
    const current = this.now();
    const clock = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
      .formatToParts(current).map((part) => [part.type, part.value]));
    const hour = Number(clock.hour); const minute = Number(clock.minute);
    const localDate = current.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const eligibleIssues = issues.filter((issue) => ['incorrect', 'outdated', 'mixed'].includes(issue.issue_type));
    const issueKey = eligibleIssues.map((issue) => issue.id).sort().join('|');
    if (issueKey && current.getTime() - Date.parse(eligibleIssues[0].created_at) >= this.policy.issueDelayMinutes * 60_000 &&
        (this.state.lastIssueAttempt !== issueKey || current.getTime() - Date.parse(this.state.lastIssueAttemptAt || 0) >= 6 * 60 * 60_000)) return 'issue';
    if (dueWatches.length && current.getTime() - Date.parse(this.state.lastWatchAttemptAt || 0) >= 6 * 60 * 60_000) return 'watch-review';
    if (!sources.length) return '';
    if (this.state.force) return 'manual';
    if (sources.filter((row) => row.source_type === 'chat' && row.role === 'user').length >= this.policy.userMessages) return 'user-count';
    if (current.getTime() - Date.parse(this.state.lastSuccessAt) >= this.policy.elapsedHours * 60 * 60_000) return 'elapsed';
    if ((hour > this.policy.dailyHour || (hour === this.policy.dailyHour && minute >= this.policy.dailyMinute)) &&
        this.state.lastDailyDate !== localDate) return 'daily';
    return '';
  }

  async #runBatch() {
    const batch = this.state.batch;
    if (!batch.sources.length && !batch.screenOutput) {
      batch.screenOutput = { remember: [], watch: [], discard_summary: '本批仅处理问题单或到期 Watch' };
      batch.screenOutputs = [batch.screenOutput, batch.screenOutput, batch.screenOutput];
      await this.#save();
    }
    for (let pass = batch.screenOutputs.length + 1; pass <= 3; pass++) {
      batch.phase = `screen-${pass}`; await this.#save();
      const prior = batch.screenOutputs.at(-1) || null;
      const prompt = JSON.stringify({ pass, source_records: batch.sources, previous_pass: prior,
        instruction: pass === 1 ? '保守抽取' : pass === 2 ? '检查分散证据与遗漏，保留此前有效候选' : '按生活域做最后覆盖审计，返回完整候选' });
      let output = await this.#runRole('screen', SCREEN_RULES, prompt);
      try { this.#validateScreen(output, batch.sources); }
      catch (error) {
        output = await this.#runRole('screen', SCREEN_RULES, JSON.stringify({
          correction: '上次输出引用了不属于本批的来源。只用本批 source_records 重新输出完整 JSON，不沿用旧线程中的来源 ID。',
          validation_error: error.message, valid_refs: batch.sources.map((row) => row.ref),
          source_records: batch.sources,
        }));
        try { this.#validateScreen(output, batch.sources); }
        catch {
          // A stale candidate must not hold the whole batch hostage. Drop it,
          // never remap its evidence to a different source.
          output = this.#dropInvalidScreenCandidates(output, batch.sources);
          this.#validateScreen(output, batch.sources);
        }
      }
      batch.screenOutputs.push(output); batch.screenOutput = output; batch.lastRawOutput = null; await this.#save();
    }
    if (!batch.curatorInput) {
      batch.phase = 'recall'; await this.#save();
      batch.curatorInput = await this.#curatorInput(batch); await this.#save();
    }
    if (!batch.curatorOutput) {
      batch.phase = 'curate'; await this.#save();
      let output = await this.#runRole('curate', CURATE_RULES, JSON.stringify(batch.curatorInput));
      try { this.#validateCurate(output, batch); }
      catch (error) {
        output = await this.#runRole('curate', CURATE_RULES, JSON.stringify({
          correction: '上次输出未通过来源或节点校验。请仅根据当前 curator_input 重写完整 JSON。',
          validation_error: error.message, curator_input: batch.curatorInput, rejected_output: output,
        }));
        this.#validateCurate(output, batch);
      }
      batch.curatorOutput = output; batch.lastRawOutput = null; await this.#save();
    }
    batch.phase = 'apply'; await this.#save();
    const output = batch.curatorOutput;
    this.store.applyCuratedOutput(output, { batchId: batch.id, resolvedIssueIds: output.resolved_issue_ids || [],
      processedSources: batch.sources.map(({ id, content_hash }) => ({ id, content_hash })),
      strictSources: true, sourceInstance: this.sourceInstance });
    this.state.lastSuccessAt = this.now().toISOString();
    if (batch.reason === 'daily') this.state.lastDailyDate = this.now().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    if (batch.issues.length) { this.state.lastIssueAttempt = batch.issues.filter((issue) => ['incorrect', 'outdated', 'mixed'].includes(issue.issue_type)).map((issue) => issue.id).sort().join('|'); this.state.lastIssueAttemptAt = this.now().toISOString(); }
    if (batch.dueWatches.length) this.state.lastWatchAttemptAt = this.now().toISOString();
    this.state.checkpoint = { batchId: batch.id, finishedAt: this.state.lastSuccessAt,
      screened: (batch.screenOutput.remember || []).length + (batch.screenOutput.watch || []).length,
      createdOrUpdated: output.memories.length };
    this.store.putMaintenanceBatch(batch, { status: 'completed', threadIds: this.state.threads,
      contextUsage: this.state.usage.screen + this.state.usage.curate, stateFile: this.file });
    this.state.batch = null; await this.#save();
    try { await this.#maybeCompact(); }
    catch (error) { this.state.checkpoint.compactionError = String(error?.message || error).slice(0, 300); await this.#save(); }
  }

  async #runRole(role, rules, prompt) {
    if (!this.state.threads[role]) {
      this.state.threads[role] = await this.backend.createThread(role, rules);
      await this.#save();
    }
    const projected = this.state.usage[role] + Math.ceil(Buffer.byteLength(prompt) / 3) + 4000;
    if (projected >= this.policy.contextBudgetTokens * this.policy.checkpointRatio) {
      this.state.checkpoint = { ...this.state.checkpoint, role, usageEstimate: projected, at: this.now().toISOString(),
        batchId: this.state.batch?.id || '' };
      await this.#save();
    }
    if (projected >= this.policy.contextBudgetTokens * this.policy.compactRatio) {
      await this.backend.compact(this.state.threads[role]);
      await this.backend.turn(this.state.threads[role], `重新加载固定规则与持久检查点。\n${rules}\n${JSON.stringify(this.state.checkpoint)}`, role);
      this.state.usage[role] = Math.ceil(Buffer.byteLength(JSON.stringify(this.state.checkpoint)) / 3);
      await this.#save();
    }
    const text = await this.backend.turn(this.state.threads[role], prompt, role);
    if (this.state.batch) this.state.batch.lastRawOutput = { role, text };
    this.state.usage[role] += Math.ceil((Buffer.byteLength(prompt) + Buffer.byteLength(text)) / 3);
    if (this.state.usage[role] >= this.policy.contextBudgetTokens * this.policy.checkpointRatio) {
      this.state.checkpoint = { ...this.state.checkpoint, role, usageEstimate: this.state.usage[role], at: this.now().toISOString() };
    }
    await this.#save();
    const parsed = parseJson(text);
    return parsed;
  }

  async #maybeCompact() {
    for (const role of ['screen', 'curate']) {
      if (this.state.usage[role] < this.policy.contextBudgetTokens * this.policy.compactRatio) continue;
      await this.backend.compact(this.state.threads[role]);
      await this.backend.turn(this.state.threads[role], `重新加载固定规则与持久检查点。\n${role === 'screen' ? SCREEN_RULES : CURATE_RULES}\n${JSON.stringify(this.state.checkpoint)}`, role);
      this.state.usage[role] = Math.ceil(Buffer.byteLength(JSON.stringify(this.state.checkpoint)) / 3);
      await this.#save();
    }
  }

  async #curatorInput(batch) {
    const byRef = new Map(batch.sources.map((row) => [row.ref, row]));
    const convert = (candidate, kind) => ({ ...candidate, candidate_kind: kind,
      evidence_refs: candidate.evidence_refs.map((ref) => {
        const row = byRef.get(ref);
        return { source_type: row.source_type, source_id: row.source_id, source_time: row.occurred_at,
          role: row.role, author: row.author, excerpt: row.content, original_ref: ref };
      }) });
    const remember = batch.screenOutput.remember.map((row) => convert(row, 'remember'));
    const watch = batch.screenOutput.watch.map((row) => convert(row, 'watch'));
    const related = new Map();
    for (const candidate of [...remember, ...watch]) {
      for (const state of ['remember', 'watch']) {
        const result = await this.recall.recall(candidate.statement, 5, { maintenanceState: state, threshold: .35 });
        for (const hit of result.results || []) related.set(hit.memory.id, hit.memory);
      }
    }
    for (const issue of batch.issues) if (issue.memory) related.set(issue.memory.id, issue.memory);
    for (const memory of batch.dueWatches) related.set(memory.id, memory);
    const issueContext = batch.issues.length ? batch.sources.filter((row) =>
      row.source_type === 'chat' && ['user', 'assistant'].includes(row.role) &&
      batch.issues.some((issue) => Math.abs(Date.parse(row.occurred_at) - Date.parse(issue.created_at)) <= 3 * 60 * 60_000))
      .slice(-40).map(({ source_type, source_id, role, author, content, occurred_at }) =>
        ({ source_type, source_id, role, author, content: content.slice(0, 2000), occurred_at })) : [];
    return { remember_candidates: remember, watch_candidates: watch,
      existing_memory_candidates: [...related.values()], pending_memory_issues: batch.issues,
      issue_context_sources: issueContext, due_watch_reviews: batch.dueWatches };
  }

  #validateScreen(output, sources) {
    if (!Array.isArray(output?.remember) || !Array.isArray(output?.watch)) throw new Error('筛选输出缺少 remember/watch 数组');
    const refs = new Set(sources.map((row) => row.ref));
    for (const row of [...output.remember, ...output.watch]) {
      if (!String(row.statement || '').trim() || !Array.isArray(row.evidence_refs) || !row.evidence_refs.length ||
          row.evidence_refs.some((ref) => !refs.has(ref))) throw new Error('筛选候选缺少内容或使用了未知来源 ref');
    }
  }

  #dropInvalidScreenCandidates(output, sources) {
    if (!Array.isArray(output?.remember) || !Array.isArray(output?.watch)) return output;
    const refs = new Set(sources.map((row) => row.ref));
    const valid = (row) => String(row.statement || '').trim() && Array.isArray(row.evidence_refs) &&
      row.evidence_refs.length && row.evidence_refs.every((ref) => refs.has(ref));
    const remember = output.remember.filter(valid);
    const watch = output.watch.filter(valid);
    const dropped = output.remember.length + output.watch.length - remember.length - watch.length;
    return { ...output, remember, watch,
      discard_summary: `${String(output.discard_summary || '')}${dropped ? `；${dropped} 条候选引用了本批外来源，已丢弃` : ''}` };
  }

  #validateCurate(output, batch) {
    if (!Array.isArray(output?.memories) || !Array.isArray(output?.links)) throw new Error('整理输出缺少 memories/links 数组');
    const issues = new Set(batch.issues.map((row) => row.id));
    if ((output.resolved_issue_ids || []).some((id) => !issues.has(id))) throw new Error('整理输出引用了未知问题单');
    const allowedSources = new Set(batch.sources.map((source) => `${source.source_type}:${source.source_id}`));
    for (const row of output.memories) {
      this.store.validateCandidate(row);
      if (row.memory_id && batch.dueWatches.some((watch) => watch.id === row.memory_id) &&
          row.memory_state === 'remember' && !(row.evidence_refs || []).length) throw new Error('到期 Watch 没有新证据，不得升级');
      if (row.memory_id && !this.store.getMemory(row.memory_id)) throw new Error('整理输出引用了不存在的旧节点');
      if (!row.memory_id && (!Array.isArray(row.evidence_refs) || !row.evidence_refs.length)) throw new Error('新节点缺少证据');
      for (const evidence of row.evidence_refs || []) {
        if (!allowedSources.has(`${evidence.source_type}:${evidence.source_id}`)) throw new Error('整理输出引用了本批之外的来源');
      }
    }
  }

  async #save(status = 'running') {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state), 'utf8');
    await rename(temporary, this.file);
    if (this.state.batch) this.store.putMaintenanceBatch(this.state.batch, { status, error: status === 'failed' ? this.state.lastError : '',
      threadIds: this.state.threads, contextUsage: this.state.usage.screen + this.state.usage.curate, stateFile: this.file });
  }
}

function parseJson(text) {
  const value = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(value); } catch {}
  // Compaction can leave a complete preceding response ahead of the current one.
  // Only accept a bounded sequence of complete objects; downstream evidence validation still applies.
  const objects = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') { if (depth++ === 0) start = i; continue; }
    if (char === '}') {
      if (--depth < 0) break;
      if (depth === 0 && start >= 0) {
        try { objects.push(JSON.parse(value.slice(start, i + 1))); } catch { break; }
        start = -1;
      }
      continue;
    }
    if (depth === 0 && !/\s/.test(char)) break;
  }
  if (depth === 0 && objects.length > 1 && objects.length <= 2 &&
      objects.every((item) => item && !Array.isArray(item) && typeof item === 'object')) return objects.at(-1);
  throw new Error('Luna 没有返回严格 JSON，批次已保留供重试');
}
