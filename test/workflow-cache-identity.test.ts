import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deferred, fixture, script } from './helpers/workflow.ts';
import { callKey, legacyCallKey } from '../pi-extension/subagents/workflow/journal.ts';

const identity = { kind: 'agent', label: 'before', prompt: 'same task', agent: 'worker' };

it('labels are cosmetic but permissions, model, effort and isolation are cache identity', () => {
  assert.equal(callKey(identity), callKey({ ...identity, label: 'after' }));
  for (const variant of [{ readOnly: true }, { isolation: 'worktree' as const }, { model: 'explicit-model' }, { effort: 'high' }, { agent: 'scout' }]) {
    assert.notEqual(callKey(identity), callKey({ ...identity, ...variant }));
  }
  assert.notEqual(legacyCallKey(identity), legacyCallKey({ ...identity, label: 'after' }));
});

it('renaming labels replays each independent sample after a process reload', async t => {
  const f = fixture(t, (_request, index) => ({ text: 'independent-sample-' + index }));
  const source = (labels: string[]) => script(`return await parallel(${JSON.stringify(labels)}.map(label => () => agent('same task', {label})));`);
  const before = await (await f.manager.start({ source: source(['one', 'two', 'three']), args: {} })).execute();
  assert.equal(before.status, 'completed', before.error);
  assert.equal(new Set(before.calls.map(call => call.callKey)).size, 3);
  assert.deepEqual(before.result, ['independent-sample-0', 'independent-sample-1', 'independent-sample-2']);
  const after = await (await f.reload().resume(before.runId, { source: source(['renamed-one', 'renamed-two', 'renamed-three']) })).execute();
  assert.equal(after.status, 'completed', after.error);
  assert.equal(f.calls.length, 3, 'display-only edits must not repeat side effects');
  assert.deepEqual(after.result, before.result);
  assert.ok(after.calls.every(call => call.cached));
  assert.deepEqual(after.calls.map(call => call.label), ['renamed-one', 'renamed-two', 'renamed-three']);
});

it('old label-bearing journal keys still replay without relaunching workers', async t => {
  const f = fixture(t, () => ({ text: 'old-answer' }));
  const run = await f.manager.start({ source: script("return await agent('same task', {label:'before'});"), args: {} });
  const before = await run.execute();
  const file = join(before.runDir, 'journal.jsonl');
  const entry = JSON.parse(readFileSync(file, 'utf8').trim());
  entry.callKey = legacyCallKey(identity);
  writeFileSync(file, JSON.stringify(entry) + '\n');
  const after = await (await f.reload().resume(run.runId)).execute();
  assert.equal(after.status, 'completed', after.error);
  assert.equal(after.result, 'old-answer');
  assert.equal(f.calls.length, 1);
  assert.equal(after.calls[0].cached, true);
});

it('start is fresh unless reuse:auto is explicitly requested', async t => {
  const f = fixture(t, (_request, index) => ({ text: 'sample-' + index }));
  const source = script("return await agent('same task');");
  const first = await (await f.manager.start({ source, args: {} })).execute();
  const fresh = await (await f.manager.start({ source, args: {} })).execute();
  assert.equal(first.status, 'completed', first.error);
  assert.equal(fresh.status, 'completed', fresh.error);
  assert.equal(fresh.resumedFrom, undefined);
  assert.equal(fresh.result, 'sample-1');
  assert.equal(f.calls.length, 2);
  const reused = await (await f.manager.start({ source, args: {}, reuse: 'auto' })).execute();
  assert.equal(reused.result, fresh.result);
  assert.equal(reused.resumedFrom, fresh.runId);
  assert.equal(f.calls.length, 2);
});

it('borrowed results survive disk resume of the new run without repeating work or historical spend', async t => {
  const gate = deferred<void>();
  let block = true;
  const f = fixture(t, async request => {
    if (request.task === 'new work' && block) await gate.promise;
    return { text: request.task, tokens: 300 };
  }, { budgetTotal: 400 });
  t.after(() => gate.resolve());
  const firstSource = script("return await agent('borrowed work');", 'borrowed-result');
  const before = await (await f.manager.start({ source: firstSource, args: {} })).execute();
  assert.equal(before.status, 'completed', before.error);
  const secondSource = script("const old=await agent('borrowed work'); const next=await agent('new work'); return {old,next,spent:budget.spent()};", 'borrowed-result');
  const run = await f.manager.start({ source: secondSource, args: {}, reuse: 'auto' });
  const pending = run.execute();
  await f.waitForCall(request => request.task === 'new work');
  run.abort('test interruption');
  assert.equal((await pending).status, 'aborted');
  block = false;
  gate.resolve();
  const resumed = await (await f.reload().resume(run.runId)).execute();
  assert.equal(resumed.status, 'completed', resumed.error);
  assert.deepEqual(resumed.result, { old: 'borrowed work', next: 'new work', spent: 300 });
  assert.equal(f.calls.filter(call => call.task === 'borrowed work').length, 1, 'a new run must journal borrowed answers before later interruption');
  assert.equal(resumed.calls.find(call => call.label === 'worker' && call.cached)?.cached, true);
});
