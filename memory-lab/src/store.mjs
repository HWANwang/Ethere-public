import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const now = () => new Date().toISOString();
const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const uid = (prefix) => `${prefix}_${randomUUID()}`;

export class MemoryLabStore {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.path = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_records (
        id TEXT PRIMARY KEY, source_type TEXT NOT NULL CHECK(source_type IN ('chat','timeline','space')),
        external_id TEXT NOT NULL, role TEXT, author TEXT, content TEXT NOT NULL,
        occurred_at TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', content_hash TEXT NOT NULL,
        imported_at TEXT NOT NULL, UNIQUE(source_type, external_id)
      );
    `);
    const sourceColumns=this.db.prepare('PRAGMA table_info(source_records)').all().map((row)=>row.name);
    if(!sourceColumns.includes('source_instance'))this.db.exec("ALTER TABLE source_records ADD COLUMN source_instance TEXT NOT NULL DEFAULT 'unknown'");
    if(!sourceColumns.includes('is_deleted'))this.db.exec('ALTER TABLE source_records ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0');
    const columns = this.db.prepare("PRAGMA table_info(memories)").all().map((row) => row.name);
    if (columns.length && !columns.includes('memory_type')) this.dropLegacyDerivedTables();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sources_time ON source_records(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_sources_type ON source_records(source_type);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, memory_type TEXT NOT NULL CHECK(memory_type IN ('fact','judgment')),
        state TEXT NOT NULL CHECK(state IN ('watch','remember')),
        record_status TEXT NOT NULL DEFAULT 'available' CHECK(record_status IN ('available','superseded','forgotten')),
        content TEXT NOT NULL, valid_from TEXT, valid_to TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, last_evidence_at TEXT, next_review_at TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_memories_recall ON memories(state,record_status,updated_at);
      CREATE INDEX IF NOT EXISTS idx_memories_review ON memories(state,record_status,next_review_at);
      CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK(source_type IN ('chat','timeline','space')),
        source_id TEXT NOT NULL, source_time TEXT, role TEXT, author TEXT, excerpt TEXT,
        created_at TEXT NOT NULL, UNIQUE(memory_id,source_type,source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_memory ON memory_evidence(memory_id,source_time);
      CREATE TABLE IF NOT EXISTS memory_links (
        id TEXT PRIMARY KEY, from_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        to_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL CHECK(relation_type IN ('related','supersedes','contradicts')),
        relation_note TEXT, created_at TEXT NOT NULL, change_id TEXT,
        UNIQUE(from_memory_id,to_memory_id,relation_type)
      );
      CREATE INDEX IF NOT EXISTS idx_links_from ON memory_links(from_memory_id);
      CREATE INDEX IF NOT EXISTS idx_links_to ON memory_links(to_memory_id);
      CREATE TABLE IF NOT EXISTS memory_changes (
        id TEXT PRIMARY KEY, memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
        action TEXT NOT NULL CHECK(action IN ('create','update','promote','merge','supersede','contradict','relate','forget','noop','manual_correct')),
        before_snapshot TEXT, after_snapshot TEXT, evidence_ids TEXT NOT NULL DEFAULT '[]',
        related_memory_ids TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'system', created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_changes_memory ON memory_changes(memory_id,created_at);
      CREATE TABLE IF NOT EXISTS memory_suppressions (
        id TEXT PRIMARY KEY, forgotten_memory_id TEXT NOT NULL, semantic_fingerprint TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('exact_memory','topic')), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_issues (
        id TEXT PRIMARY KEY, memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
        issue_type TEXT NOT NULL CHECK(issue_type IN ('incorrect','outdated','mixed','missing_context','forget_requested')),
        current_user_message_id TEXT, note TEXT, status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL, resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_issues_status ON memory_issues(status,created_at);
      CREATE TABLE IF NOT EXISTS maintenance_batches (
        id TEXT PRIMARY KEY, phase TEXT NOT NULL, status TEXT NOT NULL,
        source_ids_json TEXT NOT NULL DEFAULT '[]', input_path TEXT, output_path TEXT,
        model TEXT, reasoning TEXT, prompt_version TEXT, context_usage REAL,
        started_at TEXT NOT NULL, finished_at TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS maintenance_applies (
        batch_id TEXT PRIMARY KEY, result_json TEXT NOT NULL, applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS maintenance_processed_sources (
        source_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, processed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recall_runs (
        id TEXT PRIMARY KEY, query TEXT NOT NULL, context_json TEXT NOT NULL,
        latency_ms INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recall_results (
        recall_id TEXT NOT NULL REFERENCES recall_runs(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        rank INTEGER NOT NULL, score REAL NOT NULL, reasons_json TEXT NOT NULL,
        PRIMARY KEY(recall_id,memory_id)
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, model TEXT NOT NULL,
        dimensions INTEGER NOT NULL, vector_blob BLOB NOT NULL, content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(entity_type,entity_id,model)
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT OR REPLACE INTO schema_meta(key,value) VALUES ('schema_version','2');
    `);
    const batchColumns=this.db.prepare('PRAGMA table_info(maintenance_batches)').all().map((row)=>row.name);
    if(!batchColumns.includes('screen_thread_id'))this.db.exec('ALTER TABLE maintenance_batches ADD COLUMN screen_thread_id TEXT');
    if(!batchColumns.includes('curate_thread_id'))this.db.exec('ALTER TABLE maintenance_batches ADD COLUMN curate_thread_id TEXT');
  }

  dropLegacyDerivedTables() {
    this.db.exec(`PRAGMA foreign_keys=OFF;
      DROP TABLE IF EXISTS recall_results; DROP TABLE IF EXISTS recall_runs;
      DROP TABLE IF EXISTS memory_candidates; DROP TABLE IF EXISTS model_runs;
      DROP TABLE IF EXISTS batch_sources; DROP TABLE IF EXISTS maintenance_batches;
      DROP TABLE IF EXISTS memory_relations; DROP TABLE IF EXISTS memory_subjects;
      DROP TABLE IF EXISTS memory_sources; DROP TABLE IF EXISTS memory_revisions;
      DROP TABLE IF EXISTS subject_aliases; DROP TABLE IF EXISTS subjects;
      DROP TABLE IF EXISTS embeddings; DROP TABLE IF EXISTS settings; DROP TABLE IF EXISTS memories;
      PRAGMA foreign_keys=ON;`);
  }

  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value=fn(); this.db.exec('COMMIT'); return value; } catch(error) { this.db.exec('ROLLBACK'); throw error; } }

  importSources(records) {
    const statement=this.db.prepare(`INSERT INTO source_records
      (id,source_type,external_id,role,author,content,occurred_at,metadata_json,content_hash,imported_at,source_instance,is_deleted)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_type,external_id) DO UPDATE SET
      role=excluded.role,author=excluded.author,content=excluded.content,occurred_at=excluded.occurred_at,
      metadata_json=excluded.metadata_json,content_hash=excluded.content_hash,imported_at=excluded.imported_at,
      source_instance=excluded.source_instance,is_deleted=excluded.is_deleted
      WHERE source_records.content_hash<>excluded.content_hash OR source_records.source_instance<>excluded.source_instance OR source_records.is_deleted<>excluded.is_deleted`);
    const ids=[];
    this.transaction(()=>{for(const row of records){
      if(!['chat','timeline','space'].includes(row.sourceType)||(!row.deleted&&!String(row.content||'').trim())||
        (row.sourceType==='chat'&&!['user','assistant'].includes(row.role)))throw new Error('sourceType/content/role 无效');
      const externalId=String(row.externalId||randomUUID()); const sourceId=`src_${sha(`${row.sourceType}:${externalId}`).slice(0,24)}`; const metadata=JSON.stringify(row.metadata||{});
      statement.run(sourceId,row.sourceType,externalId,row.role||null,row.author||null,String(row.content||'').trim(),row.occurredAt||null,metadata,sha(`${row.content}|${row.occurredAt||''}|${metadata}|${Boolean(row.deleted)}`),now(),String(row.sourceInstance||'unknown'),row.deleted?1:0); ids.push(sourceId);
    }}); return ids;
  }
  recentSources(limit=100){return this.db.prepare('SELECT * FROM source_records ORDER BY COALESCE(occurred_at,imported_at) DESC LIMIT ?').all(limit);}

  applyCuratedOutput(payload,{reason='Luna 双窗口整理',actor='luna-medium',batchId='',resolvedIssueIds=[],processedSources=[],strictSources=false,sourceInstance=''}={}){
    if(!Array.isArray(payload?.memories))throw new Error('memories 必须是数组');
    if(batchId){const applied=this.db.prepare('SELECT result_json FROM maintenance_applies WHERE batch_id=?').get(batchId);if(applied)return parse(applied.result_json,{});}
    const tempToId=new Map(); const result={created:[],updated:[],links:[],discarded:payload.discarded_candidates||[]};
    this.transaction(()=>{
      for(const rawCandidate of payload.memories){
        const candidate={...rawCandidate,valid_from:normalizeTime(rawCandidate.valid_from,'earliest'),valid_to:normalizeTime(rawCandidate.valid_to,'latest'),
          evidence_refs:this.canonicalEvidence(rawCandidate.evidence_refs||[],{strictSources,sourceInstance})};
        this.validateCandidate(candidate); const existingId=candidate.memory_id&&this.rawMemory(candidate.memory_id)?.id; const memoryId=existingId||uid('mem'); const before=existingId?this.rawMemory(memoryId):null;
        if(candidate.record_status!=='forgotten'){
          if(before?.record_status==='forgotten')throw new Error('已遗忘节点不得由后台维护恢复');
          const suppressed=this.db.prepare('SELECT id FROM memory_suppressions WHERE semantic_fingerprint=? LIMIT 1').get(sha(candidate.content));
          if(suppressed)throw new Error('已遗忘内容不得由后台维护重新创建');
        }
        const lastEvidence=maxTimestamp([before?.last_evidence_at,...candidate.evidence_refs.map((row)=>row.source_time)]); const stamp=now();
        if(existingId){this.db.prepare(`UPDATE memories SET memory_type=?,state=?,record_status=?,content=?,valid_from=?,valid_to=?,updated_at=?,last_evidence_at=?,next_review_at=?,version=version+1 WHERE id=?`).run(candidate.memory_type,candidate.memory_state,candidate.record_status,candidate.content,candidate.valid_from||null,candidate.valid_to||null,stamp,lastEvidence,candidate.memory_state==='watch'?(candidate.next_review_at||plusDays(stamp,7)):null,memoryId);result.updated.push(memoryId);}
        else{this.db.prepare(`INSERT INTO memories(id,memory_type,state,record_status,content,valid_from,valid_to,created_at,updated_at,last_evidence_at,next_review_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)`).run(memoryId,candidate.memory_type,candidate.memory_state,candidate.record_status,candidate.content,candidate.valid_from||null,candidate.valid_to||null,stamp,stamp,lastEvidence,candidate.memory_state==='watch'?(candidate.next_review_at||plusDays(stamp,7)):null);result.created.push(memoryId);}
        tempToId.set(candidate.temp_id||memoryId,memoryId); const evidenceIds=this.addEvidence(memoryId,candidate.evidence_refs||[]);
        this.addChange(memoryId,existingId?(before.state==='watch'&&candidate.memory_state==='remember'?'promote':'update'):'create',before,this.rawMemory(memoryId),evidenceIds,[],candidate.merge_reason||reason,actor);
      }
      for(const link of payload.links||[]){
        const relation=link.relation||link.relation_type;const from=tempToId.get(link.from_temp_id||link.source_temp_id)||link.from_memory_id;const to=tempToId.get(link.to_temp_id||link.target_temp_id)||link.to_memory_id;
        if(!from||!to||from===to||!['related','supersedes','contradicts'].includes(relation))continue;
        const linkId=uid('link'); this.db.prepare(`INSERT OR IGNORE INTO memory_links(id,from_memory_id,to_memory_id,relation_type,relation_note,created_at) VALUES(?,?,?,?,?,?)`).run(linkId,from,to,relation,link.reason||null,now());
        if(this.db.prepare('SELECT changes() n').get().n){result.links.push(linkId);this.addChange(from,relation==='supersedes'?'supersede':relation==='contradicts'?'contradict':'relate',this.rawMemory(from),this.rawMemory(from),[],[to],link.reason||'建立记忆关系',actor);if(relation==='supersedes')this.db.prepare("UPDATE memories SET record_status='superseded',updated_at=?,version=version+1 WHERE id=?").run(now(),to);}
      }
      const resolveIssue=this.db.prepare("UPDATE memory_issues SET status='resolved',resolved_at=? WHERE id=? AND status='pending'");
      for(const issueId of new Set(resolvedIssueIds))resolveIssue.run(now(),issueId);
      const markSource=this.db.prepare('INSERT INTO maintenance_processed_sources(source_id,content_hash,processed_at) VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET content_hash=excluded.content_hash,processed_at=excluded.processed_at');
      for(const source of processedSources)markSource.run(source.id,source.content_hash,now());
      if(batchId)this.db.prepare('INSERT INTO maintenance_applies(batch_id,result_json,applied_at) VALUES(?,?,?)').run(batchId,JSON.stringify({...result,temp_id_map:Object.fromEntries(tempToId)}),now());
    });
    return{...result,temp_id_map:Object.fromEntries(tempToId)};
  }

  validateCandidate(row){if(!['fact','judgment'].includes(row.memory_type))throw new Error(`memory_type 无效: ${row.memory_type}`);if(!['watch','remember'].includes(row.memory_state))throw new Error(`memory_state 无效: ${row.memory_state}`);if(!['available','superseded','forgotten'].includes(row.record_status))throw new Error(`record_status 无效: ${row.record_status}`);if(!String(row.content||'').trim())throw new Error('content 不能为空');}
  canonicalEvidence(rows,{strictSources=false,sourceInstance=''}={}){return rows.map((row)=>{
    const source=this.db.prepare('SELECT * FROM source_records WHERE source_type=? AND external_id=?').get(row.source_type,row.source_id);
    if(!source){if(strictSources)throw new Error('证据来源不存在');return row;}
    if(strictSources&&(source.is_deleted||source.source_instance!==sourceInstance))throw new Error('证据来源已归档或不属于当前数据目录');
    return{source_type:source.source_type,source_id:source.external_id,source_time:source.occurred_at,
      role:source.role,author:source.author,excerpt:source.content.slice(0,500)};
  });}
  repairEvidenceFromSources(memoryIds,{sourceInstance}={}){
    if(!sourceInstance)throw new Error('修复证据需要来源身份');
    const updated=[];let repairedEvidence=0;
    this.transaction(()=>{for(const memoryId of new Set(memoryIds)){
      const before=this.rawMemory(memoryId);if(!before)throw new Error('待修复节点不存在');
      const evidence=this.db.prepare('SELECT * FROM memory_evidence WHERE memory_id=?').all(memoryId);
      const changedIds=[];
      for(const row of evidence){
        if(row.source_time&&row.author&&row.excerpt)continue;
        const source=this.canonicalEvidence([{source_type:row.source_type,source_id:row.source_id}],{strictSources:true,sourceInstance})[0];
        if(row.source_time===source.source_time&&row.role===source.role&&row.author===source.author&&row.excerpt===source.excerpt)continue;
        this.db.prepare('UPDATE memory_evidence SET source_time=?,role=?,author=?,excerpt=? WHERE id=?')
          .run(source.source_time,source.role,source.author,source.excerpt,row.id);
        changedIds.push(row.id);repairedEvidence++;
      }
      const times=this.db.prepare('SELECT source_time FROM memory_evidence WHERE memory_id=?').all(memoryId).map((row)=>row.source_time);
      const lastEvidence=maxTimestamp(times);
      if(changedIds.length||before.last_evidence_at!==lastEvidence){
        this.db.prepare('UPDATE memories SET last_evidence_at=?,version=version+1,updated_at=? WHERE id=?').run(lastEvidence,now(),memoryId);
        this.addChange(memoryId,'manual_correct',before,this.rawMemory(memoryId),changedIds,[],'系统从原始来源恢复证据字段','system');
        updated.push(memoryId);
      }
    }});
    return{updated,repairedEvidence};
  }
  addEvidence(memoryId,rows){const ids=[];for(const row of rows){if(!['chat','timeline','space'].includes(row.source_type)||!row.source_id)continue;let evidence=this.db.prepare('SELECT id FROM memory_evidence WHERE memory_id=? AND source_type=? AND source_id=?').get(memoryId,row.source_type,row.source_id);if(!evidence){const evidenceId=uid('ev');this.db.prepare(`INSERT INTO memory_evidence(id,memory_id,source_type,source_id,source_time,role,author,excerpt,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(evidenceId,memoryId,row.source_type,row.source_id,row.source_time||null,row.role||null,row.author||null,row.excerpt||null,now());evidence={id:evidenceId};}else if(row.source_time&&row.excerpt){this.db.prepare('UPDATE memory_evidence SET source_time=?,role=?,author=?,excerpt=? WHERE id=?').run(row.source_time,row.role||null,row.author||null,row.excerpt,evidence.id);}ids.push(evidence.id);}return ids;}

  listMemories({limit=200,state=null,status=null,type=null}={}){const clauses=[];const values=[];if(state){clauses.push('state=?');values.push(state)}if(status){clauses.push('record_status=?');values.push(status)}if(type){clauses.push('memory_type=?');values.push(type)}const rows=this.db.prepare(`SELECT * FROM memories ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY updated_at DESC LIMIT ?`).all(...values,limit);return rows.map((row)=>this.hydrateMemory(row));}
  getMemory(memoryId){const row=this.rawMemory(memoryId);return row?this.hydrateMemory(row):null;}
  rawMemory(memoryId){return this.db.prepare('SELECT * FROM memories WHERE id=?').get(memoryId);}
  hydrateMemory(row){const counts=this.db.prepare(`SELECT (SELECT COUNT(*) FROM memory_evidence WHERE memory_id=?) evidence_count,(SELECT COUNT(*) FROM memory_links WHERE from_memory_id=? OR to_memory_id=?) relation_count,(SELECT COUNT(*) FROM memory_changes WHERE memory_id=?) change_count`).get(row.id,row.id,row.id,row.id);const pendingIssueTypes=this.db.prepare("SELECT DISTINCT issue_type FROM memory_issues WHERE memory_id=? AND status='pending' ORDER BY issue_type").all(row.id).map((issue)=>issue.issue_type);return{...row,...counts,pending_issue_types:pendingIssueTypes};}
  getEvidence(memoryId,{full=false,limit=100}={}){const rows=this.db.prepare('SELECT * FROM memory_evidence WHERE memory_id=? ORDER BY source_time,created_at LIMIT ?').all(memoryId,limit);if(!full)return rows.map(({excerpt,...row})=>({...row,excerpt:excerpt?.slice(0,500)||null}));return rows.map((row)=>{const source=this.db.prepare('SELECT content,metadata_json FROM source_records WHERE source_type=? AND external_id=?').get(row.source_type,row.source_id);return{...row,full_content:source?.content||row.excerpt,metadata:parse(source?.metadata_json,'{}')}});}
  getRelated(memoryId,limit=10){const links=this.db.prepare('SELECT * FROM memory_links WHERE from_memory_id=? OR to_memory_id=? ORDER BY created_at DESC LIMIT ?').all(memoryId,memoryId,limit);return links.map((link)=>{const otherId=link.from_memory_id===memoryId?link.to_memory_id:link.from_memory_id;return{...link,direction:link.from_memory_id===memoryId?'outgoing':'incoming',memory:this.getMemory(otherId)}});}
  getChanges(memoryId,limit=50){return this.db.prepare('SELECT * FROM memory_changes WHERE memory_id=? ORDER BY created_at DESC LIMIT ?').all(memoryId,limit).map((row)=>({...row,before_snapshot:parse(row.before_snapshot),after_snapshot:parse(row.after_snapshot),evidence_ids:parse(row.evidence_ids,[]),related_memory_ids:parse(row.related_memory_ids,[])}));}

  reviseMemory(memoryId,patch,reason='用户手动更正'){
    const before=this.rawMemory(memoryId);if(!before)return null;const next={...before,memory_type:patch.memory_type??before.memory_type,state:patch.state??before.state,record_status:patch.record_status??before.record_status,content:String(patch.content??before.content).trim(),valid_from:patch.valid_from===undefined?before.valid_from:patch.valid_from,valid_to:patch.valid_to===undefined?before.valid_to:patch.valid_to};this.validateCandidate({...next,memory_state:next.state});
    this.transaction(()=>{this.db.prepare(`UPDATE memories SET memory_type=?,state=?,record_status=?,content=?,valid_from=?,valid_to=?,updated_at=?,next_review_at=?,version=version+1 WHERE id=?`).run(next.memory_type,next.state,next.record_status,next.content,next.valid_from,next.valid_to,now(),next.state==='watch'?(before.next_review_at||plusDays(now(),7)):null,memoryId);if(next.record_status==='forgotten'&&before.record_status!=='forgotten')this.db.prepare('INSERT INTO memory_suppressions(id,forgotten_memory_id,semantic_fingerprint,scope,created_at) VALUES(?,?,?,?,?)').run(uid('sup'),memoryId,sha(before.content),'exact_memory',now());this.addChange(memoryId,next.record_status==='forgotten'?'forget':'manual_correct',before,this.rawMemory(memoryId),[],[],reason,'user');});return this.getMemory(memoryId);
  }
  reportIssue(value){if(!['incorrect','outdated','mixed','missing_context','forget_requested'].includes(value.issue_type))throw new Error('issue_type 无效');if(value.memory_id&&!this.rawMemory(value.memory_id))throw new Error('记忆不存在');const issueId=uid('issue');const immediate=value.issue_type==='forget_requested'&&value.memory_id;if(immediate)this.reviseMemory(value.memory_id,{record_status:'forgotten'},value.note||'用户明确要求遗忘');this.db.prepare('INSERT INTO memory_issues(id,memory_id,issue_type,current_user_message_id,note,status,created_at,resolved_at) VALUES(?,?,?,?,?,?,?,?)').run(issueId,value.memory_id||null,value.issue_type,value.current_user_message_id||null,value.note||null,immediate?'resolved':'pending',now(),immediate?now():null);return this.db.prepare('SELECT * FROM memory_issues WHERE id=?').get(issueId);}
  listIssues(status='pending',limit=100){return this.db.prepare('SELECT * FROM memory_issues WHERE status=? ORDER BY created_at LIMIT ?').all(status,limit).map((row)=>({...row,memory:row.memory_id?this.getMemory(row.memory_id):null}));}
  resolveIssues(ids=[]){const statement=this.db.prepare("UPDATE memory_issues SET status='resolved',resolved_at=? WHERE id=? AND status='pending'");let count=0;this.transaction(()=>{for(const id of new Set(ids)){statement.run(now(),id);count+=this.db.prepare('SELECT changes() n').get().n;}});return count;}

  recallableMemories({includeSuperseded=false,includeWatch=false,memoryType=null,timeRange=null,excludePendingDisputed=false}={}){const clauses=[includeWatch?"state IN ('remember','watch')":"state='remember'",includeSuperseded?"record_status IN ('available','superseded')":"record_status='available'"];const values=[];if(excludePendingDisputed)clauses.push("NOT EXISTS (SELECT 1 FROM memory_issues mi WHERE mi.memory_id=memories.id AND mi.status='pending' AND mi.issue_type IN ('incorrect','outdated','mixed'))");if(memoryType){clauses.push('memory_type=?');values.push(memoryType)}if(timeRange?.from){clauses.push('(valid_to IS NULL OR valid_to>=?)');values.push(timeRange.from)}if(timeRange?.to){clauses.push('(valid_from IS NULL OR valid_from<=?)');values.push(timeRange.to)}return this.db.prepare(`SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`).all(...values).map((row)=>this.hydrateMemory(row));}
  maintenanceMemories(state){if(!['watch','remember'].includes(state))throw new Error('维护召回 state 无效');return this.db.prepare("SELECT * FROM memories WHERE state=? AND record_status='available' ORDER BY updated_at DESC").all(state).map((row)=>this.hydrateMemory(row));}
  addChange(memoryId,action,before,after,evidenceIds,relatedIds,reason,actor='system'){const changeId=uid('chg');this.db.prepare('INSERT INTO memory_changes(id,memory_id,action,before_snapshot,after_snapshot,evidence_ids,related_memory_ids,reason,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(changeId,memoryId,action,before?JSON.stringify(before):null,after?JSON.stringify(after):null,JSON.stringify(evidenceIds||[]),JSON.stringify(relatedIds||[]),reason,actor,now());return changeId;}
  createMaintenanceBatch(value){const batchId=uid('batch');this.db.prepare('INSERT INTO maintenance_batches(id,phase,status,source_ids_json,input_path,output_path,model,reasoning,prompt_version,context_usage,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(batchId,value.phase||'screen',value.status||'pending',JSON.stringify(value.source_ids||[]),value.input_path||null,value.output_path||null,value.model||'gpt-6-luna',value.reasoning||'medium',value.prompt_version||null,value.context_usage??null,now());return batchId;}
  putMaintenanceBatch(batch,{status='running',error='',threadIds={},contextUsage=0,stateFile=''}={}){
    this.db.prepare(`INSERT INTO maintenance_batches(id,phase,status,source_ids_json,input_path,output_path,model,reasoning,prompt_version,context_usage,started_at,finished_at,error,screen_thread_id,curate_thread_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      phase=excluded.phase,status=excluded.status,source_ids_json=excluded.source_ids_json,
      input_path=excluded.input_path,output_path=excluded.output_path,context_usage=excluded.context_usage,
      finished_at=excluded.finished_at,error=excluded.error,screen_thread_id=excluded.screen_thread_id,curate_thread_id=excluded.curate_thread_id`)
      .run(batch.id,batch.phase,status,JSON.stringify(batch.sources?.map((source)=>source.id)||[]),stateFile,stateFile,
        'gpt-6-luna','medium','production-v1',contextUsage,batch.startedAt,status==='completed'?now():null,error||null,
        threadIds.screen||null,threadIds.curate||null);
  }
  listMaintenance(limit=100){return this.db.prepare('SELECT * FROM maintenance_batches ORDER BY started_at DESC LIMIT ?').all(limit).map((row)=>({...row,source_ids:parse(row.source_ids_json,[])}));}
  getEmbedding(entityType,entityId,model,contentHash){const row=this.db.prepare('SELECT vector_blob,dimensions FROM embeddings WHERE entity_type=? AND entity_id=? AND model=? AND content_hash=?').get(entityType,entityId,model,contentHash);if(!row)return null;const bytes=Buffer.from(row.vector_blob);return Float32Array.from(new Float32Array(bytes.buffer,bytes.byteOffset,row.dimensions));}
  putEmbedding(entityType,entityId,model,vector,contentHash){const data=Buffer.from(vector.buffer,vector.byteOffset,vector.byteLength);this.db.prepare(`INSERT INTO embeddings(entity_type,entity_id,model,dimensions,vector_blob,content_hash,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(entity_type,entity_id,model) DO UPDATE SET dimensions=excluded.dimensions,vector_blob=excluded.vector_blob,content_hash=excluded.content_hash,created_at=excluded.created_at`).run(entityType,entityId,model,vector.length,data,contentHash,now());}
  recordRecall(query,results,latencyMs,context={}){const recallId=uid('recall');this.db.prepare('INSERT INTO recall_runs(id,query,context_json,latency_ms,created_at) VALUES(?,?,?,?,?)').run(recallId,query,JSON.stringify(context),latencyMs,now());const insert=this.db.prepare('INSERT INTO recall_results(recall_id,memory_id,rank,score,reasons_json) VALUES(?,?,?,?,?)');results.forEach((row,index)=>insert.run(recallId,row.memory.id,index+1,row.score,JSON.stringify(row.reasons||[])));return{id:recallId,latencyMs,context,results};}
  stats(){const count=(table)=>this.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;return{databasePath:this.path,schemaVersion:2,sources:count('source_records'),memories:count('memories'),remember:this.db.prepare("SELECT COUNT(*) n FROM memories WHERE state='remember'").get().n,watch:this.db.prepare("SELECT COUNT(*) n FROM memories WHERE state='watch'").get().n,evidence:count('memory_evidence'),links:count('memory_links'),pendingIssues:this.db.prepare("SELECT COUNT(*) n FROM memory_issues WHERE status='pending'").get().n};}
}

function plusDays(value,days){const date=new Date(value);date.setUTCDate(date.getUTCDate()+days);return date.toISOString();}
function maxTimestamp(values){return values.filter((value)=>value&&Number.isFinite(Date.parse(value))).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)||null;}
function normalizeTime(value,mode){if(value===null||value===undefined||value==='')return null;const values=(Array.isArray(value)?value:[value]).filter((item)=>typeof item==='string'&&item.trim()).map((item)=>item.trim()).sort();if(!values.length)return null;return mode==='latest'?values.at(-1):values[0];}
