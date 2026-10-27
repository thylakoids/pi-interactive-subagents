import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs, { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fixture, script } from './helpers/workflow.ts';
import { probeWorkflowCache } from './helpers/workflow-cache-probe.ts';

it('parallel settles synchronous thunk throws and still invokes every sibling', async t => {
  const f = fixture(t, request => ({ text: request.task }));
  const run = await f.manager.start({ args: {}, source: script(`return await parallel([
    () => { throw new Error('synchronous failure'); },
    () => agent('sibling after the throw'),
    () => 'synchronous value',
    async () => { throw new Error('asynchronous failure'); },
    () => agent('last sibling'),
  ]);`) });
  const view = await run.execute();
  assert.equal(view.status, 'completed', view.error);
  assert.deepEqual(view.result, [null, 'sibling after the throw', 'synchronous value', null, 'last sibling']);
  assert.equal(f.calls.length, 2);
});

for (const primitive of ['parallel', 'pipeline']) {
  it(primitive + ' still fails the run on tagged workflow author errors', async t => {
    const f = fixture(t, () => ({ text: 'unused' }));
    const expression = primitive === 'parallel'
      ? "parallel([() => agent('task', { agent: 'missing-agent' })])"
      : "pipeline([1], () => agent('task', { agent: 'missing-agent' }))";
    const view = await (await f.manager.start({ source: script('return await ' + expression), args: {} })).execute();
    assert.equal(view.status, 'failed');
    assert.match(view.error!, /unknown agent "missing-agent"/);
    assert.equal(f.calls.length, 0);
  });
}

it('parallel preserves a synchronous tagged author error as fatal', async t => {
  const f = fixture(t, () => ({ text: 'unused' }));
  const view = await (await f.manager.start({ args: {}, source: script(`return await parallel([
    () => { const error = new Error('tagged author failure'); error.workflowAuthorError = true; throw error; },
    () => 1,
  ]);`) })).execute();
  assert.equal(view.status, 'failed');
  assert.match(view.error!, /tagged author failure/);
});

it('cache namespace indexing traverses each key once across a complete replay', async () => {
  for (const size of [128, 1024]) {
    const result = await probeWorkflowCache(size);
    assert.equal(result.keyVisits, size, 'namespace selection must be O(cache size + calls), not repeated full scans');
  }
});

it('a failed resume preserves the stored script and releases its execution lock', async t => {
  const f = fixture(t, request => ({ text: request.task }));
  const source = script("return await agent('original task');");
  const before = await (await f.manager.start({ source, args: {} })).execute();
  const journal = join(before.runDir, 'journal.jsonl');
  const backup = journal + '.backup';
  renameSync(journal, backup);
  mkdirSync(journal);
  try {
    await assert.rejects(f.reload().resume(before.runId, { source: script("return await agent('edited task');") }), { code: 'EISDIR' });
    assert.equal(readFileSync(before.scriptPath, 'utf8'), source, 'validation failure must not publish the edit');
  } finally {
    rmdirSync(journal);
    renameSync(backup, journal);
  }
  const resumed = await (await f.reload().resume(before.runId)).execute();
  assert.equal(resumed.status, 'completed', resumed.error);
  assert.equal(resumed.result, 'original task');
  assert.equal(f.calls.length, 1, 'failed resume must preserve the old recovery inputs');
});

it('a script publication failure preserves recovery inputs and releases the lock', async t => {
  const f = fixture(t, () => ({ text: 'unused' }));
  const source = script('return 1;');
  const before = await (await f.manager.start({ source, args: {} })).execute();
  const originalRename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === before.scriptPath) throw new Error('injected script publication failure');
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.reload().resume(before.runId, { source: script('return 2;') }), /injected script publication failure/);
    assert.equal(readFileSync(before.scriptPath, 'utf8'), source);
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
  const resumed = await (await f.reload().resume(before.runId)).execute();
  assert.equal(resumed.status, 'completed', resumed.error);
  assert.equal(resumed.result, 1);
});

it('a validated edited script is atomically published and survives the next resume', async t => {
  const f = fixture(t, () => ({ text: 'unused' }));
  const source = script('return args.original;');
  const before = await (await f.manager.start({ source, args: { original: 1 } })).execute();
  const fd = openSync(before.scriptPath, 'r');
  const edited = script('return args.edited;');
  try {
    const resumed = await f.reload().resume(before.runId, { source: edited, args: { edited: 2 } });
    assert.equal(readFileSync(fd, 'utf8'), source, 'the original inode stays intact until the new script is renamed into place');
    assert.equal(readFileSync(before.scriptPath, 'utf8'), edited);
    assert.equal((await resumed.execute()).result, 2);
  } finally { closeSync(fd); }
  const again = await (await f.reload().resume(before.runId)).execute();
  assert.equal(again.status, 'completed', again.error);
  assert.equal(again.result, 2);
});
