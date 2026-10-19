import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deferred, fixture, script } from './helpers/workflow.ts';

const journal = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

it('does not retry a failed call by default', async t => {
  const f = fixture(t, () => ({ error: 'actual failure', tokens: 7 }));
  const view = await (await f.manager.start({ source: script("return await agent('task');"), args: {} })).execute();
  assert.equal(view.status, 'completed', view.error);
  assert.equal(view.result, null);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(journal(view.runDir).map(entry => entry.status), ['failed']);
});

it('opt-in retries keep attempt evidence and charge all attempts once, including after reload', async t => {
  const f = fixture(t, (_request, index) => index === 0 ? { error: 'provider failed', tokens: 7 } : { text: 'recovered', tokens: 11 });
  const source = script("const value=await agent('task',{retries:1}); return {value,spent:budget.spent()};");
  const run = await f.manager.start({ source, args: {} });
  const view = await run.execute();
  assert.equal(view.status, 'completed', view.error);
  assert.deepEqual(view.result, { value: 'recovered', spent: 18 });
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].name, f.calls[1].name);
  const rows = journal(view.runDir);
  assert.deepEqual(rows.map(entry => entry.status), ['failed', 'completed']);
  assert.equal(rows[0].callKey, rows[1].callKey);
  assert.equal(rows[1].usage.totalTokens, 18, 'last entry retains cumulative call spend');
  for (let reload = 0; reload < 2; reload++) {
    const after = await (await f.reload().resume(run.runId)).execute();
    assert.equal(after.status, 'completed', after.error);
    assert.deepEqual(after.result, view.result, 'resume must not erase this run usage by marking it borrowed');
  }
  assert.equal(f.calls.length, 2);
  assert.equal(journal(view.runDir).length, 2, 'same-run replay must not append borrowed records');
});

it('an active-time ceiling stops the stalled attempt and permits an explicit retry', { timeout: 5000 }, async t => {
  const gate = deferred<void>();
  t.after(() => gate.resolve());
  const f = fixture(t, async (_request, index) => {
    if (!index) await gate.promise;
    return { text: 'recovered' };
  });
  const run = await f.manager.start({ source: script("return await agent('task',{retries:1,stallTimeoutMs:1000});"), args: {} });
  const view = await run.execute();
  assert.equal(view.status, 'completed', view.error);
  assert.equal(view.result, 'recovered');
  assert.equal(f.calls.length, 2);
  assert.ok(f.stopped.includes(f.calls[0].name));
  assert.deepEqual(journal(view.runDir).map(entry => entry.status), ['failed', 'completed']);
});

for (const action of ['abort', 'skip']) {
  it(action + ' while waiting prevents retries even after a late completion', async t => {
    const gate = deferred<void>();
    t.after(() => gate.resolve());
    const f = fixture(t, async () => { await gate.promise; return { error: 'late failure' }; });
    f.service.status = () => ({ kind: 'waiting', detail: 'waiting for parent' });
    const run = await f.manager.start({ source: script("return await agent('question',{retries:3,stallTimeoutMs:1000});"), args: {} });
    const execution = run.execute();
    await f.waitForCall(() => true);
    if (action === 'abort') run.abort('user cancelled');
    else assert.equal(run.skip(run.view().calls[0].callKey), true);
    const view = await execution;
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(view.status, action === 'abort' ? 'aborted' : 'completed');
    assert.equal(f.calls.length, 1);
    assert.deepEqual(journal(view.runDir).map(entry => entry.status), [action === 'abort' ? 'aborted' : 'skipped']);
  });
}

it('question waits are exempt from the explicit active-time ceiling', { timeout: 5000 }, async t => {
  const gate = deferred<void>();
  t.after(() => gate.resolve());
  const f = fixture(t, async () => { await gate.promise; return { text: 'answered' }; });
  f.service.status = () => ({ kind: 'waiting', detail: 'waiting for parent' });
  const run = await f.manager.start({ source: script("return await agent('question',{retries:1,stallTimeoutMs:1000});"), args: {} });
  const execution = run.execute();
  await f.waitForCall(() => true);
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(f.calls.length, 1);
  assert.equal(f.stopped.length, 0);
  gate.resolve();
  assert.equal((await execution).result, 'answered');
});

it('failed attempt spend stops retries and remains charged on resume', async t => {
  const f = fixture(t, () => ({ error: 'failed after billing', tokens: 12 }), { budgetTotal: 10 });
  const run = await f.manager.start({ source: script("return await agent('task',{retries:3});"), args: {} });
  const first = await run.execute();
  assert.equal(first.status, 'failed');
  assert.match(first.error!, /budget exhausted/);
  assert.equal(f.calls.length, 1);
  const after = await (await f.reload().resume(run.runId)).execute();
  assert.equal(after.status, 'failed');
  assert.match(after.error!, /budget exhausted/);
  assert.equal(f.calls.length, 1, 'resume must not reset failed-attempt spend');
});

it('retry clears a failed attempt structured sidecar rather than accepting its stale result', async t => {
  const f = fixture(t, (request, index) => {
    if (index === 0) {
      writeFileSync(request.resultFile!, JSON.stringify({ ok: true, value: { answer: 'STALE' } }));
      return { error: 'crashed after sidecar' };
    }
    return { text: 'no structured tool was called' };
  });
  const spawn = f.service.spawn.bind(f.service);
  let launches = 0;
  f.service.spawn = request => spawn(launches++ ? { ...request, resultFile: undefined } : request);
  const run = await f.manager.start({ source: script("return await agent('task',{retries:1,schema:{type:'object',properties:{answer:{type:'string'}},required:['answer']}});"), args: {} });
  const view = await run.execute();
  assert.equal(view.status, 'completed', view.error);
  assert.equal(view.result, null);
  assert.equal(f.calls.length, 2);
  assert.equal(view.calls[0].status, 'failed');
  assert.match(view.calls[0].error!, /without calling structured_output/);
  assert.equal(existsSync(join(view.runDir, 'calls', view.calls[0].callKey, 'result.json')), false);
});

for (const opts of [{ retries: -1 }, { retries: 6 }, { retries: 0.5 }, { stallTimeoutMs: 0 }, { stallTimeoutMs: 999 }, { stallTimeoutMs: 21600001 }]) {
  it('rejects invalid retry options before launching: ' + JSON.stringify(opts), async t => {
    const f = fixture(t, () => ({ text: 'must not run' }));
    const view = await (await f.manager.start({ source: script(`return await agent('task',${JSON.stringify(opts)});`), args: {} })).execute();
    assert.equal(view.status, 'failed');
    assert.match(view.error!, /retries|stallTimeoutMs/);
    assert.equal(f.calls.length, 0);
  });
}
