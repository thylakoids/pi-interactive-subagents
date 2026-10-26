import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import child from '../pi-extension/subagents/subagent-done.ts';

function fixture(t: any, autoExit = true) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-settlement-'));
  const keys = ['PI_SUBAGENT_SESSION', 'PI_SUBAGENT_AUTO_EXIT', 'PI_SUBAGENT_ID', 'PI_SUBAGENT_ACTIVITY_FILE'];
  const saved = keys.map(key => process.env[key]);
  const file = join(dir, 'session.jsonl');
  Object.assign(process.env, {PI_SUBAGENT_SESSION:file,PI_SUBAGENT_AUTO_EXIT:autoExit ? '1' : '0',PI_SUBAGENT_ID:'settlement',PI_SUBAGENT_ACTIVITY_FILE:join(dir,'activity.json')});
  const events = new Map<string, Function[]>();
  child({on(name: string,fn: Function){events.set(name,[...events.get(name)??[],fn]);},registerTool(){},registerShortcut(){}} as any);
  let exits = 0;
  const emit = (name: string,event: any = {}) => events.get(name)?.forEach(fn=>fn(event,{shutdown(){exits++;}}));
  t.after(()=>{
    emit('session_shutdown',{reason:'reload'});
    keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];});
    rmSync(dir,{recursive:true,force:true});
  });
  return {file,emit,get exits(){return exits;},sidecar:()=>JSON.parse(readFileSync(file+'.exit','utf8'))};
}

it('retryable errors and intermediate agent_end events cannot publish completion', t => {
  const f = fixture(t);
  f.emit('agent_start');
  f.emit('agent_end',{messages:[{role:'assistant',stopReason:'error',errorMessage:'529 overloaded'}]});
  assert.equal(f.exits,0);
  assert.equal(existsSync(f.file+'.exit'),false);
  f.emit('agent_start');
  f.emit('agent_end',{messages:[{role:'assistant',stopReason:'stop',content:[{type:'text',text:'recovered'}]}]});
  assert.equal(f.exits,0);
  f.emit('agent_settled',{aborted:false});
  assert.equal(f.exits,1);
  assert.deepEqual(f.sidecar(),{type:'done'});
});

it('final retry exhaustion reports the latest error only after settlement', t => {
  const f = fixture(t);
  f.emit('agent_end',{messages:[{role:'assistant',stopReason:'error',errorMessage:'529 exhausted'}]});
  assert.equal(existsSync(f.file+'.exit'),false);
  f.emit('agent_settled',{aborted:false});
  assert.equal(f.exits,1);
  assert.deepEqual(f.sidecar(),{type:'error',errorMessage:'529 exhausted',stopReason:'error'});
});

it('Escape leaves an autonomous child available for input; the next completed run can exit', t => {
  const f = fixture(t);
  f.emit('agent_end',{messages:[{role:'assistant',stopReason:'aborted'}]});
  f.emit('agent_settled',{aborted:true});
  assert.equal(f.exits,0);
  assert.equal(existsSync(f.file+'.exit'),false);
  f.emit('agent_start');
  f.emit('agent_end',{messages:[{role:'assistant',stopReason:'stop'}]});
  f.emit('agent_settled',{aborted:false});
  assert.equal(f.exits,1);
});

it('interactive Focus stays open after settlement without publishing terminal completion', t => {
  const f = fixture(t,false);
  f.emit('agent_end',{messages:[{role:'assistant',stopReason:'stop'}]});
  f.emit('agent_settled',{aborted:false});
  assert.equal(f.exits,0);
  assert.equal(existsSync(f.file+'.exit'),false);
});
