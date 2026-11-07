import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryLabStore } from '../src/store.mjs';
import { SemanticRecallEngine } from '../src/semantic-recall.mjs';
import { selectAutoInjection } from '../src/auto-injection.mjs';
import { chunkForEmbedding } from '../src/embedding-client.mjs';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'memory-v2-'));const store=new MemoryLabStore(join(dir,'test.sqlite'));return{store,clean(){store.close();rmSync(dir,{recursive:true,force:true})}}}
const evidence=(id,content='原文')=>({source_type:'chat',source_id:id,source_time:'2026-11-04T10:00:00+08:00',role:'user',author:'用户',excerpt:content});
const candidate=(overrides={})=>({temp_id:'T1',memory_type:'judgment',memory_state:'remember',record_status:'available',content:'用户希望提醒有力度但不要频繁催促。',valid_from:'2026-11-04',valid_to:null,evidence_refs:[evidence('c1')],source_candidate_ids:['R1'],merge_reason:'明确相处规则',...overrides});

test('来源导入幂等并永久保留原文',()=>{const f=fixture();try{const row={sourceType:'chat',externalId:'x1',role:'user',content:'我喜欢拼豆'};assert.deepEqual(f.store.importSources([row]),f.store.importSources([{...row,content:'我很喜欢拼豆'}]));assert.equal(f.store.stats().sources,1)}finally{f.clean()}});

test('来源身份、墓碑与未变化重扫不会刷新导入时间',()=>{const f=fixture();try{const row={sourceType:'space',externalId:'post-1',content:'陶艺练习',sourceInstance:'production',occurredAt:'2026-11-01T00:00:00.000Z'};const [id]=f.store.importSources([row]);const before=f.store.db.prepare('SELECT * FROM source_records WHERE id=?').get(id);f.store.importSources([row]);const same=f.store.db.prepare('SELECT * FROM source_records WHERE id=?').get(id);assert.equal(same.imported_at,before.imported_at);f.store.importSources([{...row,deleted:true,content:''}]);const deleted=f.store.db.prepare('SELECT * FROM source_records WHERE id=?').get(id);assert.equal(deleted.is_deleted,1);assert.equal(deleted.source_instance,'production')}finally{f.clean()}});

test('模型只给来源 ID 时由原始记录补全证据，伪造字段不能覆盖',()=>{const f=fixture();try{
  f.store.importSources([{sourceType:'chat',externalId:'c1',role:'user',author:'用户',content:'我在学陶艺',occurredAt:'2026-11-04T10:00:00+08:00',sourceInstance:'production'}]);
  const id=f.store.applyCuratedOutput({memories:[candidate({evidence_refs:[{source_type:'chat',source_id:'c1',source_time:'2000-01-01',role:'assistant',author:'伪造',excerpt:'假的'}]})]},
    {strictSources:true,sourceInstance:'production'}).created[0];
  const evidence=f.store.getEvidence(id)[0];assert.equal(evidence.excerpt,'我在学陶艺');assert.equal(evidence.role,'user');assert.equal(evidence.author,'用户');assert.equal(evidence.source_time,'2026-11-04T10:00:00+08:00');
  assert.equal(f.store.getMemory(id).last_evidence_at,evidence.source_time);
  f.store.db.prepare('UPDATE memory_evidence SET source_time=NULL,role=NULL,author=NULL,excerpt=NULL WHERE memory_id=?').run(id);
  f.store.db.prepare('UPDATE memories SET last_evidence_at=NULL WHERE id=?').run(id);
  const repaired=f.store.repairEvidenceFromSources([id],{sourceInstance:'production'});
  assert.equal(repaired.repairedEvidence,1);assert.equal(f.store.getEvidence(id)[0].excerpt,'我在学陶艺');
  assert.equal(f.store.getMemory(id).last_evidence_at,'2026-11-04T10:00:00+08:00');
}finally{f.clean()}});

test('后台维护不能引用已删或隔离的来源',()=>{const f=fixture();try{
  f.store.importSources([{sourceType:'chat',externalId:'c1',role:'user',content:'隔离来源',sourceInstance:'other'},
    {sourceType:'space',externalId:'s1',content:'已归档',sourceInstance:'production',deleted:true}]);
  assert.throws(()=>f.store.applyCuratedOutput({memories:[candidate({evidence_refs:[{source_type:'chat',source_id:'c1'}]})]},{strictSources:true,sourceInstance:'production'}),/不属于当前数据目录/);
  assert.throws(()=>f.store.applyCuratedOutput({memories:[candidate({evidence_refs:[{source_type:'space',source_id:'s1'}]})]},{strictSources:true,sourceInstance:'production'}),/已归档/);
  assert.equal(f.store.stats().memories,0);
}finally{f.clean()}});

