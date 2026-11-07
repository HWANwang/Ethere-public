import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexMaintenanceBackend } from '../src/codex-maintenance-backend.mjs';

test('压缩尚未结束时后台窗口等待并在原线程继续，不新建线程', async () => {
  let attempts=0;
  const listeners=new Set();
  const client={
    async initialize() {},
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async request(method) {
      if(method==='thread/resume') return { thread:{ id:'existing-screen' } };
      if(method!=='turn/start') throw new Error(`unexpected ${method}`);
      attempts++;
      if(attempts<=2) throw new Error('failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }');
      queueMicrotask(()=>{
        for(const listener of listeners) listener({method:'item/completed',params:{threadId:'existing-screen',turnId:'turn-1',item:{type:'agentMessage',text:'{"remember":[],"watch":[]}'}}});
        for(const listener of listeners) listener({method:'turn/completed',params:{threadId:'existing-screen',turn:{id:'turn-1',status:'completed'}}});
      });
      return { turn:{ id:'turn-1' } };
    },
  };
  const backend=new CodexMaintenanceBackend({ cwd:'.',client,timeoutMs:15000 });
  const output=await backend.turn('existing-screen','本批原始来源');
  assert.equal(attempts,3);
  assert.equal(output,'{"remember":[],"watch":[]}');
  assert.equal(listeners.size,0);
});
