import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowSubagentService } from '../pi-extension/subagents/wiring.ts';
import { __test__ } from '../pi-extension/subagents/index.ts';
import { deferred } from './helpers/workflow.ts';
import { existsSync } from 'node:fs';
import { createVerifyScratch, cleanupVerifyScratch } from '../pi-extension/subagents/workflow/readonly.ts';

function surfaceFixture() {
  const names: Record<string, { sessionFile: string }> = {};
  const closed: string[] = [];
  const surface: any = {
    reservedNames: __test__.reservedNames,
    runningSubagents: new Map(),
    sessionSnapshot: () => ({ sessionFile: '/parent.jsonl', sessionId: 'review', sessionDir: '/tmp/review' }),
    getArtifactDir: () => '/tmp/review-artifacts', cwd: () => '/tmp',
    readNameRegistry: () => names,
    registerName(_dir: string, name: string, value: { sessionFile: string }) { names[name] = value; },
    closeSurface: (pane: string) => closed.push(pane), startWidgetRefresh() {},
    async launch(params: { name: string }) {
      return { id: params.name, name: params.name, sessionFile: '/absent-child.jsonl', surface: 'owned-test-surface' };
    },
    async watch() { return { exitCode: 0, summary: 'done', elapsed: 0 }; },
  };
  return { surface, names, closed };
}

it('reserves a workflow launch before await so manual and concurrent launches cannot alias it', async () => {
  const { surface, closed } = surfaceFixture();
  const manual = 'review-manual-exact';
  assert.equal(__test__.reserveRunningName(manual, new Set(), true), manual);
  try {
    assert.throws(() => __test__.reserveRunningName(manual, new Set(), true), /already in use/);
    assert.throws(() => __test__.reserveRunningName('persisted-name', new Set(['persisted-name']), true), /already in use/);
  } finally { __test__.reservedNames.delete(manual); }
  const gate = deferred<void>();
  const launch = surface.launch;
  surface.launch = async (params: any) => { await gate.promise; return launch(params); };
  const service = createWorkflowSubagentService(surface);
  const other = createWorkflowSubagentService(surface);
  const name = 'review-pending-reservation';
  const pending = service.spawn({ agentType: 'worker', name, task: 'test' });
  try {
    assert.equal(surface.reservedNames.has(name), true);
    assert.ok(service.takenNames().has(name));
    assert.ok(other.takenNames().has(name));
    assert.notEqual(__test__.uniqueRunningName(name, new Set()), name, 'the real manual naming path must see the claim');
    assert.throws(() => __test__.reserveRunningName(name, new Set(), true), /already in use/, 'explicit manual names must not bypass pending claims');
    await assert.rejects(other.spawn({ agentType: 'worker', name, task: 'duplicate' }), /already in use/);
  } finally { gate.resolve(); }
  const handle = await pending;
  await handle.completion;
  assert.equal(surface.reservedNames.has(name), false, 'the durable name registry replaces the pending claim');
  assert.ok(service.takenNames().has(name));
  let launches = 0;
  surface.launch = async () => { launches++; throw new Error('launch cancelled'); };
  await assert.rejects(service.spawn({ agentType: 'worker', name, task: 'duplicate registered session' }), /already in use/);
  assert.equal(launches, 0, 'a persisted name is rejected before opening a child');

  const failed = 'review-failed-reservation';
  await assert.rejects(service.spawn({ agentType: 'worker', name: failed, task: 'test' }), /launch cancelled/);
  assert.equal(surface.reservedNames.has(failed), false);
  assert.equal(service.takenNames().has(failed), false);
  assert.equal(__test__.uniqueRunningName(failed, new Set()), failed);
  assert.deepEqual(closed, [], 'a failed pending launch cannot close another surface');
});

for (const fault of ['registry', 'watcher']) {
  it('closes its owned child if ' + fault + ' setup fails after launch', async t => {
    const { surface, closed } = surfaceFixture();
    const scratch = createVerifyScratch();
    t.after(() => cleanupVerifyScratch(scratch));
    const launch = surface.launch;
    surface.launch = async (params: any) => {
      const running = await launch(params);
      running.verifyScratchDir = scratch;
      surface.runningSubagents.set(running.id, running);
      return running;
    };
    if (fault === 'registry') surface.registerName = () => { throw new Error('EACCES registry'); };
    else surface.watch = () => { throw new Error('watcher failed'); };
    const name = 'review-' + fault + '-reservation';
    await assert.rejects(createWorkflowSubagentService(surface).spawn({ agentType: 'worker', name, task: 'test' }), /EACCES|watcher failed/);
    assert.equal(surface.reservedNames.has(name), false);
    assert.deepEqual(closed, ['owned-test-surface']);
    assert.equal(surface.runningSubagents.size, 0, 'failed setup must not leave an unwatched running entry');
    assert.equal(existsSync(scratch), false, 'failed setup must release its private verification scratch');
  });
}