test('双窗口输出写入 Remember、Watch、证据和变更',()=>{const f=fixture();try{const out=f.store.applyCuratedOutput({memories:[candidate(),candidate({temp_id:'T2',memory_state:'watch',content:'临近面试可能更容易回避。',evidence_refs:[evidence('c2')],source_candidate_ids:['W1']})],links:[],discarded_candidates:[]});assert.equal(out.created.length,2);assert.equal(f.store.stats().remember,1);assert.equal(f.store.stats().watch,1);assert.equal(f.store.stats().evidence,2);assert.equal(f.store.getChanges(out.created[0])[0].action,'create')}finally{f.clean()}});

test('首次出现的高价值 Watch 会保存并安排复查',()=>{const f=fixture();try{const out=f.store.applyCuratedOutput({memories:[candidate({memory_state:'watch'})]});const row=f.store.getMemory(out.created[0]);assert.equal(row.state,'watch');assert.ok(row.next_review_at)}finally{f.clean()}});

test('整理器偶发返回时间数组时由提交层确定性归一化',()=>{const f=fixture();try{const out=f.store.applyCuratedOutput({memories:[candidate({valid_from:['2026-11-05','2026-11-04'],valid_to:['2026-12-01']})]});const row=f.store.getMemory(out.created[0]);assert.equal(row.valid_from,'2026-11-04');assert.equal(row.valid_to,'2026-12-01')}finally{f.clean()}});

test('已结束的 available 记忆仍可进入召回池',()=>{const f=fixture();try{f.store.applyCuratedOutput({memories:[candidate({valid_to:'2026-12-01'})]});assert.equal(f.store.recallableMemories().length,1)}finally{f.clean()}});

