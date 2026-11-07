import { createHash } from 'node:crypto';
import { cosine } from './embedding-client.mjs';
import { AUTO_INJECTION_POLICY, selectAutoInjection, topicalSupport } from './auto-injection.mjs';
import { contextualRecallQuery } from './recall-query.mjs';

export class SemanticRecallEngine {
  constructor(store,embedding){this.store=store;this.embedding=embedding;}

  async recall(query,limit=5,options={}){
    const started=Date.now();
    const retrieval=contextualRecallQuery(query,options.context,options.occurredAt);
    const memories=options.maintenanceState?this.store.maintenanceMemories(options.maintenanceState):this.store.recallableMemories({...options,includeWatch:true,excludePendingDisputed:true});
    if(!memories.length)return {...this.store.recordRecall(query,[],Date.now()-started,{provider:'embedding',model:this.embedding.model}),injection:[]};
    const documents=memories.map(memory=>({memory,text:memory.content}));
    const vectors=new Array(documents.length);const missing=[];
    for(let i=0;i<documents.length;i++){
      const contentHash=sha(documents[i].text);const cached=this.store.getEmbedding('memory',documents[i].memory.id,this.embedding.model,contentHash);
      if(cached)vectors[i]=cached;else missing.push({index:i,contentHash,text:documents[i].text});
    }
    if(missing.length){
      const out=await this.embedding.embed(missing.map(x=>x.text));
      missing.forEach((item,j)=>{vectors[item.index]=out.vectors[j];this.store.putEmbedding('memory',documents[item.index].memory.id,this.embedding.model,out.vectors[j],item.contentHash);});
    }
    const queryParts=[retrieval.raw];
    if(retrieval.focus!==retrieval.raw)queryParts.push(retrieval.focus);
    if(retrieval.contextQuery)queryParts.push(retrieval.contextQuery);
    const queryVectors=(await this.embedding.embed(queryParts,{query:true})).vectors;
    const results=documents.map((item,i)=>{
      const similarities=queryVectors.map(queryVector=>Math.max(0,cosine(queryVector,vectors[i])));
      const semantic=similarities.length===1?similarities[0]:similarities.length===2
        ?retrieval.focus===retrieval.raw?similarities[0]*.60+similarities[1]*.40
          :similarities[0]*.45+similarities[1]*.55
        :similarities[0]*.30+similarities[1]*.50+similarities[2]*.20;
      const ageDays=Math.max(0,(Date.now()-Date.parse(item.memory.updated_at))/86_400_000);
      const recency=Math.exp(-ageDays/365);
      return {memory:item.memory,score:semantic*.96+recency*.04,semantic,
        reasons:[`语义相似度 ${semantic.toFixed(3)}`,`embedding ${this.embedding.model}`]};
    }).sort((a,b)=>b.score-a.score);
    const threshold=options.threshold??AUTO_INJECTION_POLICY.threshold;
    const eligible=results.filter((x)=>x.semantic>=threshold ||
      x.semantic>=threshold-.03 && topicalSupport(retrieval.raw,retrieval.focus,retrieval.contextQuery,x.memory.content)>=2);
    let selected;
    if(options.autoInjection){
      const lead=eligible[0]?.semantic||0;
      const runnerUp=eligible[1]?.semantic||0;
      const question=/[？?]|(?:吗|为什么|怎么|什么|如何|会不会|能不能|顺不顺|哪[个些])/.test(retrieval.raw);
      const topical=eligible.filter(({memory,semantic})=>{
        const support=topicalSupport(retrieval.raw,retrieval.focus,retrieval.contextQuery,memory.content);
        const strongLead=semantic===lead && (semantic>=.48 && lead-runnerUp>=.055 ||
          support>0 && (semantic>=.44 && lead-runnerUp>=.02 || semantic>=.42 && lead-runnerUp>=.07));
        return semantic>=.64 || support>=1 || strongLead || question && support>0 && semantic>=.58;
      });
      const remembers=topical.filter(({memory})=>memory.state==='remember');
      const watches=topical.filter(({memory})=>memory.state==='watch');
      const bestRemember=remembers[0]?.score ?? 0;
      const bestWatch=watches[0];
      const watchEligible=bestWatch && bestWatch.score>=0.55 && bestWatch.score-bestRemember>=0.05;
      const selectedRemember=selectAutoInjection(retrieval.focus,remembers,memories).filter((item)=>
        !watchEligible || item.score>=bestWatch.score-0.03);
      const semanticLeader=eligible.find(({memory})=>memory.state==='remember');
      if(semanticLeader && selectedRemember.length && !selectedRemember.some(({memory})=>memory.id===semanticLeader.memory.id) &&
        semanticLeader.semantic>=selectedRemember[0].semantic-.025 &&
        topicalSupport(retrieval.raw,retrieval.focus,retrieval.contextQuery,semanticLeader.memory.content)>0 &&
        (!watchEligible || semanticLeader.score>=bestWatch.score-.03)) selectedRemember.push(semanticLeader);
      selected=watchEligible?[bestWatch,...selectedRemember]:selectedRemember;
      selected=selected.slice(0,Math.max(1,Math.min(AUTO_INJECTION_POLICY.limit,limit)));
    }else selected=eligible.slice(0,Math.max(1,Math.min(20,limit)));
    const result=this.store.recordRecall(query,selected,Date.now()-started,{provider:'embedding',model:this.embedding.model,dimensions:queryVectors[0]?.length||0,queryChunks:queryParts.length,cached:documents.length-missing.length,embedded:missing.length,threshold:options.threshold??AUTO_INJECTION_POLICY.threshold,autoInjection:options.autoInjection===true});
    return {...result,injection:options.autoInjection?selected.map(({memory})=>({memory_id:memory.id,memory_type:memory.memory_type,state:memory.state,content:memory.content,valid_from:memory.valid_from,valid_to:memory.valid_to})):[],
      ...(options.debug?{diagnostics:{focus:retrieval.focus,contextSeq:retrieval.contextSeq,
        candidates:results.slice(0,10).map(({memory,score,semantic})=>({id:memory.id,state:memory.state,score,semantic,
          support:topicalSupport(retrieval.raw,retrieval.focus,retrieval.contextQuery,memory.content),
          content:memory.content.slice(0,180)}))}}:{})};
  }
}

function sha(value){return createHash('sha256').update(String(value)).digest('hex');}

