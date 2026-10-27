/** Work bounds, not wall-clock thresholds: these regressions also run on slow CI. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getLeafId, summarizeSession } from '../pi-extension/subagents/session.ts';
import { WorkflowPanel, createPanelRenderState, workflowSummary } from '../pi-extension/subagents/workflow/ui.ts';
import { registerWorkflowExtension } from '../pi-extension/subagents/workflow/index.ts';
import { WorkflowManager } from '../pi-extension/subagents/workflow/manager.ts';
import extension, { __test__ } from '../pi-extension/subagents/index.ts';
import { createStatusState } from '../pi-extension/subagents/status.ts';
import { deferred, fixture, script } from './helpers/workflow.ts';

for (const ending of ['', '\r\n \t\r\n']) it(`leaf lookup reads only the final record, preserving UTF-8 across chunks (${JSON.stringify(ending)})`, t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'session-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'large.jsonl');
  const fd = fs.openSync(file, 'w');
  const line = JSON.stringify({ type: 'message', id: 'old', text: 'x'.repeat(4096) }) + '\n';
  for (let i = 0; i < 1024; i++) fs.writeSync(fd, line);
  const id = '末尾🙂'.repeat(900);
  const tail = JSON.stringify({ type: 'message', id, text: '正文'.repeat(4000) });
  fs.writeSync(fd, tail + ending); fs.closeSync(fd);
  let bytes = 0;
  const read = fs.readSync, readFile = fs.readFileSync;
  fs.readSync = ((...args: any[]) => { const n = (read as any)(...args); bytes += n; return n; }) as typeof read;
  fs.readFileSync = ((...args: any[]) => {
    const value = (readFile as any)(...args);
    if (args[0] === file) bytes += Buffer.byteLength(value);
    return value;
  }) as typeof readFile;
  syncBuiltinESMExports();
  try {
    assert.equal(getLeafId(file), id);
    assert.ok(bytes < Buffer.byteLength(tail) + 8192, `${bytes} bytes read for a ${Buffer.byteLength(tail)}-byte tail`);
  } finally { fs.readSync = read; fs.readFileSync = readFile; syncBuiltinESMExports(); }
});

it('closed workflow branches are not traversed, and only viewport rows are formatted', async () => {
  const reads = new Map<number, number>();
  const views: any[] = Array.from({ length: 500 }, (_, i) => ({
    runId: 'r' + i, meta: { name: 'task-' + i, description: 'x', phases: ['Review'] },
    createdAt: i, updatedAt: i + 1, startedAtWall: i, finishedAt: i + 1, status: 'completed',
    get calls() { reads.set(i, (reads.get(i) ?? 0) + 1); return [{ callKey: 'c', label: 'child-' + i, phase: 'Review', status: 'completed' }]; },
  }));
  const formatted = new Set<string>();
  const theme = { fg: (_: string, value: string) => { if (/^task-\d+$/.test(value)) formatted.add(value); return value; }, bold: (s: string) => s };
  const panel = new WorkflowPanel({ views: () => views, isLive: () => false, notify() {},
    callbacks: { focus: () => ({ ok: true }), skip() {}, abort() {}, resume() {} } });
  const state = createPanelRenderState();
  panel.renderPanel(theme, 100, state, 30);
  assert.deepEqual([...reads.keys()], [499], 'only the expanded workflow needs its calls');
  assert.ok(formatted.size <= 30, 'off-screen roots must not be formatted');
  state.selected = 'run:r0'; formatted.clear();
  const bottom = panel.renderPanel(theme, 100, state, 30).join('\n');
  assert.match(bottom, /❯.*task-0/);
  assert.ok(formatted.size <= 30, 'scrolling directly to the end is bounded by the viewport');
  await panel.handleInput('\r', () => {}, state);
  assert.ok(panel.nodes(state).some(node => node.label === 'child-0'), 'expanding a previously untouched branch still initializes its phases');
  assert.doesNotThrow(() => new WorkflowPanel({ ...panel.options, views: () => [] }).renderPanel(theme, 80));
});

it('usage streams once and branch lookup reads its tail, with old text excluded on Resume', t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'session-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  fs.writeFileSync(file, [
    { type: 'session', id: 'session' },
    { type: 'message', id: 'old', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], usage: { input: 10, output: 20, totalTokens: 30 } } },
    { type: 'message', id: 'request', message: { role: 'user', content: [{ type: 'text', text: 'continue' }] } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  assert.equal(summarizeSession(file, 3).summary, null, 'an empty resumed turn cannot return an old answer');
  const text = '跨越分块边界🙂'.repeat(12000);
  const lastRecord = JSON.stringify({ type: 'message', id: 'new', parentId:'request', message: { role: 'assistant', model:'test-model', content: [{ type: 'text', text }], usage: { input: 40, output: 50, totalTokens: 90 } } });
  fs.appendFileSync(file, lastRecord);
  const read = fs.readSync, readFile = fs.readFileSync;
  let bytes = 0;
  fs.readSync = ((...args: any[]) => { const n = (read as any)(...args); bytes += n; return n; }) as typeof read;
  fs.readFileSync = ((...args: any[]) => {
    const value = (readFile as any)(...args);
    if (args[0] === file) bytes += Buffer.byteLength(value);
    return value;
  }) as typeof readFile;
  syncBuiltinESMExports();
  try {
    const summary = summarizeSession(file, 3);
    assert.equal(summary.summary, text);
    assert.equal(summary.stats.inputTokens, 50);
    assert.equal(summary.stats.outputTokens, 70);
    assert.equal(summary.stats.contextTokens, 90);
    assert.ok(bytes <= fs.statSync(file).size + Buffer.byteLength(lastRecord) + 8192,
      'one streamed usage scan plus the final branch record; no repeated full-history reads');
  } finally { fs.readSync = read; fs.readFileSync = readFile; syncBuiltinESMExports(); }
  fs.appendFileSync(file, '\ninvalid JSON\n');
  assert.throws(() => summarizeSession(file), SyntaxError, 'corrupt history must not become a successful empty completion');
});

it('historical calls do not trigger live status lookups on every view', async t => {
  const gate = deferred();
  const f = fixture(t, async request => { if (request.task === 'blocked') await gate.promise; return { text: 'done' }; });
  const lookedUp: string[] = [];
  f.service.status = name => { lookedUp.push(name); return undefined; };
  const done = await f.manager.start({ source: script('for (let i = 0; i < 12; i++) await agent("done");'), args: {} });
  await done.execute();
  const live = await f.manager.start({ source: script('await agent("done"); return await agent("blocked");', 'active'), args: {} });
  const executing = live.execute();
  const blocked = await f.waitForCall(call => call.task === 'blocked');
  lookedUp.length = 0;
  f.manager.list();
  assert.deepEqual(lookedUp, [blocked.name]);
  gate.resolve(); await executing;
});

it('finished runs release replay values and prompts while cold Resume keeps journal results', async t => {
  const f = fixture(t, () => ({ text: 'answer'.repeat(50000) }));
  const prompt = 'task'.repeat(30000);
  const source = script(`const answer = await agent(${JSON.stringify(prompt)}); return answer.length;`);
  const first = await f.manager.start({ source, args: {} });
  assert.equal((await first.execute()).result, 300000);
  assert.ok([...(first as any).live.values()].every(call => call.prompt === ''), 'finished UI history must not retain full agent prompts');
  const resumed = await f.reload().resume(first.runId);
  assert.equal((resumed as any).cache.size, 1, 'actual replay data is loaded from the journal');
  assert.equal((await resumed.execute()).result, 300000);
  assert.equal((resumed as any).cache.size, 0, 'finished runs must release borrowed replay payloads');
  const again = await f.reload().resume(first.runId);
  assert.equal((await again.execute()).result, 300000);
  assert.equal(f.calls.length, 1, 'releasing memory must not rerun a committed agent');
});

it('the status widget provider excludes finished workflow histories', async t => {
  const gate = deferred();
  const f = fixture(t, async () => { await gate.promise; return { text: 'done' }; });
  let tool: any, views: () => any[] = () => [];
  const hooks: Function[] = [];
  const settled = deferred();
  registerWorkflowExtension({ registerTool(value: any) { tool = value; }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    on(event: string, handler: Function) { if (event === 'session_shutdown') hooks.push(handler); }, sendMessage() { settled.resolve(); },
  } as any, { service: f.service, widget: { bind(get) { views = get; }, refresh() {} } });
  const ctx: any = { cwd: f.dir, hasUI: false, ui: { notify() {} }, sessionManager: {
    getSessionFile: () => join(f.dir, 'parent.jsonl'), getSessionId: () => 'widget', getSessionDir: () => f.dir,
  } };
  try {
    await tool.execute('done', { script: script('return 1;') }, undefined, undefined, ctx);
    await settled.promise;
    assert.deepEqual(views(), []);
    await tool.execute('active', { script: script('return await agent("blocked");', 'active') }, undefined, undefined, ctx);
    await f.waitForCall(() => true);
    assert.equal(views().length, 1);
    assert.equal(views()[0].meta.name, 'active');
  } finally { for (const hook of hooks) await hook({ reason: 'quit' }, ctx); gate.resolve(); }
});

it('typing does not rebuild workflow views and idle/headless sessions start no widget timer', async t => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const hooks = new Map<string, Function[]>(), tools = new Map<string, any>();
  let factory: Function | undefined;
  const api: any = { on(event: string, handler: Function) { hooks.set(event, [...(hooks.get(event) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    getThinkingLevel: () => 'off', getAllTools: () => [], sendMessage() {},
  };
  const ctx: any = { cwd: tmpdir(), hasUI: true, ui: { notify() {}, setWidget(_key: string, value: Function) { factory = value; } },
    sessionManager: { getSessionFile: () => join(tmpdir(), 'perf-parent.jsonl'), getSessionId: () => 'perf', getSessionDir: () => tmpdir() } };
  extension(api);
  for (const hook of hooks.get('session_start') ?? []) await hook({}, ctx);
  await tools.get('workflow').execute('status', { action: 'status' }, undefined, undefined, ctx);
  const running = WorkflowManager.prototype.running, list = WorkflowManager.prototype.list, interval = globalThis.setInterval;
  let views = 0, timers = 0;
  WorkflowManager.prototype.running = function () { views++; return running.call(this); };
  WorkflowManager.prototype.list = function () { views++; return list.call(this); };
  globalThis.setInterval = ((...args: any[]) => { timers++; return (interval as any)(...args); }) as typeof interval;
  try {
    __test__.runningSubagents.set('perf', { id: 'perf', name: 'perf', cli: 'codex', startTime: Date.now(), statusState: createStatusState({ source: 'codex', startTimeMs: Date.now() }) } as any);
    __test__.updateWidget();
    const child = __test__.runningSubagents.get('perf')!;
    const statusState = child.statusState;
    let statusReads = 0;
    Object.defineProperty(child, 'statusState', { get() { statusReads++; return statusState; } });
    const widget = factory!({}, {});
    const before = views;
    for (let i = 0; i < 100; i++) widget.render(100);
    assert.equal(views, before, '100 input/stream redraws must reuse the refresh snapshot');
    assert.equal(statusReads, 1, 'unchanged redraws must not reclassify or format every child');
    child.name = 'updated-child';
    widget.invalidate();
    assert.match(widget.render(100).join(String.fromCharCode(10)), /updated-child/);
    assert.equal(statusReads, 2, 'invalidation must reveal changed content');
    widget.render(60);
    assert.equal(statusReads, 3, 'resize must rebuild the frame at the new width');
    clock += 1000;
    widget.render(60);
    assert.equal(statusReads, 4, 'elapsed labels must refresh on the next second');
    const summary = workflowSummary({ progress: 0.5, totalCount: 2, activeCount: 1, meta: { name: 'active' }, usage: {},
      get calls() { throw new Error('widget must use the existing progress aggregate'); } } as any, 100).join('\n');
    assert.match(summary, /1\/2 settled/);
    __test__.runningSubagents.clear();
    __test__.startWidgetRefresh();
    ctx.hasUI = false;
    __test__.runningSubagents.set('perf', {} as any);
    __test__.startWidgetRefresh();
    assert.equal(timers, 0);
  } finally {
    __test__.runningSubagents.clear();
    WorkflowManager.prototype.running = running; WorkflowManager.prototype.list = list; globalThis.setInterval = interval;
    for (const hook of hooks.get('session_shutdown') ?? []) await hook({ reason: 'quit' }, ctx);
  }
});
