const PROMPT_VERSION='memory-lab-v1';
export class MemoryEngine {
  constructor(store,model){ this.store=store; this.model=model; }
  async organize(sourceIds,{reason='manual'}={}){
    const sources=this.store.getSources(sourceIds); if(!sources.length) throw new Error('没有可整理的来源');
    const batch=this.store.createBatch(sourceIds,reason); if(batch.reused) return {batchId:batch.id,reused:true,applied:[]};
    const related=this.store.findMemoryCandidates(sources.map(s=>s.content).join('\n'),12);
    const refs=new Map(sources.map((s,i)=>[`s${i+1}`,s.id]));
    const input={sources:sources.map((s,i)=>({ref:`s${i+1}`,type:s.source_type,role:s.role,author:s.author,occurredAt:s.occurred_at,content:s.content})),existingMemories:related.map(m=>({id:m.id,kind:m.kind,title:m.title,content:m.content,occurredStart:m.occurred_start,occurredEnd:m.occurred_end}))};
    const system=`你是私人陪伴机器人的记忆整理器。输出严格 JSON，不输出解释。你会看到 chat、timeline、space 三种原始证据和可能相关的旧记忆。\n
目标不是逐句摘要，而是形成少量、稳定、日后有用的记忆。思维可以跳跃：同一批来源允许产生多个主题和多个候选；chat/timeline/space 明确描述同一件事时才合并为同一 episode。同批次绝不意味着同一事件，时间相隔较远或主题不同必须拆开。\n
记忆类型：episode=有时间范围的经历；assertion=用户明确表达的事实/看法；observation=机器人可直接使用、以后允许修正的理解或推断。\n
证据规则：chat 中只有 role=user 的话能证明用户明确说过什么；role=assistant 不能单独证明用户事实，但可形成 owner=assistant 或 owner=relationship 的 observation。timeline 是已经整理好的可信事件证据，即使没有 role，也可直接证明经历、持续时间、计划偏移和拖延。space 按 author/role 区分视角，必须正确解析第一人称：assistant 写“我感觉用户……”表示 assistant 对用户的观察，不能改写成用户对别人做了什么。\n
整理规则：每条高价值来源必须被某个候选的 sourceRefs 覆盖；只有确实低价值时才输出 noop。已有记忆应优先 update，避免相似新节点。提醒和待办由其他系统处理，不写成记忆。优先输出 1–2 个候选，最多 3 个；不要为了少而硬合并。content 不超过 160 个汉字，reason 不超过 50 个汉字，每个候选最多 4 个 subjects。\n
输出格式：{"candidates":[{"action":"create|update|noop","targetMemoryId":null,"sourceRefs":["s1","s2"],"kind":"episode|assertion|observation","owner":"user|assistant|relationship","title":"短标题","content":"简洁陈述","importance":0到1,"occurredStart":null,"occurredEnd":null,"validFrom":null,"validTo":null,"subjects":[{"name":"稳定主题名","type":"person|project|activity|relationship|topic"}],"sameEpisodeAs":null,"reason":"简短理由"}]}`;
    let runId, out;
    try{
      out=await this.model.complete([{role:'system',content:system},{role:'user',content:JSON.stringify(input)}]);
      let parsed;
      try { parsed=parseJson(out.text); }
      catch {
        const repaired=await this.model.complete([{role:'system',content:'把下面内容修复成严格 JSON。只输出 JSON，不添加信息。'},{role:'user',content:out.text||'{"candidates":[]}'}],{temperature:0,maxTokens:900});
        out={text:repaired.text,latencyMs:out.latencyMs+repaired.latencyMs}; parsed=parseJson(out.text);
      }
      runId=this.store.addModelRun({batchId:batch.id,purpose:'organize',model:this.model.model,promptVersion:PROMPT_VERSION,status:'completed',input,outputText:out.text,latencyMs:out.latencyMs});
      const candidates=Array.isArray(parsed.candidates)?parsed.candidates:[]; const applied=[];
      for(const c of candidates.slice(0,3)){ if(Array.isArray(c.sourceRefs))c.sourceIds=c.sourceRefs.map(x=>refs.get(x)).filter(Boolean); applied.push(this.store.applyCandidate(normalize(c),runId,sourceIds)); }
      this.store.finishBatch(batch.id,'completed'); return {batchId:batch.id,reused:false,modelRunId:runId,latencyMs:out.latencyMs,candidates,applied};
    } catch(e){
      runId=this.store.addModelRun({batchId:batch.id,purpose:'organize',model:this.model.model,promptVersion:PROMPT_VERSION,status:'failed',input,outputText:out?.text||null,latencyMs:out?.latencyMs,error:e.message}); this.store.finishBatch(batch.id,'failed',e.message); throw e;
    }
  }
}
function parseJson(text){ const cleaned=String(text).replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim(); try{return JSON.parse(cleaned);}catch{ const a=cleaned.indexOf('{'),b=cleaned.lastIndexOf('}'); if(a>=0&&b>a){try{return JSON.parse(cleaned.slice(a,b+1));}catch{}} const candidates=salvageCandidates(cleaned); if(candidates.length)return{candidates,partial:true}; throw new Error('模型没有返回有效 JSON'); } }
function salvageCandidates(text){ const marker=text.indexOf('"candidates"');const start=text.indexOf('[',marker);if(start<0)return[];const out=[];let depth=0,begin=-1,inString=false,escape=false;for(let i=start+1;i<text.length;i++){const ch=text[i];if(inString){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"')inString=false;continue;}if(ch==='"'){inString=true;continue;}if(ch==='{'){if(depth===0)begin=i;depth++;}else if(ch==='}'&&depth){depth--;if(depth===0&&begin>=0){try{out.push(JSON.parse(text.slice(begin,i+1)));}catch{}begin=-1;}}}return out;}
function normalize(c){ const kinds=['episode','assertion','observation']; const actions=['create','update','noop']; return {...c,action:actions.includes(c.action)?c.action:'create',kind:kinds.includes(c.kind)?c.kind:'observation',importance:Math.max(0,Math.min(1,Number(c.importance??0.5))),subjects:Array.isArray(c.subjects)?c.subjects.slice(0,8):[]}; }

