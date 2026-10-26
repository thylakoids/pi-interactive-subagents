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

it('official Pi retries an error and runs a boundary continuation before reporting subagent completion', {timeout:45000}, async t => {
  const dir = mkdtempSync(join(tmpdir(),'pi-boundary-'));
  const session = `pi-boundary-${process.pid}-${Date.now()}`;
  t.after(() => cleanupSession(session,dir,{preserveArtifacts:true}));
  const config = join(dir,'config'); mkdirSync(config);
  writeFileSync(join(config,'settings.json'),JSON.stringify({retry:{enabled:true,maxRetries:1,baseDelayMs:10}}));
  const file = join(dir,'session.jsonl');
  const tmux = (...args: string[]) => execFileSync('tmux',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const pane = tmux('new-session','-d','-s',session,'-x','100','-y','30','-P','-F','#{pane_id}');
  const runtime = integrationRuntime();
  const fixture = resolve(import.meta.dirname,'fixtures/subagent-boundary.ts');
  tmux('respawn-pane','-k','-t',pane,`cd ${shellEscape(dir)} && env PATH=${shellEscape(runtime.path)} PI_OFFLINE=1 PI_CODING_AGENT_DIR=${shellEscape(config)} PI_BOUNDARY_DIR=${shellEscape(dir)} PI_SUBAGENT_SESSION=${shellEscape(file)} PI_SUBAGENT_AUTO_EXIT=1 ${shellEscape(runtime.executable)} -ne -ns -np -nc --no-mcp --approve --model boundary/probe -e ${shellEscape(fixture)} --session ${shellEscape(file)} 'Probe completion' 2>${shellEscape(join(dir,'stderr.log'))}; echo $? > ${shellEscape(join(dir,'exit'))}; sleep 30`);
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
