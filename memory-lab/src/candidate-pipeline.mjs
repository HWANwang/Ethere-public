import { cosine } from './embedding-client.mjs';

export function buildSceneWindows(records,{maxChars=1500,overlapRecords=2,maxGapMs=20*60_000}={}){
  const rows=records.filter(row=>String(row.content||'').trim());
  const windows=[];let current=[];let chars=0;let previousAt=null;
  for(const row of rows){
    const at=Date.parse(row.occurredAt||row.occurred_at||'');
    const size=String(row.content).length+48;
    const gap=Number.isFinite(at)&&Number.isFinite(previousAt)?at-previousAt:0;
    if(current.length&&(chars+size>maxChars||gap>maxGapMs)){
      windows.push(current);
      current=current.slice(-overlapRecords);
      chars=current.reduce((n,x)=>n+String(x.content).length+48,0);
    }
    current.push(row);chars+=size;if(Number.isFinite(at))previousAt=at;
  }
  if(current.length)windows.push(current);
  return windows;
}

export function normalizeCandidate(candidate){
  return {
    ...candidate,
    statement:String(candidate.statement||'').replace(/\s+/g,' ').trim(),
    evidence_refs:[...new Set((candidate.evidence_refs||[]).map(String))],
    evidence_shape:['direct_stable','meaningful_event','pattern_occurrence','transient_daily'].includes(candidate.evidence_shape)?candidate.evidence_shape:'pattern_occurrence'
  };
}

export async function semanticDedupe(candidates,embedding,{threshold=.72,requireEvidenceOverlap=true}={}){
  const normalized=candidates.map(normalizeCandidate).filter(x=>x.statement);
  if(!normalized.length)return {kept:[],duplicates:[]};
  const {vectors}=await embedding.embed(normalized.map(x=>x.statement));
  const kept=[];const duplicates=[];
  for(let i=0;i<normalized.length;i++){
    let best=null;
    for(const existing of kept){
      const score=cosine(vectors[i],existing.vector);
      const overlap=intersectionSize(new Set(normalized[i].evidence_refs),new Set(existing.candidate.evidence_refs));
      if((!requireEvidenceOverlap||overlap>0)&&(!best||score>best.score))best={existing,score,overlap};
    }
    if(best&&best.score>=threshold){
      best.existing.candidate.evidence_refs=[...new Set([...best.existing.candidate.evidence_refs,...normalized[i].evidence_refs])];
      duplicates.push({candidate:normalized[i],keptId:best.existing.candidate.id||null,score:best.score});
    }else kept.push({candidate:normalized[i],vector:vectors[i]});
  }
  return {kept:kept.map(x=>x.candidate),duplicates};
}

function intersectionSize(a,b){let n=0;for(const x of a)if(b.has(x))n++;return n;}

export function lifecycleFromEvidenceShape(shape){
  if(shape==='direct_stable'||shape==='meaningful_event')return 'remember';
  if(shape==='pattern_occurrence')return 'watch';
  return 'discard';
}

