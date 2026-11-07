export class LocalModelClient {
  constructor({baseUrl='http://127.0.0.1:8179/v1', model='qwen3.5-2b-q8'}={}) { this.baseUrl=baseUrl.replace(/\/$/,''); this.model=model; }
  async health(){ const start=Date.now(); try { const r=await fetch(`${this.baseUrl.replace(/\/v1$/,'')}/health`,{signal:AbortSignal.timeout(3000)}); return {ok:r.ok,latencyMs:Date.now()-start,detail:await r.text()}; } catch(e){ return {ok:false,latencyMs:Date.now()-start,error:e.message}; } }
  async complete(messages,{temperature=0.1,maxTokens=1400}={}){
    const start=Date.now(); const r=await fetch(`${this.baseUrl}/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:this.model,messages:messages.map((m,i)=>i===messages.length-1&&m.role==='user'?{...m,content:`${m.content}\n/no_think`}:m),temperature,max_tokens:maxTokens,response_format:{type:'json_object'},chat_template_kwargs:{enable_thinking:false}}),signal:AbortSignal.timeout(180000)});
    const raw=await r.text(); if(!r.ok) throw new Error(`模型 HTTP ${r.status}: ${raw.slice(0,500)}`);
    const data=JSON.parse(raw); return {text:data.choices?.[0]?.message?.content||'',latencyMs:Date.now()-start,usage:data.usage||null};
  }
}