test('forgotten 停止召回并写入抑制记录',()=>{const f=fixture();try{const out=f.store.applyCuratedOutput({memories:[candidate()]});f.store.reviseMemory(out.created[0],{record_status:'forgotten'},'用户要求遗忘');assert.equal(f.store.recallableMemories().length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_suppressions').get().n,1)}finally{f.clean()}});

test('supersedes 建立方向关系并关闭旧节点的常规召回',()=>{const f=fixture();try{const first=f.store.applyCuratedOutput({memories:[candidate({temp_id:'OLD',content:'旧判断'})]}).created[0];const out=f.store.applyCuratedOutput({memories:[candidate({temp_id:'NEW',content:'新判断',evidence_refs:[evidence('c2')]})],links:[{from_temp_id:'NEW',to_memory_id:first,relation:'supersedes',reason:'新证据取代旧判断'}]});assert.equal(f.store.getMemory(first).record_status,'superseded');assert.equal(f.store.getRelated(out.created[0])[0].relation_type,'supersedes')}finally{f.clean()}});

test('人工更正保留版本和历史',()=>{const f=fixture();try{const memoryId=f.store.applyCuratedOutput({memories:[candidate()]}).created[0];const row=f.store.reviseMemory(memoryId,{content:'提醒需要力度与空间。'},'用户更正措辞');assert.equal(row.version,2);assert.equal(f.store.getChanges(memoryId)[0].action,'manual_correct')}finally{f.clean()}});

test('主模型可以查看关系、证据并提交问题',()=>{const f=fixture();try{const memoryId=f.store.applyCuratedOutput({memories:[candidate()]}).created[0];assert.equal(f.store.getEvidence(memoryId).length,1);const issue=f.store.reportIssue({memory_id:memoryId,issue_type:'missing_context',current_user_message_id:'u1',note:'需要核对原话'});assert.equal(issue.status,'pending')}finally{f.clean()}});

test('明确遗忘请求立即停止召回且问题单自动完成',()=>{const f=fixture();try{const memoryId=f.store.applyCuratedOutput({memories:[candidate()]}).created[0];const issue=f.store.reportIssue({memory_id:memoryId,issue_type:'forget_requested',note:'用户明确要求遗忘'});assert.equal(issue.status,'resolved');assert.equal(f.store.getMemory(memoryId).record_status,'forgotten');assert.equal(f.store.recallableMemories().length,0)}finally{f.clean()}});

test('正式召回只搜索 available Remember，并返回紧凑注入结构',async()=>{const f=fixture();try{f.store.applyCuratedOutput({memories:[candidate({content:'寒冷和厚衣服可能增加出门启动成本。'}),candidate({temp_id:'W',memory_state:'watch',content:'临近面试可能更容易回避。',evidence_refs:[evidence('c2')]})]});const embedding={model:'fake',async embed(input){const rows=Array.isArray(input)?input:[input];return{vectors:rows.map(()=>Float32Array.from([1,0]))}}};const out=await new SemanticRecallEngine(f.store,embedding).recall('冬天不想出门',3,{threshold:0,autoInjection:true});assert.equal(out.results.length,1);assert.equal(out.injection.length,1);assert.ok(out.injection[0].memory_id);assert.equal('relation_context' in out.injection[0],false)}finally{f.clean()}});

test('主动搜索两档，自动注入只在 Watch 明显更相关时带一条并标待观察',async()=>{const f=fixture();try{
  const created=f.store.applyCuratedOutput({memories:[candidate({content:'用户希望任务进度清晰。'}),candidate({temp_id:'W',memory_state:'watch',content:'用户可能喜欢节奏快的爽剧。',evidence_refs:[evidence('c2')]})]}).created;
  const embedding={model:'fake-watch',async embed(input,{query=false}={}){const rows=Array.isArray(input)?input:[input];return{vectors:rows.map((text)=>Float32Array.from(query?[1,0]:String(text).includes('爽剧')?[.8,.6]:[.5,.8660254]))}}};
  const engine=new SemanticRecallEngine(f.store,embedding);
  const searched=await engine.recall('喜欢什么爽剧',5,{threshold:.4});
  assert.deepEqual(new Set(searched.results.map((row)=>row.memory.state)),new Set(['remember','watch']));
  const injected=await engine.recall('喜欢什么爽剧',3,{autoInjection:true,threshold:.4});
  assert.deepEqual(injected.injection.map((row)=>row.state),['watch']);
  f.store.reportIssue({memory_id:created[1],issue_type:'outdated'});
  const disputed=await engine.recall('喜欢什么爽剧',3,{autoInjection:true,threshold:.4});
  assert.ok(disputed.injection.every((row)=>row.state!=='watch'));
}finally{f.clean()}});

test('未解决的错误、过时或混合问题暂不自动注入，但主动搜索仍能看到状态',()=>{for(const type of ['incorrect','outdated','mixed']){const f=fixture();try{const id=f.store.applyCuratedOutput({memories:[candidate()]}).created[0];const issue=f.store.reportIssue({memory_id:id,issue_type:type});assert.deepEqual(f.store.recallableMemories({excludePendingDisputed:true}),[]);assert.deepEqual(f.store.recallableMemories()[0].pending_issue_types,[type]);assert.deepEqual(f.store.getMemory(id).pending_issue_types,[type]);f.store.resolveIssues([issue.id]);assert.equal(f.store.recallableMemories({excludePendingDisputed:true}).length,1)}finally{f.clean()}}});

test('缺少上下文问题不禁止自动注入',()=>{const f=fixture();try{const id=f.store.applyCuratedOutput({memories:[candidate()]}).created[0];f.store.reportIssue({memory_id:id,issue_type:'missing_context'});assert.equal(f.store.recallableMemories({excludePendingDisputed:true}).length,1)}finally{f.clean()}});

test('待处理的过时节点即使语义命中也不进入自动注入',async()=>{const f=fixture();try{const id=f.store.applyCuratedOutput({memories:[candidate({content:'用户正在整理长期记忆。'})]}).created[0];f.store.reportIssue({memory_id:id,issue_type:'outdated'});const embedding={model:'fake',async embed(input){const rows=Array.isArray(input)?input:[input];return{vectors:rows.map(()=>Float32Array.from([1,0]))}}};const out=await new SemanticRecallEngine(f.store,embedding).recall('整理记忆',3,{autoInjection:true,threshold:0});assert.deepEqual(out.injection,[]);assert.deepEqual(out.results,[]);assert.equal(f.store.recallableMemories()[0].pending_issue_types[0],'outdated')}finally{f.clean()}});

test('相近的记忆库结果优先于无关高分，尾部噪音不自动注入',()=>{const contents=['醒来后安排当天任务。','用户正在搭建陪伴机器人的记忆库项目，涉及 RAG 与本地模型整理记忆；愿意评价记忆质量和召回效果。','用户对前任关系的阶段性结论。'];const candidates=contents.map((content,index)=>({memory:{content},score:[0.485,0.467,0.451][index]}));const selected=selectAutoInjection('你评价一下他整理的记忆质量，他召回了什么？',candidates,contents.map((content)=>({content})));assert.equal(selected[0].memory.content,contents[1]);assert.ok(selected.length<=3)});

test('长查询分块避免超过 embedding 单条限制',()=>{const chunks=chunkForEmbedding('甲'.repeat(900),{maxChars:320,overlap:48});assert.equal(chunks.length,4);assert.ok(chunks.every((value)=>value.length<=320))});
