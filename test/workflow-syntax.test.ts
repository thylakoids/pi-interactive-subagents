import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseScript } from '../pi-extension/subagents/workflow/script.ts';
import { validateScript } from '../pi-extension/subagents/workflow/runner.ts';
import { registerWorkflowExtension } from '../pi-extension/subagents/workflow/index.ts';
import { deferred, fixture, script } from './helpers/workflow.ts';

it('QuickJS validation parses unreachable code without executing user code or host calls', async () => {
  const source = script('while (true) {}\nawait agent("must not launch");\nthrow new Error("must not execute");');
  const checked = await validateScript(parseScript(source, 'probe.js').body, 'probe.js');
  assert.equal(checked.ok, true, checked.error?.message);
  assert.equal(checked.issuedCalls, 0);
  const cancelled = await validateScript(parseScript(source, 'probe.js').body, 'probe.js', AbortSignal.abort(new Error('cancel validation')));
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.issuedCalls, 0);
  const broken = await validateScript(parseScript(script('return;\nconst broken = ;'), 'bad.js').body, 'bad.js');
  assert.equal(broken.ok, false, 'validation must still parse code after return');
  assert.match(broken.error!.message, /bad.js:3:16/);
  assert.match(broken.error!.message, /> 3 \| const broken = ;/);
  const glued = 'export const meta = {name:"glued",description:"missing delimiter"}const value = 1;';
  const delimiter = await validateScript(parseScript(glued, 'glued.js').body, 'glued.js');
  assert.equal(delimiter.ok, false, 'metadata rewriting must not silently repair a missing delimiter');
  assert.match(delimiter.error!.message, /glued.js:1:/);
  assert.match(delimiter.error!.message, /}const value = 1;/);
  for (const body of ['if (true) {', 'const x = (', 'function broken() {\n  return 1;']) {
    const source = script(body);
    const eof = await validateScript(parseScript(source, 'eof.js').body, 'eof.js');
    assert.equal(eof.ok, false);
    assert.ok(eof.error!.message.includes('eof.js:' + source.split('\n').length + ':'), eof.error!.message);
    assert.ok(eof.error!.message.includes(body.split('\n').at(-1)!), eof.error!.message);
  }
});

it('syntax diagnostics preserve original whitespace, filename, line, column and code', async t => {
  const f = fixture(t, () => { assert.fail('syntax errors cannot launch an agent'); });
  const source = '\n\n  export const meta = {\n name:"syntax", description:"bad script"\n}\n\nconst broken = ;\nawait agent("must not launch");';
  const run = await f.manager.start({ source, args: {} });
  const view = await run.execute();
  assert.equal(view.status, 'failed');
  assert.ok(view.error!.includes(join(run.runDir, 'script.js') + ':7:16'), view.error);
  assert.match(view.error!, /> 7 \| const broken = ;/);
  assert.equal(JSON.parse(readFileSync(join(run.runDir, 'snapshot.json'), 'utf8')).error, view.error);
  const edited = await f.reload().resume(run.runId, { source: source.replace('const broken = ;', 'const broken = 1;').replace('await agent("must not launch");', 'return broken;') });
  assert.equal((await edited.execute()).result, 1);
  const childDir = join(f.dir, '.pi', 'workflows');
  mkdirSync(childDir, { recursive: true });
  const childPath = join(childDir, 'bad-child.js');
  writeFileSync(childPath, script('const broken = ;'));
  const nested = await f.manager.start({ source: script('return await workflow("bad-child", {});'), args: {} });
  const failedChild = await nested.execute();
  assert.equal(failedChild.status, 'failed');
  assert.ok(failedChild.error!.includes(join(nested.runDir, 'nested')), failedChild.error);
  assert.match(failedChild.error!, /\.js:2:16/);
  assert.equal(f.calls.length, 0);
});

it('syntax diagnostics reach parent notifications, status and expanded transcript rendering', async t => {
  const f = fixture(t, () => { assert.fail('bad syntax cannot spawn'); });
  const settled = deferred<any>();
  let tool: any, renderer: any;
  registerWorkflowExtension({
    registerTool(value: any) { tool = value; }, registerCommand() {}, registerShortcut() {}, on() {},
    registerMessageRenderer(_name: string, value: any) { renderer = value; },
    sendMessage(message: any) { settled.resolve(message); },
  } as any, { service: f.service });
  const ctx = { cwd: f.dir, sessionManager: { getSessionFile: () => join(f.dir, 'parent.jsonl'), getSessionId: () => 'syntax', getSessionDir: () => f.dir } };
  const started = await tool.execute('start', { script: script('const broken = ;') }, undefined, undefined, ctx);
  const message = await settled.promise;
  assert.match(message.content, /script.js:2:16/);
  assert.match(message.details.error, /> 2 \| const broken = ;/);
  const status = await tool.execute('status', { action: 'status', runId: started.details.runId }, undefined, undefined, ctx);
  assert.match(status.content[0].text, /> 2 \| const broken = ;/);
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
  const expanded = renderer(message, { expanded: true }, theme).render(160).join('\n');
  assert.match(expanded, /script.js:2:16/);
  assert.match(expanded, /> 2 \| const broken = ;/);
  const checked = await tool.execute('check', { action: 'validate', script: script('return 1;') }, undefined, undefined, ctx);
  const text = tool.renderResult(checked, { expanded: false }, theme).render(160).join('\n');
  assert.match(text, /QuickJS syntax OK/);
  assert.doesNotMatch(text, /agents planned/);
});

it('the real QuickJS runtime accepts spread and nested array literals', async t => {
  const f = fixture(t, () => { assert.fail('no agent needed'); });
  const source = script('const nested = [[1,2], ...[3,4].map(x => [x])]; return nested;');
  assert.equal((await validateScript(parseScript(source, 'arrays.js').body, 'arrays.js')).ok, true);
  assert.deepEqual((await (await f.manager.start({ source, args: {} })).execute()).result, [[1,2],[3],[4]]);
});

it('validate tool reports saved file errors and works without tmux, a session or a model', async t => {
  const f = fixture(t, () => { assert.fail('validation cannot spawn'); });
  f.service.isAvailable = () => { assert.fail('validation cannot require a running backend'); };
  let tool: any;
  registerWorkflowExtension({ registerTool(value: any) { tool = value; }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, on() {} } as any, { service: f.service });
  const dir = join(f.dir, '.pi', 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'broken.js'), script('const broken = ;'));
  const checked = await tool.execute('validate', { action: 'validate', name: 'broken' }, undefined, undefined, { cwd: f.dir });
  assert.equal(checked.isError, true);
  assert.equal(checked.details.valid, false);
  assert.ok(checked.content[0].text.includes(join(dir, 'broken.js') + ':2:16'), checked.content[0].text);
  const good = await tool.execute('validate', { action: 'validate', script: script('await agent("unreachable");') }, undefined, undefined, { cwd: f.dir });
  assert.equal(good.details.valid, true);
  assert.equal(f.calls.length, 0);
});
