import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, script } from './helpers/workflow.ts';
import extension, { __test__, SubagentLaunchCancelledError } from '../pi-extension/subagents/index.ts';
import { createWorkflowSubagentService } from '../pi-extension/subagents/wiring.ts';
import { WORKFLOW_GLOBAL_DECLARATIONS } from '../pi-extension/subagents/workflow/runner.ts';

it('a cancelled message call cannot steer or reopen a session', async () => {
  const tools = new Map<string, any>();
  extension({
    on() {}, getThinkingLevel: () => 'off', getAllTools: () => [],
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
  } as any);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(tools.get('subagent_message').execute('cancelled', { name: 'original', message: 'reply' }, cancelled.signal, undefined, undefined), SubagentLaunchCancelledError);
});

it('readOnly reaches the service and cannot reuse a writable cached result', async t => {
  assert.match(WORKFLOW_GLOBAL_DECLARATIONS, /readOnly\?: boolean/);
  const f = fixture(t, request => ({ text: request.readOnly ? 'readonly' : 'writable' }));
  const source = (flag: string) => script(`return await agent('same task', {label:'same'${flag}});`, 'permissions-cache');
  const writable = await f.manager.start({ source: source(''), args: {}, reuse: 'none' });
  assert.equal((await writable.execute()).result, 'writable');
  const restricted = await f.manager.resume(writable.runId, { source: source(',readOnly:true') });
  const view = await restricted.execute();
  assert.equal(view.status, 'completed', view.error);
  assert.equal(view.result, 'readonly');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].readOnly, true);
  const replay = await (await f.reload().resume(restricted.runId)).execute();
  assert.equal(replay.result, 'readonly');
  assert.equal(f.calls.length, 2, 'the same restricted call still reuses its own result');
  const unrestricted = await (await f.reload().resume(restricted.runId, { source: source(',readOnly:false') })).execute();
  assert.equal(unrestricted.result, 'writable');
});

it('malformed readOnly and external CLI readOnly calls fail before launching', async t => {
  const f = fixture(t, () => ({ text: 'must not launch' }));
  const bad = await (await f.manager.start({ source: script("return await agent('x',{readOnly:'yes'});"), args: {} })).execute();
  assert.equal(bad.status, 'failed');
  assert.match(bad.error!, /readOnly must be a boolean/);
  f.service.agentKind = () => 'cli';
  const cli = await (await f.manager.start({ source: script("return await agent('x',{readOnly:true});"), args: {}, reuse: 'none' })).execute();
  assert.equal(cli.status, 'failed');
  assert.match(cli.error!, /requires a Pi agent/);
  assert.equal(f.calls.length, 0);
});

it('adapter forwards the restriction independently of the agent definition', async () => {
  let forwarded: any;
  const surface: any = {
    sessionSnapshot: () => ({ sessionFile: '/tmp/parent.jsonl', sessionDir: '/tmp', sessionId: 'parent' }),
    cwd: () => '/tmp', getArtifactDir: () => '/tmp', registerName() {}, startWidgetRefresh() {},
    runningSubagents: new Map(), readNameRegistry: () => ({}),
    async launch(_p: any, _c: any, options: any) { forwarded = options; return { id: 'id', name: 'step', sessionFile: '/tmp/step.jsonl' }; },
    async watch() { return { exitCode: 0, summary: 'data', elapsed: 0 }; },
  };
  const child = await createWorkflowSubagentService(surface).spawn({ agentType: 'worker', name: 'step', task: 'x', readOnly: true });
  await child.completion;
  assert.equal(forwarded.workflow, true);
  assert.equal(forwarded.readOnly, true);
});

it('saved readonly loadouts retain enforcement and get fresh scratch on Focus/Resume', t => {
  const dir = mkdtempSync(join(tmpdir(), 'readonly-replay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const loadout: any = { readOnly: true, toolAllowlist: 'read,verify_command,ask_question,write,edit,bash,subagent,*', spawnable: ['worker'] };
  const scratches: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const parts = ['pi'];
    const ownedScratch = __test__.applySandboxToParts(parts, loadout, { artifactDir: dir, name: 'saved-verifier' });
    // Register cleanup before assertions so a killed permission mutant cannot
    // leave a newly allocated root behind when the first assertion fails.
    t.after(() => __test__.cleanupVerifyScratch(ownedScratch));
    const tools = parts[parts.indexOf('--tools') + 1];
    assert.match(tools, /verify_command/);
    assert.doesNotMatch(tools, /write|edit|bash|subagent|\*/);
    assert.ok(parts.includes('--no-extensions'));
    assert.ok(parts.some(part => part.includes('workflow/readonly.ts')));
    const scratch = parts.find(part => part.startsWith('PI_SUBAGENT_VERIFY_SCRATCH='))!;
    scratches.push(scratch);
    const path = scratch.slice(scratch.indexOf('=') + 1).replace(/^'|'$/g, '');
    t.after(() => __test__.cleanupVerifyScratch(path));
    assert.equal(existsSync(path), true);
    __test__.cleanupVerifyScratch(path);
    assert.equal(existsSync(path), false, 'owned session scratch is removed when its process ends');
  }
  assert.notEqual(scratches[0], scratches[1], 'reopened processes must not share a command scratch root');
  __test__.cleanupVerifyScratch(dir);
  assert.equal(existsSync(dir), true, 'cleanup must not delete paths it did not allocate');
});
