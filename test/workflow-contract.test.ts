import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, deferred, script } from './helpers/workflow.ts';
import { buildWorkflowDescription } from '../pi-extension/subagents/workflow/authoring.ts';
import { listBundledWorkflows } from '../pi-extension/subagents/workflow/script.ts';
import { workflowSummary } from '../pi-extension/subagents/workflow/ui.ts';

it('VM clock stays fixed across budget, log and phase results, global aliases and resume', async t => {
  let wall = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => wall);
  const f = fixture(t, () => ({ text: 'done' }));
  const capture = `({ now: Date.now(), global: globalThis.Date.now(), date: +new Date(), ctor: (new (new Date(0).constructor)()).getTime(),
    perf: performance.now(), globalPerf: globalThis.performance.now(), stamp: new Date().toISOString(),
    explicit: new Date(args.asOf).toISOString() })`;
  const run = await f.manager.start({ source: script(`
    const before = ${capture};
    await phase('Second');
    await log('before answer');
    const after = ${capture};
    return { before, after, random: [Math.random(), Math.random()] };
  `), args: { asOf: '2020-01-02T03:04:05.000Z' } });
  wall += 60_000;
  const first = await run.execute();
  assert.equal(first.status, 'completed', first.error);
  const value = first.result as any;
  assert.deepEqual(value.before, {
    now: 1_700_000_000_000, global: 1_700_000_000_000, date: 1_700_000_000_000,
    ctor: 1_700_000_000_000, perf: 0, globalPerf: 0,
    stamp: new Date(1_700_000_000_000).toISOString(), explicit: '2020-01-02T03:04:05.000Z',
  });
  assert.deepEqual(value.after, value.before);
  wall += 86_400_000;
  const resumed = await (await f.reload().resume(run.runId)).execute();
  assert.equal(resumed.status, 'completed', resumed.error);
  assert.deepEqual(resumed.result, first.result, 'A different host time must not change script results');
  assert.equal(f.calls.length, 0);
});

it('time-dependent prompts and branches reuse all completed results after a process reload', async t => {
  let wall = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => wall);
  const f = fixture(t, request => { wall += 50_000; return { text: request.task }; });
  const source = script(`
    const first = await agent('date:' + globalThis.Date.now(), { label: 'first' });
    await log('settled');
    const second = await agent('constructor:' + (+new Date()), { label: 'second' });
    const branch = Date.now() === args.asOf ? 'original' : 'changed';
    return { first, second, branch, perf: performance.now() };
  `, 'clock-cache');
  const first = await (await f.manager.start({ source, args: { asOf: wall } })).execute();
  assert.equal(first.status, 'completed', first.error);
  assert.equal((first.result as any).branch, 'original');
  assert.equal(f.calls.length, 2);
  wall += 100_000;
  const resumed = await (await f.reload().resume(first.runId)).execute();
  assert.equal(resumed.status, 'completed', resumed.error);
  assert.deepEqual(resumed.result, first.result);
  assert.equal(f.calls.length, 2, 'Resume must not spend another model call because wall time changed');
  assert.ok(resumed.calls.every(call => call.cached));
});

it('live, disk and UI count completed, failed, skipped and aborted calls as settled', { timeout: 5000 }, async t => {
  const skipped = deferred<{ text: string }>();
  const aborted = deferred<{ text: string }>();
  const f = fixture(t, request => {
    if (request.task === 'complete') return { text: 'done', tokens: 3 };
    if (request.task === 'fail') return { error: 'failed', tokens: 5 };
    return request.task === 'skip' ? skipped.promise : aborted.promise;
  });
  const run = await f.manager.start({ source: script(`
    await agent('complete', { label: 'complete' });
    await agent('fail', { label: 'fail' });
    await parallel(['skip', 'abort'].map(task => () => agent(task, { label: task })));
  `), args: {} });
  const execution = run.execute();
  try {
    await f.waitForCall(call => call.task === 'abort');
    assert.equal(run.view().progress, 0.5, 'Failed calls have settled, queued/running calls have not');
    const skip = run.view().calls.find(call => call.label === 'skip')!;
    assert.equal(run.skip(skip.callKey), true);
    run.abort('contract abort');
    const live = await execution;
    const disk = f.reload().inspect(run.runId)!;
    assert.equal(live.status, 'aborted');
    assert.deepEqual(live.calls.map(call => call.status), ['completed', 'failed', 'skipped', 'aborted']);
    assert.equal(live.progress, 1);
    assert.equal(disk.progress, live.progress);
    assert.deepEqual(disk.calls.map(call => call.status), live.calls.map(call => call.status));
    assert.deepEqual(disk.usage, live.usage, 'Reload must preserve usage rather than report zero');
    for (const view of [live, disk]) assert.match(workflowSummary(view, 100).join('\n'), /4\/4 settled/);
    const journal = readFileSync(join(run.runDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(journal.length, 4, 'Abort must persist every unsettled call exactly once');
    assert.equal(new Set(journal.map(entry => entry.callKey)).size, 4);
    const complete = live.calls.find(call => call.status === 'completed')!;
    assert.equal(run.skip(complete.callKey), false, 'A settled call cannot be overwritten by Skip');
  } finally {
    skipped.resolve({ text: 'late skip result' });
    aborted.resolve({ text: 'late abort result' });
    await execution;
    await new Promise(resolve => setImmediate(resolve));
    const disk = f.reload().inspect(run.runId)!;
    assert.deepEqual(disk.calls.map(call => call.status), ['completed', 'failed', 'skipped', 'aborted']);
    assert.equal(readFileSync(join(run.runDir, 'journal.jsonl'), 'utf8').trim().split('\n').length, 4, 'Late completions must not append replacement outcomes');
  }
});

it('tool discovery names come from the same bundled catalogue as list', () => {
  const { workflows, errors } = listBundledWorkflows();
  assert.deepEqual(errors, []);
  const description = buildWorkflowDescription();
  const listed = /Bundled templates: ([^.]+)\./.exec(description)![1].split(', ');
  assert.deepEqual(listed, workflows.map(entry => entry.name));
});
