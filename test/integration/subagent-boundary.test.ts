/** No model/network stand-ins for Pi itself: run the installed official TUI. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { shellEscape } from '../../pi-extension/subagents/tmux.ts';
import { cleanupSession } from './cleanup.ts';
import { integrationRuntime } from './runtime.ts';
import { createPiInbox, queuePiMessage } from '../../pi-extension/subagents/control.ts';

function launch(t:any, autoExit:boolean, prompt='') {
  const dir = mkdtempSync(join(tmpdir(),'pi-boundary-'));
  const session = `pi-boundary-${process.pid}-${Date.now()}`;
  t.after(() => cleanupSession(session,dir,{preserveArtifacts:true}));
  const config = join(dir,'config'); mkdirSync(config);
  writeFileSync(join(config,'settings.json'),JSON.stringify({retry:{enabled:true,maxRetries:1,baseDelayMs:10}}));
  const file = join(dir,'session.jsonl');
  createPiInbox(file,'boundary');
  const tmux = (...args: string[]) => execFileSync('tmux',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const pane = tmux('new-session','-d','-s',session,'-x','100','-y','30','-P','-F','#{pane_id}');
  const runtime = integrationRuntime();
  const fixture = resolve(import.meta.dirname,'fixtures/subagent-boundary.ts');
  tmux('respawn-pane','-k','-t',pane,`cd ${shellEscape(dir)} && env PATH=${shellEscape(runtime.path)} PI_OFFLINE=1 PI_CODING_AGENT_DIR=${shellEscape(config)} PI_BOUNDARY_DIR=${shellEscape(dir)} PI_SUBAGENT_SESSION=${shellEscape(file)} PI_SUBAGENT_ID=boundary PI_SUBAGENT_AUTO_EXIT=${autoExit?'1':'0'} ${shellEscape(runtime.executable)} -ne -ns -np -nc --no-mcp --approve --model boundary/probe -e ${shellEscape(fixture)} --session ${shellEscape(file)} ${prompt?shellEscape(prompt):''} 2>${shellEscape(join(dir,'stderr.log'))}; echo $? > ${shellEscape(join(dir,'exit'))}; sleep 30`);
  const until=async(check:()=>boolean)=>{
    const deadline=Date.now()+30000;
    while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(check(),tmux('capture-pane','-p','-t',pane));
  };
  return {dir,file,tmux,pane,until};
}

it('official Pi retries an error and runs a boundary continuation before reporting subagent completion', {timeout:45000}, async t => {
  const {dir,file,tmux,pane}=launch(t,true,'Probe completion');
  const deadline = Date.now()+30000;
  while (!existsSync(join(dir,'exit')) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(existsSync(join(dir,'exit')),tmux('capture-pane','-p','-t',pane));
  assert.equal(readFileSync(join(dir,'exit'),'utf8').trim(),'0',readFileSync(join(dir,'stderr.log'),'utf8'));
  const events = readFileSync(join(dir,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(events.filter(event=>event.event==='provider-request').length,3,JSON.stringify(events));
  assert.ok(events.filter(event=>event.event==='provider-request'||event.event==='agent-end').every(event=>!event.prematureExit),JSON.stringify(events));
  assert.deepEqual(events.filter(event=>event.event==='settled'),[{event:'settled',aborted:false,exitWritten:true}]);
  assert.equal(JSON.parse(readFileSync(file+'.exit','utf8')).type,'done');
  assert.ok(readFileSync(file,'utf8').includes('FINAL_SETTLED'));
  t.diagnostic('Official Pi retry and continuation evidence: '+dir);
});

it('official Pi child inbox survives actual reload and closes on quit', {timeout:45000},async t=>{
  const {dir,file,tmux,pane,until}=launch(t,false);
  const generation=()=>existsSync(join(dir,'generation'))?Number(readFileSync(join(dir,'generation'),'utf8')):0;
  await until(()=>generation()===1);
  tmux('send-keys','-t',pane,'/reload','Enter');
  await until(()=>generation()===2);
  queuePiMessage(file,'boundary',{message:'INBOX_RELOAD_PROOF',deliverAs:'steer'});
  await until(()=>existsSync(join(dir,'received')));
  assert.equal(readFileSync(join(dir,'received'),'utf8'),'INBOX_RELOAD_PROOF');
  const events=existsSync(join(dir,'events.jsonl'))?readFileSync(join(dir,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];
  assert.equal(events.filter(event=>event.event==='provider-request').length,0,'the input is handled without a provider request');
  tmux('send-keys','-t',pane,'/quit','Enter');
  await until(()=>existsSync(join(dir,'exit')));
  assert.throws(()=>queuePiMessage(file,'boundary',{message:'too late',deliverAs:'steer'}),/ENOENT/);
  t.diagnostic('Official Pi reload/quit control evidence: '+dir);
});
