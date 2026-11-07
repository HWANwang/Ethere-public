export class LocalEmbeddingClient {
  constructor({baseUrl='http://127.0.0.1:8180/v1',model='bge-base-zh-v1.5-q8',queryInstruction='为这个句子生成表示以用于检索相关文章：'}={}) {
    this.baseUrl=baseUrl.replace(/\/$/,'');
    this.model=model;
    this.queryInstruction=queryInstruction;
  }

  async health(){
    const start=Date.now();
    try{
      const r=await fetch(`${this.baseUrl.replace(/\/v1$/,'')}/health`,{signal:AbortSignal.timeout(3000)});
      return {ok:r.ok,latencyMs:Date.now()-start,detail:await r.text()};
    }catch(error){ return {ok:false,latencyMs:Date.now()-start,error:error.message}; }
  }

  async embed(texts,{query=false}={}){
    const input=(Array.isArray(texts)?texts:[texts]).map(text=>`${query?this.queryInstruction:''}${String(text).trim()}`);
    const started=Date.now();
    const r=await fetch(`${this.baseUrl}/embeddings`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model:this.model,input}),signal:AbortSignal.timeout(60000)
    });
    const raw=await r.text();
    if(!r.ok) throw new Error(`Embedding HTTP ${r.status}: ${raw.slice(0,500)}`);
    const data=JSON.parse(raw);
    const vectors=[...(data.data||[])].sort((a,b)=>a.index-b.index).map(x=>Float32Array.from(x.embedding));
    if(vectors.length!==input.length) throw new Error(`Embedding 数量不符：请求 ${input.length}，返回 ${vectors.length}`);
    return {vectors,model:data.model||this.model,dimensions:vectors[0]?.length||0,latencyMs:Date.now()-started,usage:data.usage||null};
  }
}

export function cosine(a,b){
  if(!a?.length||a.length!==b?.length)return -1;
  let dot=0,aa=0,bb=0;
  for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
  return aa&&bb?dot/Math.sqrt(aa*bb):-1;
}

export function rankByCosine(queryVector,items,limit=3){
  return items.map(item=>({...item,score:cosine(queryVector,item.vector)})).sort((a,b)=>b.score-a.score).slice(0,limit);
}

export function chunkForEmbedding(text,{maxChars=320,overlap=48}={}){
  const value=String(text||'').trim();
  if(!value)return [];
  if(value.length<=maxChars)return [value];
  const chunks=[];const step=Math.max(1,maxChars-overlap);
  for(let start=0;start<value.length;start+=step){chunks.push(value.slice(start,start+maxChars));if(start+maxChars>=value.length)break;}
  return chunks;
}

