import { it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/workflow.ts';
import { workflowExecution, WORKFLOW_EXECUTION_CONTRACT } from '../pi-extension/subagents/workflow/execution.ts';
import { createWorkflowSubagentService } from '../pi-extension/subagents/wiring.ts';
import { __test__ } from '../pi-extension/subagents/index.ts';

const source = (body: string, agent?: string) => `export const meta = ${JSON.stringify({ name: 'worker-compat', description: 'compatibility', ...(agent ? { agent } : {}) })}\n${body}`;
const allow = (f: ReturnType<typeof fixture>, names: string[]) => {
  f.service.allowedAgents = () => ({ allowed: names, unknown: name => !names.includes(name) });
};

it('default workflow uses worker even when a user legacy definition exists', async t => {
  const f = fixture(t, () => ({ text: 'result' }));
  const view = await (await f.manager.start({ source: source("return await agent('task')"), args: {} })).execute();
  assert.equal(view.status, 'completed', view.error);
  assert.equal(f.calls[0].agentType, 'worker');
});

for (const spelling of ['meta', 'agent', 'agentType']) {
  it('old ' + spelling + ' workflow-subagent name resolves to worker without a separate definition', async t => {
    const f = fixture(t, () => ({ text: 'legacy-result' }));
    allow(f, ['worker']);
    const body = spelling === 'meta' ? "return await agent('task')" : `return await agent('task', { ${spelling}: 'workflow-subagent' })`;
    const view = await (await f.manager.start({ source: source(body, spelling === 'meta' ? 'workflow-subagent' : undefined), args: {} })).execute();
    assert.equal(view.status, 'completed', view.error);
    assert.equal(view.result, 'legacy-result');
    assert.equal(f.calls[0].agentType, 'worker');
  });
}

it('an explicit user legacy definition is preserved, not silently replaced', async t => {
  const f = fixture(t, () => ({ text: 'custom' }));
  const view = await (await f.manager.start({ source: source("return await agent('task', { agent: 'workflow-subagent' })"), args: {} })).execute();
  assert.equal(view.status, 'completed', view.error);
  assert.equal(f.calls[0].agentType, 'workflow-subagent');
});

for (const firstFails of [false, true]) {
  it('old default journals resume without repeating completed calls (first fails=' + firstFails + ')', async t => {
    const f = fixture(t, (_request, index) => firstFails && index === 0 ? { error: 'interrupted' } : { text: 'sample-' + index });
    // Simulate the shipped old default without copying the journal/key algorithm.
    allow(f, ['workflow-subagent']);
    const run = await f.manager.start({ source: source("const a = await agent('same'); const b = await agent('same'); return [a, b]"), args: {} });
    const before = await run.execute();
    assert.equal(before.status, 'completed', before.error);
    allow(f, ['worker']);
    const resumed = await (await f.reload().resume(run.runId)).execute();
    assert.equal(resumed.status, 'completed', resumed.error);
    assert.equal(f.calls.length, firstFails ? 3 : 2);
    assert.equal((resumed.result as any[])[1], (before.result as any[])[1]);
    const oldCompleted = before.calls.find(call => call.status === 'completed')!;
    assert.equal(resumed.calls.find(call => call.callKey === oldCompleted.callKey)!.cached, true);
    if (!firstFails) assert.deepEqual(resumed.result, before.result);
    else assert.equal(f.calls[2].agentType, 'worker');
  });
}

it('legacy alias still enforces worker authorization', async t => {
  const f = fixture(t, () => ({ text: 'must not spawn' }));
  allow(f, ['scout']);
  const view = await (await f.manager.start({ source: source("return await agent('task', { agent: 'workflow-subagent' })"), args: {} })).execute();
  assert.equal(view.status, 'failed');
  assert.match(view.error!, /unknown agent "worker"/);
  assert.equal(f.calls.length, 0);
});

it('workflow policy restores questions and declared delegation without granting undeclared agents', () => {
  const worker = __test__.loadAgentDefaults('worker')!;
  const policy = workflowExecution({ ...worker, tools: worker.tools + ',workflow,*' });
  for (const restored of ['subagent', 'subagents_list', 'subagent_message', 'ask_question']) {
    assert.ok(policy.toolAllowlist.split(',').includes(restored), restored);
  }
  for (const blocked of ['workflow', '*']) assert.ok(!policy.toolAllowlist.split(',').includes(blocked));
  assert.deepEqual(policy.spawnable, ['scout', 'researcher']);
  assert.ok(policy.identity.endsWith(WORKFLOW_EXECUTION_CONTRACT));
  assert.equal(policy.interactive, false);
  assert.equal(policy.autoExit, true);
  assert.equal(policy.sessionMode, 'lineage-only');
  const unprivileged = workflowExecution({ tools: 'read,subagent,subagent_message,subagents_list' });
  assert.deepEqual(unprivileged.toolAllowlist.split(','), ['read', 'ask_question']);
  assert.equal(unprivileged.spawnable, null);
});

it('production workflow adapter always enables the runtime contract, even with legacy false flags', async () => {
  let options: any;
  const surface: any = {
    sessionSnapshot: () => ({ sessionFile: '/tmp/parent.jsonl', sessionDir: '/tmp', sessionId: 'parent' }),
    cwd: () => '/tmp', getArtifactDir: () => '/tmp', registerName() {}, startWidgetRefresh() {},
    runningSubagents: new Map(), readNameRegistry: () => ({}),
    async launch(_params: any, _ctx: any, opts: any) { options = opts; return { id: 'id', name: 'step', sessionFile: '/tmp/step.jsonl' }; },
    async watch() { return { exitCode: 0, summary: 'data', elapsed: 0 }; },
  };
  const service = createWorkflowSubagentService(surface);
  const handle = await service.spawn({ agentType: 'worker', name: 'step', task: 'task', outputIsData: false, nonInteractive: false });
  await handle.completion;
  assert.equal(options.workflow, true);
  assert.equal(options.nonInteractive, true);
  assert.equal(options.outputIsData, true);
});

it('an existing explicit legacy script resumes its original completed result through the alias', async t => {
  const f = fixture(t, () => ({ text: 'saved-result' }));
  allow(f, ['workflow-subagent']);
  const run = await f.manager.start({ source: source("return await agent('task', { agentType: 'workflow-subagent', model: 'chosen/model', effort: 'low' })"), args: {} });
  const before = await run.execute();
  assert.equal(before.status, 'completed', before.error);
  allow(f, ['worker']);
  const resumed = await (await f.reload().resume(run.runId)).execute();
  assert.equal(resumed.status, 'completed', resumed.error);
  assert.equal(resumed.result, 'saved-result');
  assert.equal(f.calls.length, 1, 'Removing the bundled definition must not spend another call on resume');
  assert.equal(resumed.calls[0].cached, true);
  assert.equal(resumed.calls[0].agentType, 'worker');
});
