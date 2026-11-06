import './tmux-isolation.ts';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import extension, { __test__, type RunningSubagent } from '../../pi-extension/subagents/index.ts';
import { createPiInbox, isPiLaunchInterrupted, queuePiMessage } from '../../pi-extension/subagents/control.ts';
import { getSessionId, registerName, readNameRegistry, writeSubagentLoadout } from '../../pi-extension/subagents/session.ts';
import { inspectNamedSubagent } from '../../pi-extension/subagents/lifecycle.ts';
import { createStatusState, classifyStatus } from '../../pi-extension/subagents/status.ts';
import { captureSurfaceOwnership, createSurface, shellEscape, surfaceExists } from '../../pi-extension/subagents/tmux.ts';
import { integrationRuntime } from './runtime.ts';

const tmux = (...args: string[]) => execFileSync('tmux', args, {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function until(check: () => boolean, diagnostic: () => string) {
  const end = Date.now()+25000;
  while (!check() && Date.now()<end) await new Promise(resolve=>setTimeout(resolve,25));
  assert.ok(check(), diagnostic());
}
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-interrupt-'));
  const config = join(dir,'config'); mkdirSync(config);
  const provider = resolve(import.meta.dirname,'fixtures/subagent-interrupt.ts');
  writeFileSync(join(config,'settings.json'),JSON.stringify({extensions:[provider],retry:{enabled:false},compaction:{enabled:false}}));
  const session = 'interrupt-'+process.pid+'-'+Date.now();
  const parent = tmux('new-session','-d','-s',session,'-P','-F','#{pane_id}','sleep 86400');
  const sibling = tmux('new-window','-d','-t',session+':','-P','-F','#{pane_id}','sleep 86400');
  const parentFile = join(dir,'parent.jsonl'); writeFileSync(parentFile,JSON.stringify({type:'session',id:'parent-session'})+'\n');
  const artifactDir = join(dir,'artifacts','parent-session');
  const tools = new Map<string,any>(), handlers = new Map<string,Function[]>(), sent: any[] = [];
  extension({on(name:string,fn:Function){handlers.set(name,[...handlers.get(name)??[],fn]);},
    registerTool(tool:any){tools.set(tool.name,tool);},registerCommand(){},registerShortcut(){},registerMessageRenderer(){},
    getThinkingLevel(){return 'off';},sendMessage(message:any){sent.push(message);}} as any);
  const ctx:any = {cwd:dir,hasUI:false,mode:'json',ui:{notify(){},setWidget(){}},sessionManager:{
    getSessionFile:()=>parentFile,getSessionDir:()=>dir,getSessionId:()=>'parent-session'}};
  for (const fn of handlers.get('session_start')??[]) fn({},ctx);
  const runtime=integrationRuntime();
  const previous = { PATH:process.env.PATH, PI_INTERRUPT_DIR:process.env.PI_INTERRUPT_DIR, TMUX_PANE:process.env.TMUX_PANE, PI_SUBAGENT_TREE:process.env.PI_SUBAGENT_TREE };
  Object.assign(process.env,{PATH:runtime.path,PI_INTERRUPT_DIR:dir,TMUX_PANE:parent,PI_SUBAGENT_TREE:parent});
  t.after(async()=>{
    for (const fn of handlers.get('session_shutdown')??[]) await fn({},ctx);
    try{tmux('kill-session','-t',session);}catch{}
    for(const [key,value] of Object.entries(previous)) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
    rmSync(dir,{recursive:true,force:true});
  });
  const call=(name:string,args:any)=>tools.get(name).execute('interrupt-test',args,new AbortController().signal,undefined,ctx);
  async function spawn(name='streaming') {
    const id=name+'-launch', file=join(dir,name+'.jsonl');
    const pane=tmux('new-window','-d','-t',session+':','-P','-F','#{pane_id}');
    tmux('set-option','-p','-t',pane,'@pi_subagent_owner','interrupt-test');
    tmux('set-option','-p','-t',pane,'@pi_subagent_parent',parent);
    createPiInbox(file,id);
    const done=resolve(import.meta.dirname,'../../pi-extension/subagents/subagent-done.ts');
    const env={PATH:runtime.path,PI_CODING_AGENT_DIR:config,PI_INTERRUPT_DIR:dir,PI_OFFLINE:'1',PI_SUBAGENT_SESSION:file,PI_SUBAGENT_ID:id,PI_SUBAGENT_AUTO_EXIT:'1'};
    const command=`cd ${shellEscape(dir)} && env ${Object.entries(env).map(([k,v])=>k+'='+shellEscape(v)).join(' ')} ${shellEscape(runtime.executable)} -ns -np -nc --no-mcp --approve --model interrupt-probe/probe --thinking off -e ${shellEscape(done)} --session ${shellEscape(file)} BLOCK_GENERATION 2>${shellEscape(join(dir,'stderr'))}; sleep 86400`;
    tmux('respawn-pane','-k','-t',pane,command);
    await until(()=>existsSync(join(dir,'generating-'+id)),()=>tmux('capture-pane','-p','-t',pane));
    const running:RunningSubagent={id,name,surface:pane,sessionFile:file,task:'BLOCK_GENERATION',startTime:Date.now(),interactive:false,statusState:createStatusState({source:'pi',startTimeMs:Date.now()})};
    __test__.trackRunningSubagent(running,artifactDir);
    writeSubagentLoadout(file,{agent:null,toolAllowlist:null,model:'interrupt-probe/probe',thinking:'off',systemPromptMode:null,identity:null,spawnable:null,autoExit:true,cwd:dir,agentDir:config});
    return running;
  }
  return {dir,parent,sibling,artifactDir,tools,call,spawn,sent};
}

it('Escape interrupts real Pi generation, watcher retires the launch without done, and name resumes its saved JSONL', {timeout:60000}, async t=>{
  const f=fixture(t), running=await f.spawn();
  assert.equal(f.tools.has('subagent_stop'),false);
  const before=readFileSync(running.sessionFile,'utf8'), id=getSessionId(running.sessionFile);
  const stale=await f.call('subagent_interrupt',{name:running.name,id:'old-id'});
  assert.equal(stale.details.requested,false);
  assert.equal(isPiLaunchInterrupted(running.sessionFile,running.id),false);
  const request=await f.call('subagent_interrupt',{name:running.name,id:running.id});
  assert.equal(request.details.requested,true);
  assert.equal(request.details.state,'interrupt_requested');
  assert.notEqual(classifyStatus(running.statusState,Date.now()).kind,'active');
  // Before invoking watcher cleanup, independently observe Pi receive Escape
  // while its provider is still pending (no steer or tool completion boundary).
  await until(()=>existsSync(join(f.dir,'aborted')),()=>tmux('capture-pane','-p','-t',running.surface));
  assert.match(readFileSync(join(f.dir,'aborted'),'utf8'),/streaming-launch/);
  const savedTmux=process.env.TMUX;
  process.env.TMUX=join(f.dir,'temporarily-unavailable')+',999,0';
  let settled=false;
  const watching=__test__.watchSubagent(running,new AbortController().signal).then(result=>{settled=true;return result;});
  try {
    await new Promise(resolve=>setTimeout(resolve,75));
    assert.equal(settled,false,'unavailable cleanup cannot publish final interrupted yet');
    assert.equal(__test__.runningSubagents.has(running.id),true);
  } finally {process.env.TMUX=savedTmux;}
  const result=await watching;
  assert.equal(result.error,'interrupted'); assert.equal(result.exitCode,1);
  assert.match(__test__.resolveResultPresentation(result,running.name),/interrupted/);
  assert.doesNotMatch(__test__.resolveResultPresentation(result,running.name),/completed/);
  assert.equal(__test__.runningSubagents.has(running.id),false);
  assert.equal(surfaceExists(running.surface),false);
  assert.ok(surfaceExists(f.parent)&&surfaceExists(f.sibling),'unrelated panes survive');
  assert.equal(inspectNamedSubagent(f.artifactDir,running.name).state,'interrupted');
  assert.ok(readFileSync(running.sessionFile,'utf8').startsWith(before),'saved history survives');
  assert.throws(()=>queuePiMessage(running.sessionFile,running.id,{message:'late',deliverAs:'steer'}),/interrupted/);
  assert.match((await f.call('subagent_message',{name:running.name,message:'late'})).details.error,/late reply/);
  const repeated=await f.call('subagent_interrupt',{name:running.name,id:running.id});
  assert.equal(repeated.details.state,'interrupted');
  const resumed=await f.call('subagent_message',{name:running.name,message:'RESUME_WITH_RESULT',resume:true});
  assert.equal(resumed.details.status,'started',JSON.stringify(resumed));
  assert.notEqual(resumed.details.id,running.id);
  assert.equal(resumed.details.sessionFile,running.sessionFile);
  assert.equal(resumed.details.sessionId,id);
  await until(()=>!__test__.runningSubagents.size,()=>JSON.stringify(readNameRegistry(f.artifactDir)));
  assert.match(readFileSync(running.sessionFile,'utf8'),/RESUMED_RESULT/);
  assert.equal(inspectNamedSubagent(f.artifactDir,running.name).state,'finished');
});

it('stale ownership refuses Escape; legacy unconfirmed stop with final activity can resume without old proof', {timeout:40000}, async t=>{
  const f=fixture(t), running=await f.spawn();
  const ownership=captureSurfaceOwnership(running.surface);
  tmux('set-option','-p','-t',running.surface,'@pi_subagent_owner','another-owner');
  assert.equal((await f.call('subagent_interrupt',{name:running.name})).details.requested,false);
  assert.equal(isPiLaunchInterrupted(running.sessionFile,running.id),false);
  assert.equal((await __test__.cleanupRunningSubagent(running)).closed,false,'changing only the ownership tag cannot prove the old writer exited');
  assert.equal(__test__.runningSubagents.has(running.id),true);
  tmux('set-option','-p','-t',running.surface,'@pi_subagent_owner',ownership.owner);
  running.cli='codex';
  const entry=readNameRegistry(f.artifactDir)[running.name];
  registerName(f.artifactDir,running.name,{...entry,execution:{...entry.execution!,backend:'codex'}});
  assert.match((await f.call('subagent_interrupt',{name:running.name})).details.reason,/unsupported/);
  running.cli=undefined; registerName(f.artifactDir,running.name,entry);
  await f.call('subagent_interrupt',{name:running.name});
  await __test__.watchSubagent(running,new AbortController().signal);
  const activityFile=join(f.dir,'legacy-activity.json');
  writeFileSync(activityFile,JSON.stringify({version:1,runningChildId:running.id,createdAt:1,updatedAt:2,sequence:2,latestEvent:'session_shutdown',phase:'done',agentActive:false,turnActive:false,providerActive:false,toolActive:false}));
  registerName(f.artifactDir,running.name,{...entry,execution:{id:running.id,backend:'pi',startedAt:1,activityFile,stop:{requestedAt:2,reason:'Owned surfaces cleaned; historical descendants cannot be verified'}}});
  assert.doesNotThrow(()=>inspectNamedSubagent(f.artifactDir,running.name));
  const resumed=await f.call('subagent_message',{name:running.name,resume:true,message:'RESUME_WITH_RESULT'});
  assert.equal(resumed.details.status,'started',JSON.stringify(resumed));
  await until(()=>!__test__.runningSubagents.size,()=>JSON.stringify(readNameRegistry(f.artifactDir)));
});

/** Hold the actual async tmux kill invocation, leaving synchronous observations
 * and unrelated commands live so another operation can race the cleanup. */
function holdPaneClose(f: ReturnType<typeof fixture>) {
  const realTmux=execFileSync('sh',['-c','command -v tmux'],{encoding:'utf8'}).trim();
  const bin=join(f.dir,'bin');mkdirSync(bin);
  const entered=join(f.dir,'close-entered'), release=join(f.dir,'close-release');
  writeFileSync(join(bin,'tmux'),`#!/bin/sh
case "$*" in
  *if-shell*kill-pane*)
    : > ${shellEscape(entered)}
    for attempt in $(seq 1 1000); do
      test -f ${shellEscape(release)} && break
      sleep 0.01
    done
    ;;
esac
exec ${shellEscape(realTmux)} "$@"
`,{mode:0o755});
  const previous=process.env.PATH;process.env.PATH=bin+':'+previous;
  return {entered,release,restore(){writeFileSync(release,'release');process.env.PATH=previous;}};
}
function shellLaunch(f:ReturnType<typeof fixture>, name:string, surface?:string) {
  const pane=surface??tmux('new-window','-d','-t',tmux('display-message','-p','-t',f.parent,'#{session_id}')+':','-P','-F','#{pane_id}','sleep 86400');
  if(!surface) {
    tmux('set-option','-p','-t',pane,'@pi_subagent_owner','interrupt-test');
    tmux('set-option','-p','-t',pane,'@pi_subagent_parent',f.parent);
  }
  const file=join(f.dir,name+'.jsonl');writeFileSync(file,JSON.stringify({type:'session',id:name+'-session'})+'\n');
  const running:RunningSubagent={id:name+'-launch',name,surface:pane,sessionFile:file,task:name,startTime:Date.now(),interactive:false,
    statusState:createStatusState({source:'pi',startTimeMs:Date.now()})};
  return running;
}

for(const phase of ['after-request','during-cleanup'] as const) {
  it('an old watcher preserves a respawned pane '+phase,{timeout:15000},async t=>{
    const f=fixture(t), running=shellLaunch(f,'replacement');
    __test__.trackRunningSubagent(running,f.artifactDir);
    const original=running.surfaceOwnership!;
    const request=await f.call('subagent_interrupt',{name:running.name});
    assert.equal(request.details.requested,true);
    const hold=phase==='during-cleanup'?holdPaneClose(f):undefined;
    let watching:Promise<any>|undefined;
    try {
      if(hold) {
        watching=__test__.watchSubagent(running,new AbortController().signal);
        await until(()=>existsSync(hold.entered),()=>JSON.stringify(readNameRegistry(f.artifactDir)));
      }
      tmux('respawn-pane','-k','-t',running.surface,'sleep 86400');
      const replacement=captureSurfaceOwnership(running.surface);
      assert.notEqual(replacement.panePid,original.panePid);
      hold?.restore();
      const result=await (watching??__test__.watchSubagent(running,new AbortController().signal));
      assert.equal(result.error,'interrupted');
      assert.equal(surfaceExists(running.surface),true,'the new pane process survives old cleanup');
      assert.deepEqual(captureSurfaceOwnership(running.surface),replacement);
      assert.equal(__test__.runningSubagents.has(running.id),false);
    } finally {hold?.restore();}
  });
}

it('an interrupt accepted during normal completion cleanup wins over a prepared success',{timeout:15000},async t=>{
  const f=fixture(t),running=shellLaunch(f,'finishing');
  __test__.trackRunningSubagent(running,f.artifactDir);
  writeFileSync(running.sessionFile+'.exit',JSON.stringify({type:'done'}));
  const hold=holdPaneClose(f);
  try {
    const watching=__test__.watchSubagent(running,new AbortController().signal);
    await until(()=>existsSync(hold.entered),()=>JSON.stringify(readNameRegistry(f.artifactDir)));
    const request=await f.call('subagent_interrupt',{name:running.name,id:running.id});
    assert.equal(request.details.requested,true);
    hold.restore();
    const result=await watching;
    assert.equal(result.exitCode,1);assert.equal(result.error,'interrupted');
    assert.equal(inspectNamedSubagent(f.artifactDir,running.name).state,'interrupted');
    assert.doesNotMatch(__test__.resolveResultPresentation(result,running.name),/completed/);
  } finally {hold.restore();}
});

it('a failed first ownership query uses the creation identity and later cleanup converges',{timeout:15000},async t=>{
  const f=fixture(t),pane=createSurface('capture-retry'),running=shellLaunch(f,'capture-retry',pane);
  const expected=captureSurfaceOwnership(pane),savedTmux=process.env.TMUX;
  try {
    process.env.TMUX=join(f.dir,'missing-socket')+',999,0';
    __test__.trackRunningSubagent(running,f.artifactDir);
  } finally {process.env.TMUX=savedTmux;}
  assert.deepEqual(running.surfaceOwnership,expected,'query failure keeps the immutable creation identity');
  const request=await f.call('subagent_interrupt',{name:running.name});
  assert.equal(request.details.requested,true);
  const result=await __test__.watchSubagent(running,new AbortController().signal);
  assert.equal(result.error,'interrupted');
  assert.equal(__test__.runningSubagents.has(running.id),false);
  assert.equal(surfaceExists(pane),false);
});

it('a launch without any identity never adopts a replacement and retires when its pane disappears',{timeout:15000},async t=>{
  const f=fixture(t),running=shellLaunch(f,'unverified'),savedTmux=process.env.TMUX;
  try {
    process.env.TMUX=join(f.dir,'missing-socket')+',999,0';
    __test__.trackRunningSubagent(running,f.artifactDir);
  } finally {process.env.TMUX=savedTmux;}
  assert.equal(running.surfaceOwnership,undefined);
  assert.equal((await __test__.cleanupRunningSubagent(running)).closed,false);
  tmux('respawn-pane','-k','-t',running.surface,'sleep 86400');
  const replacement=captureSurfaceOwnership(running.surface);
  assert.equal((await __test__.cleanupRunningSubagent(running)).closed,false);
  assert.deepEqual(captureSurfaceOwnership(running.surface),replacement,'unverified cleanup never closes a new process');
  tmux('kill-pane','-t',running.surface);
  writeFileSync(running.sessionFile+'.exit',JSON.stringify({type:'done'}));
  await __test__.watchSubagent(running,new AbortController().signal);
  assert.equal(__test__.runningSubagents.has(running.id),false);
  assert.equal(inspectNamedSubagent(f.artifactDir,running.name).state,'finished');
});
