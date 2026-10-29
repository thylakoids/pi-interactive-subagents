import './tmux-isolation.ts';
/**
 * No-provider process integration: real isolated tmux panes, Node subprocesses,
 * filesystem inboxes and the production ask_question/control handlers. Minimal
 * ExtensionAPI hosts call registered tools directly; no model/provider is faked.
 * This supplements, and does not replace, billed Pi/model lifecycle E2E.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import subagentsExtension, { __test__, type RunningSubagent } from '../../pi-extension/subagents/index.ts';
import { createPiInbox, drainPiInbox, isPiLaunchStopped, piInbox, queuePiMessage } from '../../pi-extension/subagents/control.ts';
import { inspectNamedSubagent } from '../../pi-extension/subagents/lifecycle.ts';
import { readNameRegistry, registerName, updateRegisteredExecution } from '../../pi-extension/subagents/session.ts';
import { createStatusState } from '../../pi-extension/subagents/status.ts';
import { captureSurfaceOwnership, inspectOwnedSurface, shellEscape } from '../../pi-extension/subagents/tmux.ts';

const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const textOf = (result: any) => result.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function processExecuting(pid: number) {
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z'); }
  catch (error) { if ((error as any).status === 1) return false; throw error; }
}
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for ' + label);
    await delay(20);
  }
}

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-inspect-stop-process-'));
  const session = 'inspect-stop-' + process.pid + '-' + Math.random().toString(16).slice(2);
  const parent = tmux('new-session', '-d', '-s', session, '-x', '160', '-y', '50', '-P', '-F', '#{pane_id}');
  const sibling = tmux('split-window', '-d', '-t', parent, '-P', '-F', '#{pane_id}');
  const artifactDir = join(dir, 'artifacts', 'parent-session');
  mkdirSync(artifactDir, { recursive: true });
  const parentFile = join(dir, 'parent.jsonl');
  writeFileSync(parentFile, JSON.stringify({ type: 'session', id: 'parent-session' }) + '\n');
  const tools = new Map<string, any>(), events = new Map<string, Function[]>(), sent: any[] = [];
  const ctx = {
    cwd: dir, hasUI: false, mode: 'json', ui: { notify() {}, setWidget() {} },
    sessionManager: { getSessionFile: () => parentFile, getSessionId: () => 'parent-session', getSessionDir: () => dir },
  };
  subagentsExtension({
    on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    getThinkingLevel() { return 'off'; }, sendMessage(message: any) { sent.push(message); },
  } as any);
  for (const handler of events.get('session_start') ?? []) handler({}, ctx);
  const owned: RunningSubagent[] = [];
  t.after(async () => {
    for (const running of owned) {
      // Cleanup cannot rely on deliberately invalidated identities from a test.
      try {
        running.surfaceOwnership = captureSurfaceOwnership(running.surface);
        running.stopRequested = true;
        await __test__.cleanupRunningSubagent(running);
      } catch {}
      __test__.runningSubagents.delete(running.id);
    }
    try { tmux('kill-session', '-t', session); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (name: string, params: any) => {
    assert.ok(tools.has(name), name + ' must be registered on the model-facing API');
    return tools.get(name).execute('process-integration', params, new AbortController().signal, undefined, ctx);
  };
  const panes = () => tmux('list-panes', '-s', '-t', session, '-F', '#{pane_id}').split('\n');
  async function spawn(mode: 'running' | 'waiting', name = mode, id = name + '-launch', savedSession?: string) {
    const surface = tmux('new-window', '-d', '-t', session + ':', '-P', '-F', '#{pane_id}');
    tmux('set-option', '-p', '-t', surface, '@pi_subagent_owner', 'process-test-' + id);
    tmux('set-option', '-p', '-t', surface, '@pi_subagent_parent', parent);
    const sessionFile = savedSession ?? join(dir, name + '.jsonl');
    if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: name + '-session' }) + '\n');
    const activityFile = join(artifactDir, id + '.activity.json');
    const ready = join(dir, id + '.ready'), delivered = join(dir, id + '.delivered'), finish = join(dir, id + '.finish');
    const script = join(dir, id + '.ts');
    createPiInbox(sessionFile, id);
    writeFileSync(script, `
      import child from ${JSON.stringify(new URL('../../pi-extension/subagents/subagent-done.ts', import.meta.url).href)};
      import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
      Object.assign(process.env, ${JSON.stringify({ PI_SUBAGENT_SESSION: sessionFile, PI_SUBAGENT_ID: id,
        PI_SUBAGENT_NAME: name, PI_SUBAGENT_ACTIVITY_FILE: activityFile, PI_SUBAGENT_AUTO_EXIT: '1' })});
      const handlers = new Map(), tools = new Map();
      const emit = (name,event={},ctx={}) => { for(const fn of handlers.get(name) ?? []) fn(event,ctx); };
      child({on(name,fn){handlers.set(name,[...handlers.get(name)??[],fn]);},
        registerTool(tool){tools.set(tool.name,tool);},registerShortcut(){},getAllTools(){return[];},
        sendUserMessage(message,options){emit('input',{text:message});appendFileSync(${JSON.stringify(delivered)},JSON.stringify({message,...options})+'\\n');}});
      // This no-provider host keeps process lifetime under the test's control.
      // SDK lifecycle adapters exist, but marker-triggered shutdown is a no-op
      // here so parent-side termination failures can be observed independently.
      emit('session_start',{}, {ui:{setWidget(){}},abort(){},shutdown(){}});
      ${mode === 'waiting'
        ? "await tools.get('ask_question').execute('question',{question:'Continue this real parked process?'},undefined,undefined,{});"
        : "emit('agent_start');emit('tool_execution_start',{toolCallId:'running-tool',toolName:'process-wait'});"}
      writeFileSync(${JSON.stringify(ready)},String(process.pid));
      setInterval(()=>{if(existsSync(${JSON.stringify(finish)})){
        emit('agent_end',{messages:[{role:'assistant',content:[{type:'text',text:'Process completed'}],stopReason:'stop'}]});
        emit('agent_settled',{aborted:false},{shutdown(){process.exit(0);}});
      }},20);
    `);
    // Keep the pane shell after normal child exit, matching Pi's launch wrapper.
    tmux('respawn-pane', '-k', '-t', surface, `${shellEscape(process.execPath)} ${shellEscape(script)}; sleep 86400`);
    await until(() => existsSync(ready), 'real ' + mode + ' child readiness');
    const running: RunningSubagent = { id, name, surface, sessionFile, activityFile, startTime: Date.now(),
      task: 'No-provider process integration', interactive: false,
      statusState: createStatusState({ source: 'pi', startTimeMs: Date.now() }) };
    __test__.trackRunningSubagent(running, artifactDir);
    owned.push(running);
    return { running, ready, delivered, finish, pid: Number(readFileSync(ready, 'utf8')) };
  }
  const persistedInspect = (name: string) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {inspectNamedSubagent} from ${JSON.stringify(new URL('../../pi-extension/subagents/lifecycle.ts', import.meta.url).href)};
     process.stdout.write(JSON.stringify(inspectNamedSubagent(${JSON.stringify(artifactDir)},${JSON.stringify(name)})));`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const restartedMessage = (name: string, resume = false) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import extension,{__test__} from ${JSON.stringify(new URL('../../pi-extension/subagents/index.ts', import.meta.url).href)};
    const tools=new Map(),sent=[];
    extension({on(){},registerTool(tool){tools.set(tool.name,tool);},registerCommand(){},registerShortcut(){},
      registerMessageRenderer(){},getThinkingLevel(){return'off';},sendMessage(message){sent.push(message);}});
    const ctx={cwd:${JSON.stringify(dir)},hasUI:false,mode:'json',ui:{notify(){},setWidget(){}},sessionManager:{
      getSessionFile:()=>${JSON.stringify(parentFile)},getSessionDir:()=>${JSON.stringify(dir)},getSessionId:()=>'parent-session'}};
    const result=await tools.get('subagent_message').execute('restarted-late-delivery',
      {name:${JSON.stringify(name)},message:'late input from a fresh parent process',resume:${resume}},new AbortController().signal,undefined,ctx);
    process.stdout.write(JSON.stringify({result,running:__test__.runningSubagents.size,sent:sent.length}));
  `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 }));
  const restartedInbox = (running: RunningSubagent) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {queuePiMessage,drainPiInbox} from ${JSON.stringify(new URL('../../pi-extension/subagents/control.ts', import.meta.url).href)};
    let error=null,delivered=0;
    try{queuePiMessage(${JSON.stringify(running.sessionFile)},${JSON.stringify(running.id)},{message:'late restart inbox message',deliverAs:'steer'});}
    catch(caught){error=caught.message;}
    const drained=drainPiInbox(${JSON.stringify(running.sessionFile)},${JSON.stringify(running.id)},()=>{delivered++;});
    process.stdout.write(JSON.stringify({error,drained,delivered}));
  `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 }));
  return { dir, parent, sibling, artifactDir, parentFile, call, panes, spawn, sent, persistedInspect, restartedMessage, restartedInbox };
}

it('no-provider real processes: inspect running/ask_question children, stop twice, block late replies and preserve unrelated panes', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const active = await f.spawn('running');
  const waiting = await f.spawn('waiting');
  const beforePanes = f.panes(), parentBefore = readFileSync(f.parentFile, 'utf8');
  const activeBefore = readFileSync(active.running.sessionFile, 'utf8');
  const waitingBefore = readFileSync(waiting.running.sessionFile, 'utf8');
  for (const [child, expected] of [[active, 'running'], [waiting, 'waiting']] as const) {
    const result = await f.call('subagent_inspect', { name: child.running.name });
    const visible = JSON.parse(textOf(result));
    assert.equal(visible.state, expected);
    assert.equal(visible.id, child.running.id);
    assert.match(visible.reason, /liveness was not independently checked/);
    process.kill(child.pid, 0);
  }
  assert.deepEqual(f.panes(), beforePanes, 'inspect cannot open another pane');
  assert.equal(readFileSync(active.running.sessionFile, 'utf8'), activeBefore);
  assert.equal(readFileSync(waiting.running.sessionFile, 'utf8'), waitingBefore);
  assert.equal(existsSync(waiting.running.sessionFile + '.ask'), true, 'inspect does not consume questions');
  assert.equal(existsSync(active.delivered), false);
  assert.equal(existsSync(waiting.delivered), false);
  const afterRestart = f.persistedInspect('waiting');
  assert.equal(afterRestart.state, 'unknown');
  assert.equal(afterRestart.historicalPhase, 'waiting');
  assert.equal(afterRestart.stale, true);

  __test__.deliverPendingQuestion(waiting.running);
  assert.equal(f.sent.filter(message => message.customType === 'subagent_question').length, 1, 'ordinary questions still notify the parent');
  for (const child of [active, waiting]) {
    const stopped = JSON.parse(textOf(await f.call('subagent_stop', { name: child.running.name, id: child.running.id })));
    assert.equal(stopped.requested, true);
    assert.equal(stopped.confirmed, true, stopped.reason);
    assert.equal(stopped.state, 'stopped');
    assert.equal(__test__.runningSubagents.has(child.running.id), false);
    assert.equal(existsSync(piInbox(child.running.sessionFile, child.running.id)), false);
    assert.equal(processExecuting(child.pid), false, 'the actual child process is independently absent or reaped');
    assert.equal(existsSync(child.running.sessionFile + '.ask'), false);
    assert.equal(existsSync(child.running.sessionFile), true, 'the session survives cancellation');
    assert.equal(isPiLaunchStopped(child.running.sessionFile, child.running.id), true);
    const repeated = await __test__.stopNamedSubagent(f.artifactDir, child.running.name, child.running.id);
    assert.equal(repeated.confirmed, true, repeated.reason);
    assert.equal(repeated.state, 'stopped');
    assert.equal(f.persistedInspect(child.running.name).state, 'stopped', 'confirmation survives a fresh parent process');
    assert.throws(() => queuePiMessage(child.running.sessionFile, child.running.id, { message: 'late answer', deliverAs: 'steer' }), /explicitly stopped/);
    const late = await f.call('subagent_message', { name: child.running.name, message: 'late question reply' });
    assert.match(textOf(late), /late reply cannot resume/);
    const beforeRestartPanes = f.panes(), beforeRestartSession = readFileSync(child.running.sessionFile, 'utf8');
    const restartedLate = f.restartedMessage(child.running.name);
    assert.match(textOf(restartedLate.result), /late reply cannot resume/);
    assert.equal(restartedLate.running, 0);
    assert.equal(restartedLate.sent, 0);
    // Simulate an already written old input surviving/delaying beyond cleanup.
    const oldInbox = join(piInbox(child.running.sessionFile, child.running.id), 'inbox');
    mkdirSync(oldInbox, { recursive: true });
    writeFileSync(join(oldInbox, 'delayed.json'), JSON.stringify({ message: 'late persisted answer', deliverAs: 'steer' }));
    const restartedControl = f.restartedInbox(child.running);
    assert.match(restartedControl.error, /explicitly stopped/);
    assert.equal(restartedControl.drained, 0);
    assert.equal(restartedControl.delivered, 0);
    assert.deepEqual(f.panes(), beforeRestartPanes, 'fresh-process late deliveries cannot create a pane');
    assert.equal(readFileSync(child.running.sessionFile, 'utf8'), beforeRestartSession, 'fresh-process late deliveries cannot append a user message');
    assert.equal(existsSync(child.delivered), false, 'late input cannot reach the terminated child');
    const deliberate = await f.call('subagent_message', { name: child.running.name, message: 'deliberate task', resume: true });
    assert.match(textOf(deliberate), /no sandbox snapshot/, 'explicit resume passes the confirmed-stop gate but cannot invent an original loadout');
    writeFileSync(child.running.sessionFile + '.ask', JSON.stringify({ question: 'late question' }));
    __test__.deliverPendingQuestion(child.running);
  }
  assert.equal(f.sent.filter(message => message.customType === 'subagent_question').length, 1, 'late question files cannot wake stopped work');
  assert.deepEqual(f.panes(), [f.parent, f.sibling]);
  assert.equal(readFileSync(f.parentFile, 'utf8'), parentBefore);
});

it('no-provider real processes: stale expected ids never request stop; stale surface ownership keeps termination uncertain and blocks resume', { timeout: 20000 }, async t => {
  const f = fixture(t), child = await f.spawn('waiting');
  const ownership = child.running.surfaceOwnership!;
  const rejected = await __test__.stopNamedSubagent(f.artifactDir, child.running.name, 'previous-launch');
  assert.equal(rejected.requested, false);
  assert.equal(rejected.confirmed, false);
  assert.match(rejected.reason, /identity changed/);
  assert.equal(isPiLaunchStopped(child.running.sessionFile, child.running.id), false);
  assert.equal(inspectOwnedSurface(child.running.surface, ownership).state, 'owned');
  tmux('set-option', '-p', '-t', child.running.surface, '@pi_subagent_owner', 'different-owner');
  const uncertain = await __test__.stopNamedSubagent(f.artifactDir, child.running.name, child.running.id);
  assert.equal(uncertain.requested, true);
  assert.equal(uncertain.confirmed, false);
  assert.equal(uncertain.state, 'stop_requested');
  process.kill(child.pid, 0);
  assert.equal(__test__.runningSubagents.has(child.running.id), true, 'an unconfirmed stop cannot erase runtime ownership');
  assert.match(textOf(await f.call('subagent_message', { name: child.running.name, message: 'late answer' })), /explicitly stopped/);
  // A genuinely new process has no live ownership and must honor durable intent.
  const beforeRestartPanes = f.panes(), beforeRestartSession = readFileSync(child.running.sessionFile, 'utf8');
  const restartedLate = f.restartedMessage(child.running.name);
  assert.match(textOf(restartedLate.result), /late reply cannot resume/);
  const restartedResume = f.restartedMessage(child.running.name, true);
  assert.match(textOf(restartedResume.result), /unconfirmed/);
  for (const result of [restartedLate, restartedResume]) {
    assert.equal(result.running, 0);
    assert.equal(result.sent, 0);
  }
  const restartedControl = f.restartedInbox(child.running);
  assert.match(restartedControl.error, /explicitly stopped/);
  assert.equal(restartedControl.drained, 0);
  assert.equal(restartedControl.delivered, 0);
  assert.deepEqual(f.panes(), beforeRestartPanes);
  assert.equal(readFileSync(child.running.sessionFile, 'utf8'), beforeRestartSession);
  assert.equal(existsSync(child.delivered), false);
  process.kill(child.pid, 0);
  tmux('set-option', '-p', '-t', child.running.surface, '@pi_subagent_owner', ownership.owner);
  const confirmed = await __test__.stopNamedSubagent(f.artifactDir, child.running.name, child.running.id);
  assert.equal(confirmed.confirmed, true, confirmed.reason);
  assert.deepEqual(f.panes(), [f.parent, f.sibling]);
});

it('no-provider real processes: unavailable termination evidence never becomes confirmed absence', { timeout: 20000 }, async t => {
  const f = fixture(t), child = await f.spawn('running');
  const savedTmux = process.env.TMUX;
  process.env.TMUX = join(f.dir, 'missing-socket') + ',12345,0';
  try {
    const result = await __test__.stopNamedSubagent(f.artifactDir, child.running.name, child.running.id);
    assert.equal(result.requested, true);
    assert.equal(result.confirmed, false);
    assert.equal(result.state, 'stop_requested');
    assert.match(result.reason, /could not be independently verified/);
  } finally { process.env.TMUX = savedTmux; }
  process.kill(child.pid, 0);
  assert.equal(inspectNamedSubagent(f.artifactDir, child.running.name, child.running).state, 'stop_requested');
  assert.equal((await __test__.stopNamedSubagent(f.artifactDir, child.running.name, child.running.id)).confirmed, true);
  assert.deepEqual(f.panes(), [f.parent, f.sibling]);
});

it('no-provider real processes: a new launch can deliberately reuse the saved session while old inboxes remain stopped', { timeout: 20000 }, async t => {
  const f = fixture(t), old = await f.spawn('waiting', 'same-name', 'old-launch');
  assert.equal((await __test__.stopNamedSubagent(f.artifactDir, old.running.name, old.running.id)).confirmed, true);
  const resumed = await f.spawn('waiting', 'same-name', 'new-launch', old.running.sessionFile);
  assert.equal(inspectNamedSubagent(f.artifactDir, resumed.running.name, resumed.running).state, 'waiting');
  assert.equal(isPiLaunchStopped(old.running.sessionFile, old.running.id), true);
  assert.equal(isPiLaunchStopped(resumed.running.sessionFile, resumed.running.id), false);
  assert.throws(() => createPiInbox(old.running.sessionFile, old.running.id), /explicitly stopped/);
  mkdirSync(join(piInbox(old.running.sessionFile, old.running.id), 'inbox'), { recursive: true });
  writeFileSync(join(piInbox(old.running.sessionFile, old.running.id), 'inbox', 'late.json'), JSON.stringify({ message: 'old poison', deliverAs: 'steer' }));
  assert.equal(drainPiInbox(old.running.sessionFile, old.running.id, () => assert.fail('old input cannot revive an old launch')), 0);
  const delivered = await f.call('subagent_message', { name: resumed.running.name, message: 'explicit new-launch answer' });
  assert.match(textOf(delivered), /Message queued/);
  await until(() => existsSync(resumed.delivered), 'new launch inbox delivery');
  assert.match(readFileSync(resumed.delivered, 'utf8'), /explicit new-launch answer/);
  assert.doesNotMatch(readFileSync(resumed.delivered, 'utf8'), /old poison/);
  assert.equal(readNameRegistry(f.artifactDir)['same-name'].execution?.id, 'new-launch');
  assert.equal((await __test__.stopNamedSubagent(f.artifactDir, resumed.running.name, 'old-launch')).requested, false);
  assert.equal((await __test__.stopNamedSubagent(f.artifactDir, resumed.running.name, resumed.running.id)).confirmed, true);
  assert.deepEqual(f.panes(), [f.parent, f.sibling]);
});

it('no-provider real processes: persisted finished references stop without launching and native backend stop stays unsupported', { timeout: 20000 }, async t => {
  const f = fixture(t), child = await f.spawn('running');
  const native = await f.spawn('waiting', 'native');
  native.running.cli = 'codex';
  updateRegisteredExecution(f.artifactDir, native.running.name, native.running.sessionFile, native.running.id,
    execution => { execution.backend = 'codex'; });
  const unsupported = await __test__.stopNamedSubagent(f.artifactDir, native.running.name, native.running.id);
  assert.equal(unsupported.requested, false);
  assert.equal(unsupported.confirmed, false);
  assert.match(unsupported.reason, /unsupported/);
  process.kill(native.pid, 0);
  assert.equal(isPiLaunchStopped(native.running.sessionFile, native.running.id), false);
  // Restore the process's actual Pi handler backend solely for owned cleanup.
  native.running.cli = undefined;
  updateRegisteredExecution(f.artifactDir, native.running.name, native.running.sessionFile, native.running.id,
    execution => { execution.backend = 'pi'; });
  const saved = readNameRegistry(f.artifactDir)[child.running.name];
  registerName(f.artifactDir, child.running.name, { ...saved, sessionId: null });
  writeFileSync(child.finish, 'finish normally');
  await until(() => existsSync(child.running.sessionFile + '.exit'), 'fast standalone completion sidecar');
  assert.equal(readNameRegistry(f.artifactDir)[child.running.name].sessionId, null,
    'simulate a standalone launch whose session header was not registered before completion');
  const result = await __test__.watchSubagent(child.running, new AbortController().signal);
  assert.equal(result.exitCode, 0, 'production agent_settled completion is observed by the ordinary watcher');
  assert.equal(processExecuting(child.pid), false);
  assert.equal(readNameRegistry(f.artifactDir)[child.running.name].sessionId, child.running.name + '-session',
    'cleanup captures session identity even when exit is observed before the first watcher tick');
  const completed = f.persistedInspect(child.running.name);
  assert.equal(completed.state, 'finished');
  const before = f.panes();
  const stopped = await __test__.stopNamedSubagent(f.artifactDir, child.running.name, child.running.id);
  assert.equal(stopped.confirmed, true);
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(f.panes(), before);
  assert.equal((await __test__.stopNamedSubagent(f.artifactDir, native.running.name, native.running.id)).confirmed, true);
});
