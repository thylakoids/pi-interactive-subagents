import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, script } from './helpers/workflow.ts';

it('a no-work resume preserves lifetime spend and attempt counters through subsequent reloads', async t => {
  const f = fixture(t, () => ({ error: 'billed failure', tokens: 12 }));
  const run = await f.manager.start({ source: script("return await agent('failed');"), args: {} });
  await run.execute();
  for (let reload = 0; reload < 3; reload++) {
    const view = await (await f.reload().resume(run.runId, { source: script('return budget.spent();') })).execute();
    assert.equal(view.status, 'completed', view.error);
    assert.equal(view.result, 12);
    const snapshot = JSON.parse(readFileSync(join(view.runDir, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.spentTokens, 12);
    assert.equal(snapshot.agentAttempts, 1);
  }
  assert.equal(f.calls.length, 1);
});

for (const staleSnapshot of [true, false]) it('SIGKILL recovery charges durable failed journal records (stale snapshot=' + staleSnapshot + ')', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-crash-accounting-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helper = new URL('./helpers/workflow.ts', import.meta.url).href;
  const file = join(dir, 'crash.mjs');
  writeFileSync(file, `import {fixture,script} from ${JSON.stringify(helper)};
import {existsSync} from 'node:fs'; import {join} from 'node:path';
const f=fixture({after(){}},(_request,index)=>index===0?{error:'billed failure',tokens:12}:new Promise(()=>{}),{budgetTotal:100});
const original=f.service.spawn; let count=0; let run;
f.service.spawn=async request=>{const handle=await original(request);if(++count===2)console.log(JSON.stringify({dir:f.dir,runId:run.runId}));return handle;};
${staleSnapshot ? `const timer=setInterval(()=>{if(run && existsSync(join(run.runDir,'journal.jsonl'))){clearInterval(timer);console.log(JSON.stringify({dir:f.dir,runId:run.runId}));}},5);` : ''}
run=await f.manager.start({source:script(${JSON.stringify(staleSnapshot ? "await agent('failed'); while(true){}" : "await agent('failed'); return await agent('pending');")}),args:{}});
await run.execute();
`);
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const details = await new Promise<{ dir: string; runId: string }>((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', data => {
      stdout += data;
      if (stdout.includes('\n')) {
        try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); }
      }
    });
    child.on('error', reject);
    void closed.then(() => reject(new Error('child exited before journal evidence: ' + stderr)));
  });
  t.after(() => rmSync(details.dir, { recursive: true, force: true }));
  const runDir = join(details.dir, 'workflows', details.runId);
  assert.match(readFileSync(join(runDir, 'journal.jsonl'), 'utf8'), /billed failure/);
  if (staleSnapshot) assert.equal(JSON.parse(readFileSync(join(runDir, 'snapshot.json'), 'utf8')).spentTokens, 0, 'prove the killed process has not persisted its latest spend');
  child.kill('SIGKILL');
  await closed;
  const f = fixture(t, () => ({ text: 'must not launch' }), { baseDir: details.dir, cwd: details.dir, agentDir: details.dir });
  for (let reload = 0; reload < 2; reload++) {
    const view = await (await f.reload().resume(details.runId, { source: script('return budget.spent();') })).execute();
    assert.equal(view.status, 'completed', view.error);
    assert.equal(view.result, 12, 'a completed journal append survives a killed owner without a fresh snapshot');
    assert.equal(JSON.parse(readFileSync(join(view.runDir, 'snapshot.json'), 'utf8')).agentAttempts, staleSnapshot ? 1 : 2, 'admitted attempts survive both stale accounting and an in-flight kill');
  }
  assert.equal(f.calls.length, 0);
});
