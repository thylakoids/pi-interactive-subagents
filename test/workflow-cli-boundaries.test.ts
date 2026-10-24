import { it } from 'node:test';
import assert from 'node:assert/strict';
import { assertExternalOptions } from '../pi-extension/subagents/external-cli.ts';
import { CLI_WORKFLOW_EXECUTION_CONTRACT, WORKFLOW_EXECUTION_CONTRACT } from '../pi-extension/subagents/workflow/execution.ts';
import { fixture, script } from './helpers/workflow.ts';

it('native CLI options reject Pi-only settings and effort rather than dropping them', () => {
  for (const kind of ['claude', 'codex'] as const) {
    for (const settings of [{ tools: 'read' }, { skills: 'review' }, { subagentAgents: ['worker'] }, { extraExtensions: ['extension.ts'] }]) {
      assert.throws(() => assertExternalOptions(kind, settings), /does not support Pi/);
    }
    assert.throws(() => assertExternalOptions(kind, { thinking: 'off' }), /does not support effort/);
    assert.doesNotThrow(() => assertExternalOptions(kind, {}));
    assert.doesNotThrow(() => assertExternalOptions(kind, { thinking: 'high' }));
  }
  assert.throws(() => assertExternalOptions('claude', { thinking: 'minimal' }), /does not support effort/);
  assert.doesNotThrow(() => assertExternalOptions('codex', { thinking: 'minimal' }));
});

it('native workflow contract does not promise unavailable parent protocols', () => {
  assert.match(WORKFLOW_EXECUTION_CONTRACT, /call ask_question/);
  assert.doesNotMatch(CLI_WORKFLOW_EXECUTION_CONTRACT, /call ask_question|may delegate|call it exactly once/);
  assert.match(CLI_WORKFLOW_EXECUTION_CONTRACT, /not available/);
  assert.match(CLI_WORKFLOW_EXECUTION_CONTRACT, /Do not delegate/);
  assert.match(CLI_WORKFLOW_EXECUTION_CONTRACT, /new conversation/);
});

it('malformed model, effort and schema options fail rather than running with defaults', async t => {
  const f = fixture(t, () => { assert.fail('malformed options must not launch'); });
  for (const kind of ['pi', 'cli'] as const) {
    f.service.agentKind = () => kind;
    for (const opts of [{ model: 123 }, { model: '' }, { effort: false }, { effort: '' }, { schema: false }, { schema: [] }, { schema: null }]) {
      const run = await f.manager.start({ source: script(`return await agent("task", ${JSON.stringify(opts)});`), args: {}, reuse: 'none' });
      const result = await run.execute();
      assert.equal(result.status, 'failed', JSON.stringify(opts));
      assert.match(result.error!, /must be (a non-empty string|an object)/);
    }
  }
  assert.equal(f.calls.length, 0);
});

it('budgeted native calls fail before spawn, including after workflow resume', async t => {
  const f = fixture(t, () => { assert.fail('unsupported calls must not launch'); });
  f.service.agentKind = () => 'cli';
  const run = await f.manager.start({ source: script('return await agent("task");'), args: {}, budgetTotal: 1000 });
  const failed = await run.execute();
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /Token budgets require Pi/);
  const again = await (await f.reload().resume(run.runId)).execute();
  assert.equal(again.status, 'failed');
  assert.match(again.error!, /Token budgets require Pi/);
  assert.equal(f.calls.length, 0);
});
