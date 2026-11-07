export class MemoryServiceClient {
  constructor({baseUrl='http://127.0.0.1:4191',recallTimeoutMs=150,toolTimeoutMs=3000}={}){this.baseUrl=baseUrl.replace(/\/$/,'');this.recallTimeoutMs=recallTimeoutMs;this.toolTimeoutMs=toolTimeoutMs}
  async importSources(records){return this.request('/api/sources/import',{method:'POST',body:{records}},this.toolTimeoutMs)}
  async recallForTurn(message,{limit=5,threshold=0.40}={}){try{const result=await this.request('/api/recall',{method:'POST',body:{query:message,limit,threshold}},this.recallTimeoutMs);return result.injection||[]}catch{return[]}}
  searchMemories(args){return this.request('/api/tools/search_memories',{method:'POST',body:args},this.toolTimeoutMs)}
  getMemory(memoryId){return this.request(`/api/tools/get_memory/${encodeURIComponent(memoryId)}`,{},this.toolTimeoutMs)}
  getRelatedMemories(memoryId){return this.request(`/api/tools/get_related_memories/${encodeURIComponent(memoryId)}`,{},this.toolTimeoutMs)}
  getMemoryEvidence(memoryId,{full=false}={}){return this.request(`/api/tools/get_memory_evidence/${encodeURIComponent(memoryId)}?full=${full}`,{},this.toolTimeoutMs)}
  reportMemoryIssue(args){return this.request('/api/tools/report_memory_issue',{method:'POST',body:args},this.toolTimeoutMs)}
  async request(path,options={},timeoutMs){const response=await fetch(this.baseUrl+path,{method:options.method||'GET',headers:{'content-type':'application/json'},body:options.body===undefined?undefined:JSON.stringify(options.body),signal:AbortSignal.timeout(timeoutMs)});const payload=await response.json();if(!response.ok)throw new Error(payload.error||`Memory service HTTP ${response.status}`);return payload}
}

export function memoryContextBlock(memories){if(!memories?.length)return'';return `<long_term_memories>\n${memories.map((row)=>JSON.stringify(row)).join('\n')}\n</long_term_memories>`}
