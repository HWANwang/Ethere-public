import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryLabStore } from './store.mjs';
import { LocalEmbeddingClient } from './embedding-client.mjs';
import { SemanticRecallEngine } from './semantic-recall.mjs';
import { MemoryMaintenanceService } from './maintenance-service.mjs';
import { CodexMaintenanceBackend } from './codex-maintenance-backend.mjs';
import { resolveProjectDataRoot } from '../../server/paths.mjs';
import { sourceInstanceForDataRoot } from '../../server/memory-v2-client.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const dataDir=resolve(process.env.MEMORY_LAB_DATA_DIR||join(root,'runtime'));
const dbPath=join(dataDir,'memory-lab.sqlite');
const port=Number(process.env.MEMORY_LAB_PORT||4191);
const host=process.env.MEMORY_LAB_HOST||'127.0.0.1';
const store=new MemoryLabStore(dbPath);
const embedding=new LocalEmbeddingClient({baseUrl:process.env.MEMORY_LAB_EMBEDDING_URL||'http://127.0.0.1:8180/v1',model:process.env.MEMORY_LAB_EMBEDDING_NAME||'bge-base-zh-v1.5-q8'});
const recall=new SemanticRecallEngine(store,embedding);
const webRoot=join(root,'web');
const projectRoot=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const autoMaintenance=process.env.MEMORY_LAB_AUTO_MAINTENANCE==='true';
const productionDataRoot=autoMaintenance?resolveProjectDataRoot(projectRoot):'';
const productionSourceInstance=autoMaintenance?sourceInstanceForDataRoot(productionDataRoot):'';
const maintenance=autoMaintenance?new MemoryMaintenanceService({store,recall,
  backend:new CodexMaintenanceBackend({cwd:root}),dataRoot:productionDataRoot,sourceInstance:productionSourceInstance,
  isMainBusy:async()=>{try{const response=await fetch('http://127.0.0.1:4173/api/ethere/v1/runtime/status',{signal:AbortSignal.timeout(3000)});if(!response.ok)return true;return Boolean((await response.json()).busy)}catch{return true}}
}):null;
let maintenanceTimer=null;

