import { it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { getLeafId, summarizeSession } from '../pi-extension/subagents/session.ts';

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(),'pi-branch-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file = join(dir,'session.jsonl'), timestamp = new Date().toISOString();
  const message = (id: string,parentId: string|null,role: string,text: string,model='branch-model') => ({type:'message',id,parentId,timestamp,
    message:{role,content:[{type:'text',text}],model,usage:{input:10,output:2,totalTokens:id==='a1'?120:300,cost:{total:0.01}}}});
  const rows:any[] = [{type:'session',version:3,id:randomUUID(),timestamp,cwd:dir},
    message('u1',null,'user','Initial task'),message('a1','u1','assistant','Answer A'),
    message('u2','a1','user','Another path'),message('a2','u2','assistant','Abandoned answer B','abandoned-model'),
    {type:'branch_summary',id:'back',parentId:'a1',fromId:'a2',summary:'Returned to A',timestamp}];
  writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  return {file,rows,message,append:(row:any)=>appendFileSync(file,JSON.stringify(row)+'\n')};
}

it('branch results and current context match official Pi, while actual spend includes abandoned work',t=>{
  const f=fixture(t);
  const official=SessionManager.open(f.file);
  assert.deepEqual(official.getBranch().map(entry=>entry.id),['u1','a1','back']);
  const expected=(official.getBranch().findLast((entry:any)=>entry.message?.role==='assistant') as any).message.content[0].text;
  const result=summarizeSession(f.file);
  assert.equal(result.summary,expected);
  assert.equal(result.stats.model,'branch-model');
  assert.equal(result.stats.contextTokens,120);
  assert.equal(result.stats.inputTokens,20,'both model calls actually ran');
  assert.equal(result.stats.outputTokens,4);
  assert.equal(result.stats.cost,0.02);
  assert.equal(getLeafId(f.file),'back');
});

it('a new empty branch cannot return an abandoned answer or old text on Resume',t=>{
  const f=fixture(t);
  f.append(f.message('new-root',null,'user','Independent task'));
  assert.equal(summarizeSession(f.file).summary,null);
  assert.equal(summarizeSession(f.file).stats.contextTokens,0);
  assert.equal(summarizeSession(f.file).stats.model,null);
  assert.equal(summarizeSession(f.file,f.rows.length).summary,null);
  f.append(f.message('new-answer','new-root','assistant','New branch answer'));
  assert.equal(summarizeSession(f.file,f.rows.length).summary,'New branch answer');
});

it('repeated branch switches and a new failed turn never select a different branch',t=>{
  const f=fixture(t);
  f.append({type:'custom',id:'again',parentId:'a2',customType:'branch-marker'});
  assert.equal(summarizeSession(f.file).summary,'Abandoned answer B');
  f.append({type:'custom',id:'return',parentId:'a1',customType:'branch-marker'});
  assert.equal(summarizeSession(f.file).summary,'Answer A');
  assert.equal(summarizeSession(f.file,f.rows.length).summary,null,'selected answer predates this Resume');
  f.append({type:'message',id:'error',parentId:'return',message:{role:'assistant',content:[],model:'branch-model',stopReason:'error',errorMessage:'retry exhausted'}});
  const result=summarizeSession(f.file,f.rows.length);
  assert.equal(result.summary,'Subagent error: retry exhausted');
  assert.equal(result.stats.contextTokens,120,'a response with no usage does not erase the last measured context');
});
