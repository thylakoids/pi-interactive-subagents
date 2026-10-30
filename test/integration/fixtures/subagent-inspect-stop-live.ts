/** Real models and production tool handlers; this fixture only controls timing. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import extension, { __test__ } from '../../../pi-extension/subagents/index.ts';
import { piInbox, queuePiMessage } from '../../../pi-extension/subagents/control.ts';
import { shellEscape, surfaceExists } from '../../../pi-extension/subagents/tmux.ts';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await delay(100);
  assert.ok(check(), 'Timed out: ' + label);
}
function rows(file: string): any[] {
  let contents: string;
  try { contents = readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return contents.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const users = (file: string) => rows(file).filter(row => row.message?.role === 'user');
function assertCompletedEvidence(snapshot: any) {
  assert.ok(Number.isFinite(snapshot.evidenceAt), 'completion inspection must retain its evidence time');
  if (snapshot.state === 'finished') {
    assert.equal(snapshot.stale, false);
    return;
  }
  // A normally exiting child can retire before strict descendant capture.
  // Acceptance permits historical evidence, never a fabricated termination proof.
  assert.equal(snapshot.state, 'unknown');
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.historicalPhase, 'done');
  assert.match(snapshot.reason, /historical launch.*liveness is unknown/);
}
const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const alive = (pid: number) => {
  assert.ok(Number.isInteger(pid) && pid > 0);
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().startsWith('Z'); }
  catch (error) { if ((error as any).status !== 1) throw error; return false; }
};
function descendants(root: number) {
  const processes = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
    .map(line => line.trim().split(/\s+/).map(Number));
  const pids = new Set([root]);
  for (const parent of pids) for (const [pid, ppid] of processes) if (ppid === parent) pids.add(pid);
  return [...pids].sort((a, b) => a - b);
}

export default function liveLifecycle(pi: any) {
  const tools = new Map<string, any>();
  // Forward every registration unchanged to the real Pi API. No production
  // handler, lifecycle service or provider is replaced by this instrumentation.
  const instrumented = new Proxy(pi, { get(target, property) {
    if (property === 'registerTool') return (tool: any) => { tools.set(tool.name, tool); pi.registerTool(tool); };
    return Reflect.get(target, property);
  } });
  extension(instrumented);
  const dir = process.env.PI_INSPECT_STOP_LIVE_DIR!;
  const save = (name: string, value: unknown) => writeFileSync(join(dir, name + '.json'), JSON.stringify(value, null, 2));
  const record = (event: string, details: unknown = {}) => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ at: Date.now(), event, details }) + '\n');
  pi.on('session_start', () => {
    const file = join(dir, 'generation');
    writeFileSync(file, String(existsSync(file) ? Number(readFileSync(file, 'utf8')) + 1 : 1));
  });
  pi.on('before_agent_start', (event: any) => ({ systemPrompt: event.systemPrompt +
    '\nThis parent is a lifecycle integration controller. Children are controlled by the test command. Do not invoke tools or answer their questions; reply only ACK to automatic notifications.' }));
  const invoke = async (ctx: any, name: string, input: unknown) => {
    const tool = tools.get(name);
    assert.ok(tool, 'Production tool must be registered: ' + name);
    const result = await tool.execute(randomUUID(), input, new AbortController().signal, undefined, ctx);
    record(name, { input, result });
    return result;
  };
  const child = (name: string) => [...__test__.runningSubagents.values()].find(item => item.name === name);
  const inspect = async (ctx: any, name: string) => {
    const result = await invoke(ctx, 'subagent_inspect', { name });
    const visible = JSON.parse(result.content.find((part: any) => part.type === 'text').text);
    assert.deepEqual(visible, result.details, 'state and identity must be visible to the model');
    assert.equal(visible.name, name);
    for (const field of ['id', 'backend', 'sessionId', 'sessionFile', 'state', 'source', 'observedAt', 'evidenceAt', 'stale']) {
      assert.ok(Object.hasOwn(visible, field), 'Visible inspection includes ' + field);
    }
    return visible;
  };
  const panes = () => tmux('list-panes', '-s', '-t', process.env.TMUX_PANE!, '-F', '#{pane_id}|#{pane_pid}').split('\n').sort();
  const unchangedInspect = async (ctx: any, name: string, expected: string) => {
    const running = child(name)!;
    assert.ok(running, 'Real child must be owned before inspect');
    const beforePanes = panes(), beforeUsers = users(running.sessionFile);
    const rootPid = Number(tmux('display-message', '-p', '-t', running.surface, '#{pane_pid}'));
    const beforeProcesses = descendants(rootPid);
    const snapshot = await inspect(ctx, name);
    assert.equal(snapshot.state, expected, JSON.stringify(snapshot));
    assert.equal(snapshot.id, running.id);
    assert.equal(snapshot.backend, 'pi');
    assert.deepEqual(panes(), beforePanes, 'inspection must not create or replace panes');
    assert.deepEqual(users(running.sessionFile), beforeUsers, 'inspection must not append input');
    assert.deepEqual(descendants(rootPid), beforeProcesses, 'inspection must not launch a child process');
    return snapshot;
  };
  const bashTask = (command: string) => 'Use the actual bash TOOL exactly once with command ' + JSON.stringify(command) +
    ' and timeout 600. Then reply DONE. Do not alter the command, add setup/cleanup, delegate or perform any other work.';
  const blocking = (name: string) => bashTask('node -e ' + shellEscape([
    "const fs=require('node:fs');", `fs.writeFileSync('${name}.pid',String(process.pid));`,
    `const timer=setInterval(()=>{if(fs.existsSync('${name}-release')){fs.writeFileSync('${name}-done','done');clearInterval(timer);}},100);`,
  ].join('')));
  const start = async (ctx: any, name: string, task: string) => {
    const result = await invoke(ctx, 'subagent', { agent: 'inspect-stop-probe', name, task, cwd: dir });
    assert.equal(result.details.status, 'started', JSON.stringify(result));
    return child(name)!;
  };
  const stop = async (ctx: any, name: string, id: string) => {
    const result = await invoke(ctx, 'subagent_stop', { name, id });
    assert.equal(result.details.requested, true, JSON.stringify(result));
    assert.equal(result.details.confirmed, true, JSON.stringify(result));
    assert.equal(result.details.state, 'stopped');
    return result.details;
  };
  const rejectLate = async (ctx: any, name: string, file: string) => {
    const beforePanes = panes(), beforeUsers = users(file);
    const reply = await invoke(ctx, 'subagent_message', { name, message: 'Late answer: create forbidden-late-reply, then continue.' });
    assert.match(reply.details.error, /explicitly stopped|late reply|termination.*unconfirmed/i);
    assert.deepEqual(panes(), beforePanes, 'late reply must not open a pane');
    assert.deepEqual(users(file), beforeUsers, 'late reply must not enter stopped history');
  };
  const automaticResults = (ctx: any, name: string, task: string) => ctx.sessionManager.getEntries().filter((row: any) =>
    row.type === 'custom_message' && row.customType === 'subagent_result' && row.details?.name === name && row.details?.task === task);

  pi.registerCommand('live-inspect-stop', { description: 'Run real named-child lifecycle probes', handler: async (_args: string, ctx: any) => {
    try {
      const parent = process.env.TMUX_PANE!;
      const parentPid = process.pid;
      const running = await start(ctx, 'live-running', blocking('running'));
      const sibling = await start(ctx, 'live-sibling', blocking('sibling'));
      await until(() => existsSync(join(dir, 'running.pid')) && existsSync(join(dir, 'sibling.pid')), 'both real models enter blocking tools');
      const runningPid = Number(readFileSync(join(dir, 'running.pid'), 'utf8'));
      const siblingPid = Number(readFileSync(join(dir, 'sibling.pid'), 'utf8'));
      assert.equal(alive(runningPid), true);
      assert.equal(alive(siblingPid), true);
      const runningSnapshot = await unchangedInspect(ctx, running.name, 'running');
      const runningProcesses = descendants(Number(tmux('display-message', '-p', '-t', running.surface, '#{pane_pid}')));
      const stale = await invoke(ctx, 'subagent_stop', { name: running.name, id: 'stale-' + running.id });
      assert.equal(stale.details.requested, false);
      assert.equal(stale.details.confirmed, false);
      assert.equal(alive(runningPid), true, 'a stale launch identity must not stop the real child');
      await stop(ctx, running.name, running.id);
      await until(() => !surfaceExists(running.surface) && runningProcesses.every(pid => !alive(pid)), 'running pane, Pi and actual blocking process terminate');
      assert.equal(existsSync(piInbox(running.sessionFile, running.id)), false);
      await stop(ctx, running.name, running.id);
      assert.throws(() => queuePiMessage(running.sessionFile, running.id, { message: 'late queued input', deliverAs: 'steer' }));
      await rejectLate(ctx, running.name, running.sessionFile);
      assert.equal(automaticResults(ctx, running.name, running.task).length, 0, 'stopped original launch cannot deliver a late result');
      assert.equal(surfaceExists(parent), true);
      assert.equal(alive(parentPid), true);
      assert.equal(surfaceExists(sibling.surface), true);
      assert.equal(alive(siblingPid), true);

      const resumeRunningTask = 'The previous blocking command was intentionally stopped; do not restart it. ' + bashTask('printf RESUMED_RUNNING > running-resumed');
      const resumed = await invoke(ctx, 'subagent_message', { name: running.name, resume: true, message: resumeRunningTask });
      assert.equal(resumed.details.status, 'started', JSON.stringify(resumed));
      assert.notEqual(resumed.details.id, running.id);
      assert.equal(resumed.details.sessionFile, running.sessionFile);
      assert.equal(resumed.details.sessionId, runningSnapshot.sessionId);
      await until(() => existsSync(join(dir, 'running-resumed')) && !child(running.name), 'deliberate resume completes in the same history');
      await until(() => automaticResults(ctx, running.name, resumeRunningTask).length === 1, 'exactly one result from the deliberate resumed task arrives');
      assert.equal(automaticResults(ctx, running.name, running.task).length, 0, 'old launch stays suppressed after deliberate resume');
      const finished = await inspect(ctx, running.name);
      assertCompletedEvidence(finished);

      const waiting = await start(ctx, 'live-waiting', 'Your FIRST actual tool call must be ask_question with question "LIFECYCLE_WAIT: What is my next task?". Plain text does not invoke tools. Then stop and wait for your parent. Do not use any other tool, write a file, invent an answer or continue until a parent reply arrives.');
      await until(() => rows(waiting.sessionFile).some(row => row.message?.role === 'toolResult' && row.message.toolName === 'ask_question'), 'real model asks its parent');
      await until(() => ctx.sessionManager.getEntries().some((row: any) => row.type === 'custom_message' && row.customType === 'subagent_question' && row.details?.name === waiting.name), 'automatic question delivery remains intact');
      await until(() => {
        const result = waiting.activityFile && existsSync(waiting.activityFile) ? JSON.parse(readFileSync(waiting.activityFile, 'utf8')) : null;
        return result?.phase === 'waiting';
      }, 'question child parks waiting');
      // Let Pi finish its asking turn before comparing the stable process tree.
      await delay(300);
      const waitingSnapshot = await unchangedInspect(ctx, waiting.name, 'waiting');
      const waitingProcesses = descendants(Number(tmux('display-message', '-p', '-t', waiting.surface, '#{pane_pid}')));
      await stop(ctx, waiting.name, waiting.id);
      await until(() => !surfaceExists(waiting.surface) && waitingProcesses.every(pid => !alive(pid)), 'waiting child pane and Pi processes terminate');
      assert.equal(existsSync(piInbox(waiting.sessionFile, waiting.id)), false);
      assert.equal(existsSync(waiting.sessionFile + '.ask'), false);
      await stop(ctx, waiting.name, waiting.id);
      assert.throws(() => queuePiMessage(waiting.sessionFile, waiting.id, { message: 'delayed answer', deliverAs: 'steer' }));
      await rejectLate(ctx, waiting.name, waiting.sessionFile);
      assert.equal(automaticResults(ctx, waiting.name, waiting.task).length, 0, 'stopped question launch cannot deliver a late result');
      assert.equal(surfaceExists(parent), true);
      assert.equal(alive(parentPid), true);
      assert.equal(surfaceExists(sibling.surface), true);
      assert.equal(alive(siblingPid), true, 'stopping either child preserves unrelated work');
      writeFileSync(join(dir, 'sibling-release'), 'release');
      await until(() => existsSync(join(dir, 'sibling-done')) && !child(sibling.name), 'sibling finishes normally');
      await until(() => automaticResults(ctx, sibling.name, sibling.task).length === 1, 'unrelated child result arrives automatically once');
      const siblingSnapshot = await inspect(ctx, sibling.name);
      assertCompletedEvidence(siblingSnapshot);
      save('first-report', { ok: true, parentSession: ctx.sessionManager.getSessionFile(),
        children: [runningSnapshot, waitingSnapshot, siblingSnapshot], finished, runningProcesses, waitingProcesses,
        checks: ['running-inspect', 'stale-id-refused', 'running-stop', 'double-stop', 'late-input-refused', 'deliberate-resume',
          'waiting-inspect', 'waiting-stop', 'parent-sibling-preserved', 'automatic-result'] });
    } catch (error: any) { save('first-report', { ok: false, error: error?.stack ?? String(error) }); }
  } });

  pi.registerCommand('live-inspect-stop-restart', { description: 'Inspect saved handles after restarting the real parent', handler: async (_args: string, ctx: any) => {
    try {
      const first = JSON.parse(readFileSync(join(dir, 'first-report.json'), 'utf8'));
      const beforePanes = panes();
      const beforeChildren = first.children.map((item: any) => readFileSync(item.sessionFile, 'utf8'));
      assert.equal(__test__.runningSubagents.size, 0, 'restart must have no in-memory children');
      const snapshots = [];
      for (const item of first.children) {
        const snapshot = await inspect(ctx, item.name);
        if (item.name === 'live-waiting') {
          assert.equal(snapshot.state, 'stopped');
          assert.equal(snapshot.stale, false);
        } else assertCompletedEvidence(snapshot);
        assert.equal(snapshot.sessionFile, item.sessionFile);
        snapshots.push(snapshot);
      }
      assert.deepEqual(panes(), beforePanes, 'persisted inspection cannot launch or resume panes');
      assert.deepEqual(first.children.map((item: any) => readFileSync(item.sessionFile, 'utf8')), beforeChildren,
        'persisted inspection must not mutate child transcripts');
      const waiting = snapshots.find(item => item.name === 'live-waiting')!;
      await stop(ctx, waiting.name, waiting.id);
      await rejectLate(ctx, waiting.name, waiting.sessionFile);
      const resumeWaitingTask = 'This is the deliberate next task after the stop. Ignore the old unanswered question; do not create forbidden-late-reply. ' + bashTask('printf RESUMED_WAITING > waiting-resumed');
      const resumed = await invoke(ctx, 'subagent_message', { name: waiting.name, resume: true, message: resumeWaitingTask });
      assert.equal(resumed.details.status, 'started', JSON.stringify(resumed));
      assert.notEqual(resumed.details.id, waiting.id);
      assert.equal(resumed.details.sessionFile, waiting.sessionFile);
      assert.equal(resumed.details.sessionId, waiting.sessionId);
      await until(() => existsSync(join(dir, 'waiting-resumed')) && !child(waiting.name), 'deliberately resumed waiter completes');
      await until(() => automaticResults(ctx, waiting.name, resumeWaitingTask).length === 1, 'restarted parent receives exactly one result from the resumed task');
      const final = await inspect(ctx, waiting.name);
      assertCompletedEvidence(final);
      assert.equal(surfaceExists(process.env.TMUX_PANE!), true);
      save('restart-report', { ok: true, snapshots, final, checks: ['persisted-inspect-readonly', 'persisted-double-stop', 'persisted-late-reply-refused', 'deliberate-waiter-resume'] });
    } catch (error: any) { save('restart-report', { ok: false, error: error?.stack ?? String(error) }); }
  } });
}