const server=http.createServer(async(req,res)=>{
  try{
    if(req.method==='OPTIONS'){res.writeHead(204,cors());return res.end()}
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(url.pathname==='/api/health')return send(res,200,{ok:true,service:'memory-lab-v2',version:2,pid:process.pid,port,dataDir,dbPath,embeddingUrl:embedding.baseUrl,embeddingModel:embedding.model,organizer:'gpt-6-luna / medium / two-window'});
    if(url.pathname==='/api/embedding/health')return send(res,200,await embedding.health());
    if(url.pathname==='/api/stats')return send(res,200,store.stats());
    if(url.pathname==='/api/memories')return send(res,200,{memories:store.listMemories({limit:Number(url.searchParams.get('limit')||200),state:url.searchParams.get('state'),status:url.searchParams.get('status'),type:url.searchParams.get('type')})});
    if(url.pathname==='/api/sources/recent')return send(res,200,{sources:store.recentSources(Number(url.searchParams.get('limit')||100))});
    if(url.pathname==='/api/maintenance')return send(res,200,{batches:store.listMaintenance(Number(url.searchParams.get('limit')||100))});
    if(url.pathname==='/api/issues'&&req.method==='GET')return send(res,200,{issues:store.listIssues(url.searchParams.get('status')||'pending',Number(url.searchParams.get('limit')||100))});
    if(url.pathname==='/api/maintenance/status'&&req.method==='GET')return send(res,200,maintenance?.status()||{enabled:false,reason:'后台维护未启用'});
    if(url.pathname==='/api/maintenance/trigger'&&req.method==='POST'){if(!maintenance)throw httpError(503,'后台维护未启用');void maintenance.trigger();return send(res,202,maintenance.status());}
    if(url.pathname==='/api/maintenance/enabled'&&req.method==='POST'){if(!maintenance)throw httpError(503,'后台维护未启用');const body=await bodyJson(req);return send(res,200,await maintenance.setEnabled(body.enabled===true));}

    if(req.method==='POST'&&url.pathname==='/api/sources/import'){
      const body=await bodyJson(req);const records=Array.isArray(body)?body:body.records;if(!Array.isArray(records))throw httpError(400,'records 必须是数组');
      if(autoMaintenance&&records.some((record)=>record.sourceInstance!==productionSourceInstance))throw httpError(403,'来源实例与生产数据目录不符');
      const sourceIds=store.importSources(records);const status=maintenance?.status();
      return send(res,200,{sourceIds,maintenanceQueued:Boolean(status?.enabled&&status.pendingSources),pendingSources:status?.pendingSources||0});
    }
    if(req.method==='POST'&&url.pathname==='/api/maintenance/batches'){
      const body=await bodyJson(req);return send(res,201,{batchId:store.createMaintenanceBatch(body)});
    }
    if(req.method==='POST'&&url.pathname==='/api/maintenance/apply'){
      const body=await bodyJson(req);const result=store.applyCuratedOutput(body.output||body,{reason:body.reason,actor:body.actor});const resolvedIssues=store.resolveIssues(body.resolved_issue_ids||body.output?.resolved_issue_ids||[]);return send(res,200,{...result,resolved_issues:resolvedIssues});
    }
    if(req.method==='POST'&&url.pathname==='/api/maintenance/recall'){
      const body=await bodyJson(req);if(!String(body.query||'').trim())throw httpError(400,'query 不能为空');
      const [remember,watch]=await Promise.all([
        recall.recall(body.query,Math.min(5,Number(body.limit||5)),{threshold:body.threshold??0.35,maintenanceState:'remember'}),
        recall.recall(body.query,Math.min(5,Number(body.limit||5)),{threshold:body.threshold??0.35,maintenanceState:'watch'})
      ]);
      return send(res,200,{remember:remember.results,watch:watch.results,latencyMs:Math.max(remember.latencyMs,watch.latencyMs)});
    }
    if(req.method==='POST'&&url.pathname==='/api/recall'){
      const body=await bodyJson(req);if(!String(body.query||'').trim())throw httpError(400,'query 不能为空');
      return send(res,200,await recall.recall(body.query,Number(body.limit||3),{threshold:body.threshold,autoInjection:true,excludePendingDisputed:true,includeSuperseded:Boolean(body.include_superseded),memoryType:body.memory_type||null,timeRange:body.time_range||null,
        context:Array.isArray(body.context)?body.context.slice(-24):[],occurredAt:body.occurredAt,debug:body.debug===true}));
    }
    if(req.method==='POST'&&url.pathname==='/api/tools/search_memories'){
      const body=await bodyJson(req);if(!String(body.query||'').trim())throw httpError(400,'query 不能为空');
      return send(res,200,await recall.recall(body.query,Math.min(10,Number(body.limit||5)),{threshold:body.threshold??0.45,includeSuperseded:Boolean(body.include_superseded),memoryType:body.memory_type||null,timeRange:body.time_range||null}));
    }
    if(req.method==='POST'&&url.pathname==='/api/tools/report_memory_issue')return send(res,201,{issue:store.reportIssue(await bodyJson(req))});
    const memoryMatch=url.pathname.match(/^\/api\/(?:tools\/)?memories\/([^/]+)(?:\/(evidence|related|changes))?$/);
    const toolMatch=url.pathname.match(/^\/api\/tools\/(get_memory|get_memory_evidence|get_related_memories)\/([^/]+)$/);
    if(memoryMatch){const memoryId=decodeURIComponent(memoryMatch[1]);const part=memoryMatch[2];if(req.method==='PATCH'&&!part){const body=await bodyJson(req);const memory=store.reviseMemory(memoryId,body,body.reason||'测试网页手动更正');if(!memory)throw httpError(404,'记忆不存在');return send(res,200,{memory});}if(req.method==='GET'){if(part==='evidence')return send(res,200,{evidence:store.getEvidence(memoryId,{full:url.searchParams.get('full')==='true'})});if(part==='related')return send(res,200,{relations:store.getRelated(memoryId,Number(url.searchParams.get('limit')||10))});if(part==='changes')return send(res,200,{changes:store.getChanges(memoryId)});const memory=store.getMemory(memoryId);if(!memory)throw httpError(404,'记忆不存在');return send(res,200,{memory});}}
    if(toolMatch&&req.method==='GET'){const [,tool,memoryIdRaw]=toolMatch;const memoryId=decodeURIComponent(memoryIdRaw);if(tool==='get_memory'){const memory=store.getMemory(memoryId);if(!memory)throw httpError(404,'记忆不存在');return send(res,200,{memory,changes:store.getChanges(memoryId,10)});}if(tool==='get_memory_evidence')return send(res,200,{evidence:store.getEvidence(memoryId,{full:url.searchParams.get('full')==='true'})});return send(res,200,{relations:store.getRelated(memoryId,10)});}
    if(url.pathname.startsWith('/api/'))throw httpError(404,'API 不存在');
    return serveStatic(res,url.pathname);
  }catch(error){send(res,error.status||500,{error:error.message||String(error)});}
});

server.listen(port,host,()=>{
  console.log(`Memory Lab V2: http://${host}:${port}\nDB: ${dbPath}\nEmbedding: ${embedding.baseUrl}`);
  if(maintenance)void maintenance.initialize().then(()=>{
    maintenanceTimer=setInterval(()=>void maintenance.tick().catch((error)=>console.error(`Memory maintenance: ${error.message}`)),60_000);
    void maintenance.tick().catch((error)=>console.error(`Memory maintenance: ${error.message}`));
  }).catch((error)=>console.error(`Memory maintenance disabled: ${error.message}`));
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(maintenanceTimer)clearInterval(maintenanceTimer);
  server.close(()=>{void Promise.resolve(maintenance?.close()).finally(()=>{store.close();process.exit(0)});});
});

function cors(){return{'access-control-allow-origin':'*','access-control-allow-headers':'content-type','access-control-allow-methods':'GET,POST,PATCH,OPTIONS'}}
function send(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...cors()});res.end(JSON.stringify(data));}
function httpError(status,message){const error=new Error(message);error.status=status;return error;}
async function bodyJson(req){let body='';for await(const chunk of req){body+=chunk;if(body.length>8_000_000)throw httpError(413,'请求过大')}try{return JSON.parse(body||'{}')}catch{throw httpError(400,'JSON 无效')}}
function serveStatic(res,path){let filePath=path==='/'?'/index.html':path;filePath=resolve(webRoot,'.'+decodeURIComponent(filePath));if(!filePath.startsWith(resolve(webRoot))||!existsSync(filePath)){res.writeHead(404);return res.end('Not found')}const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};res.writeHead(200,{'content-type':types[extname(filePath)]||'application/octet-stream','cache-control':'no-store'});res.end(readFileSync(filePath));}
