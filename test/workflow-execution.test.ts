import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WorkflowManager } from '../pi-extension/subagents/workflow/manager.ts';
import { deferred, fixture, script } from './helpers/workflow.ts';

it('resume reaps a verified dead owner before allowing replacement work', async t => {
  let reaped = false;
  const f = fixture(t, () => {
    assert.equal(reaped, true, 'old processes must stop before replacement side effects');
    return { text: 'replacement' };
  });
  const run = await f.manager.start({ source: script('return "initial";'), args: {} });
  await run.execute();
  const module = new URL('../pi-extension/subagents/workflow/journal.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {acquireLock} from ${JSON.stringify(module)};
    process.send(acquireLock(${JSON.stringify(run.runDir)}, 'old-owner'));
    setInterval(()=>{},1000);
  `], { stdio: ['ignore','ignore','pipe','ipc'] });
  const closed = once(child, 'close');
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  const [lock] = await once(child, 'message') as any[];
  assert.equal(lock.ok, true);
  f.service.ownership = { current: () => 'new-owner', reap(owner) {
    assert.equal(owner, 'old-owner');
    reaped = true;
  } };
  await assert.rejects(f.reload().resume(run.runId), /locked by process/);
  assert.equal(reaped, false, 'a live owner must never be reaped');
  child.kill('SIGKILL'); await closed;
  const resumed = await f.reload().resume(run.runId, { source: script('return await agent("replacement");') });
  assert.equal(reaped, true, 'resume must not depend on a concurrently scheduled guardian');
  assert.equal((await resumed.execute()).result, 'replacement');
});

it('overlapping and repeated execute calls share one VM and one settlement', async t => {
  const gate = deferred<void>();
  let settlements = 0;
  const f = fixture(t, async () => { await gate.promise; return { text: 'once' }; }, {
    onSettled: () => { settlements++; },
  });
  const run = await f.manager.start({ source: script('return await agent("effect");'), args: {} });
  const first = run.execute();
  const overlapping = run.execute();
  await f.waitForCall(() => true);
  gate.resolve();
  const [a, b] = await Promise.all([first, overlapping]);
  assert.equal(a.status, 'completed', a.error);
  assert.equal(b.result, 'once');
  assert.equal((await run.execute()).result, 'once');
  assert.equal(f.calls.length, 1, 'execute must not repeat side effects');
  assert.equal(settlements, 1);
});

it('concurrent execute callers observe one abort and disk resume retries only once', async t => {
  const gate = deferred<void>();
  const f = fixture(t, async (_request, index) => {
    if (index === 0) await gate.promise;
    return { text: 'resumed' };
  });
  const run = await f.manager.start({ source: script('return await agent("effect");'), args: {} });
  const first = run.execute(), second = run.execute();
  await f.waitForCall(() => true);
  run.abort();
  assert.deepEqual((await Promise.all([first, second])).map(view => view.status), ['aborted', 'aborted']);
  gate.resolve();
  const resumed = await f.reload().resume(run.runId);
  assert.equal((await resumed.execute()).result, 'resumed');
  assert.equal(f.calls.length, 2);
});

it('edit-and-resume applies new metadata to agent selection and persists it', async t => {
  const f = fixture(t, request => ({ text: request.agentType }));
  const run = await f.manager.start({ source: script('return "initial";'), args: {} });
  await run.execute();
  const edited = script('return await agent("new task");', 'edited').replace('"agent":"worker"', '"agent":"scout"');
  const resumed = await f.reload().resume(run.runId, { source: edited });
  const view = await resumed.execute();
  assert.equal(view.result, 'scout');
  assert.equal(view.meta.name, 'edited');
  const again = await f.reload().resume(run.runId);
  assert.equal((await again.execute()).result, 'scout');
  assert.equal(f.calls.length, 1, 'the edited script is replayed on subsequent resume');
});

it('resume preserves an unbounded budget even if the new manager has a ceiling', async t => {
  const f = fixture(t, () => ({ text: 'ok' }));
  const run = await f.manager.start({ source: script('return budget.total;'), args: {} });
  assert.equal((await run.execute()).result, null);
  const limited = new WorkflowManager({ baseDir: f.dir, cwd: f.dir, sessionFile: '', sessionId: 'reload', agentDir: f.dir, service: f.service, budgetTotal: 1 });
  const resumed = await limited.resume(run.runId);
  assert.equal((await resumed.execute()).result, null, 'resume cannot change the original budget');
});

for (const budgetTotal of [0, null]) {
  it(`explicit ${budgetTotal} removes the manager default budget`, async t => {
    const f = fixture(t, () => ({ text: 'ok', tokens: 2 }), { budgetTotal: 1 });
    const run = await f.manager.start({ source: script('await agent("a"); await agent("b"); return budget.total;'), args: {}, budgetTotal });
    const view = await run.execute();
    assert.equal(view.status, 'completed', view.error);
    assert.equal(view.result, null);
    assert.equal(f.calls.length, 2);
  });
}
