import './tmux-isolation.ts';
/** Opt-in billed provider E2E. Run only with PI_WORKFLOW_REVIEW_LIVE=1 and PI_TEST_MODEL. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { processGroupAlive, isSafeToSignal } from '../helpers/readonly-process.ts';
import { tmpdir } from 'node:os';
import { shellEscape } from '../../pi-extension/subagents/tmux.ts';
import { readSubagentLoadout } from '../../pi-extension/subagents/session.ts';
import { integrationRuntime } from './runtime.ts';
import { integrationModel } from './model.ts';
import { cleanupSession } from './cleanup.ts';
import { isCacheEffectCommand, isStallRecoveryCommand } from './live-evidence.ts';

const rows = (file: string): any[] => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const script = (name: string, body: string) => `export const meta = ${JSON.stringify({ name, description: 'Saved live probe' })}\n${body}`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it('billed workflows prove cache, schema, worktree, nested limits and stall recovery', {
  skip: process.env.PI_WORKFLOW_REVIEW_LIVE !== '1', timeout: 1_200_000,
}, async t => {
  const model = integrationModel();
  const root = resolve(import.meta.dirname, '../..');
  const dir = mkdtempSync(join(tmpdir(), 'pi-workflow-review-live-'));
  const session = `pi-wf-review-${process.pid}-${Date.now()}`;
  console.log(`Billed model: ${model}; retained evidence: ${dir}`);
  t.after(() => cleanupSession(session, dir, { preserveArtifacts: true }));
  const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  mkdirSync(join(dir, '.pi', 'agents'), { recursive: true });
  for (const name of ['worker', 'scout', 'researcher']) {
    writeFileSync(join(dir, '.pi', 'agents', name + '.md'), readFileSync(join(root, 'agents', name + '.md'), 'utf8').replace(/^thinking: .*$/m, 'thinking: off'));
  }
  const expected = { meta: { token: `live-${Date.now()}`, nested: { verified: true, count: 7 }, labels: ['real', 'provider'] } };
  writeFileSync(join(dir, 'schema-input.json'), JSON.stringify(expected));
  writeFileSync(join(dir, 'tracked.txt'), 'committed\n');
  git('init', '-q');
  git('add', 'tracked.txt');
  git('-c', 'user.name=Workflow Test', '-c', 'user.email=workflow-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed live test');
  writeFileSync(join(dir, 'tracked.txt'), 'main-dirty\n');
  const originalHead = git('rev-parse', 'HEAD');
  mkdirSync(join(dir, '.pi', 'workflows'), { recursive: true });
  const nestedPrompt = 'Use bash exactly once to execute this fenced command:\n```sh\nprintf "TOKEN\\n" >> nested-effects\n```\nThen reply NESTED_DONE.';
  writeFileSync(join(dir, '.pi', 'workflows', 'review-live-child.js'), script('review-live-child',
    `return await agent(${JSON.stringify(nestedPrompt)}.replace('TOKEN', args.token));`));
  writeFileSync(join(dir, '.pi', 'workflows', 'review-live-recursive.js'), script('review-live-recursive',
    `return await workflow('review-live-recursive', {});`));
  writeFileSync(join(dir, '.pi', 'workflows', 'review-live-broken.js'), script('review-live-broken',
    `throw new Error('REVIEW_LIVE_NESTED_AUTHOR_ERROR');`));
  const runtime = integrationRuntime();
  const pane = tmux('new-session', '-d', '-s', session, '-x', '140', '-y', '42', '-P', '-F', '#{pane_id}');
  const command = `cd ${shellEscape(dir)} && env PATH=${shellEscape(runtime.path)} PI_OFFLINE=1 PI_WORKFLOW_REVIEW_LIVE_DIR=${shellEscape(dir)} PI_TEST_MODEL=${shellEscape(model)} PI_SUBAGENT_SHELL_READY_DELAY_MS=100 ${shellEscape(runtime.executable)} -ne -ns -np -nc --no-mcp --approve --model ${shellEscape(model)} --thinking off -e ${shellEscape(join(root, 'test/integration/fixtures/workflow-review-live.ts'))} --session ${shellEscape(join(dir, 'parent.jsonl'))} 2>${shellEscape(join(dir, 'startup-error.log'))}; status=$?; echo $status >${shellEscape(join(dir, 'parent-exit.txt'))}; sleep 120`;
  writeFileSync(join(dir, 'launch-command.sh'), command + '\n');
  tmux('respawn-pane', '-k', '-t', pane, command);
  const deadline = Date.now() + 1_150_000;
  const readyDeadline = Date.now() + 30_000;
  while (!existsSync(join(dir, 'ready')) && Date.now() < readyDeadline) await delay(200);
  assert.ok(existsSync(join(dir, 'ready')), tmux('capture-pane', '-p', '-t', pane));
  tmux('send-keys', '-t', pane, '/review-live', 'Enter');
  while (!existsSync(join(dir, 'report.json')) && Date.now() < deadline) await delay(500);
  writeFileSync(join(dir, 'parent-screen.txt'), tmux('capture-pane', '-p', '-S', '-300', '-t', pane));
  assert.ok(existsSync(join(dir, 'report.json')), `Timed out; evidence: ${dir}`);
  const report = json(join(dir, 'report.json'));
  assert.equal(report.ok, true, report.error);
  assert.deepEqual(report.checks.slice(0, 6), ['fresh-first', 'fresh-second', 'explicit-reuse', 'borrowed-resume', 'renamed-resume', 'nested-schema']);

  const view = (name: string) => json(join(dir, name + '.json'));
  const evidence = (value: any) => {
    const snapshot = json(join(value.runDir, 'snapshot.json'));
    assert.equal(snapshot.status, value.status);
    assert.deepEqual(snapshot.result, value.result);
    const journal = rows(join(value.runDir, 'journal.jsonl'));
    for (const call of value.calls) {
      assert.ok(journal.some(row => row.callKey === call.callKey && row.status === 'completed' && row.sessionFile === call.sessionFile), 'completed call must retain its journal evidence');
      const transcript = rows(call.sessionFile);
      const messages = transcript.filter(row => row.type === 'message').map(row => row.message);
      const responses = messages.filter(message => message.role === 'assistant');
      assert.ok(responses.some(message => message.usage?.input > 0 || message.usage?.output > 0), 'actual provider response with usage required');
      const calls = responses.flatMap(message => message.content ?? []).filter(part => part.type === 'toolCall');
      const results = messages.filter(message => message.role === 'toolResult');
      assert.ok(calls.length > 0);
      for (const tool of calls) assert.ok(results.some(result => result.toolCallId === tool.id), 'actual tool result required for ' + tool.name);
      assert.equal(readSubagentLoadout(call.sessionFile)?.model, model);
    }
  };
  for (const name of ['fresh-first', 'fresh-second', 'explicit-reuse', 'borrowed-resume', 'renamed-resume', 'nested-schema']) evidence(view(name));
  const first = view('fresh-first').calls[0];
  const second = view('fresh-second').calls[0];
  assert.notEqual(first.sessionFile, second.sessionFile);
  assert.notEqual(first.cached, true);
  assert.notEqual(second.cached, true);
  for (const name of ['explicit-reuse', 'borrowed-resume', 'renamed-resume']) {
    const call = view(name).calls[0];
    assert.equal(call.cached, true);
    assert.equal(call.sessionFile, second.sessionFile);
    assert.equal(call.callKey, second.callKey);
  }
  const borrowed = view('explicit-reuse');
  assert.ok(rows(join(borrowed.runDir, 'journal.jsonl')).some(row => row.callKey === second.callKey && row.replayed === true && row.sessionFile === second.sessionFile));
  assert.equal(view('borrowed-resume').runId, borrowed.runId);
  assert.equal(view('renamed-resume').calls[0].label, 'renamed');
  assert.equal(readFileSync(join(dir, 'cache-effects'), 'utf8'), 'effect\neffect\n');
  for (const call of [first, second]) {
    const messages = rows(call.sessionFile).filter(row => row.type === 'message').map(row => row.message);
    const bash = messages.filter(m => m.role === 'assistant').flatMap(m => m.content ?? []).filter(isCacheEffectCommand);
    assert.equal(bash.length, 1, 'one real side-effect command per fresh session');
    assert.ok(messages.some(m => m.role === 'toolResult' && m.toolCallId === bash[0].id && !m.isError));
  }
  const structured = view('nested-schema');
  assert.deepEqual(structured.result, expected);
  assert.deepEqual(json(join(structured.runDir, 'calls', structured.calls[0].callKey, 'result.json')), { ok: true, value: expected });
  assert.deepEqual(json(join(structured.runDir, 'calls', structured.calls[0].callKey, 'schema.json')),
    { type: 'object', required: ['meta'], properties: { meta: { type: 'object' } } });
  const messages = rows(structured.calls[0].sessionFile).filter(row => row.type === 'message').map(row => row.message);
  const structuredCalls = messages.filter(m => m.role === 'assistant').flatMap(m => m.content ?? []).filter(p => p.type === 'toolCall' && p.name === 'structured_output');
  assert.ok(structuredCalls.some(p => assertObject(p.arguments, expected)
    && messages.some(m => m.role === 'toolResult' && m.toolCallId === p.id && !m.isError && m.details?.recorded === true)),
  'the exact nested payload must be accepted by a real structured_output execution');
  assert.ok(messages.some(m => m.role === 'assistant' && m.content?.some((p: any) => p.type === 'toolCall' && p.name === 'read' && JSON.stringify(p.arguments).includes('schema-input.json'))));

  {
    const isolated = view('worktree');
    evidence(isolated);
    const cwd = join(isolated.runDir, 'worktrees', isolated.calls[0].callKey);
    assert.notEqual(realpathSync(cwd), realpathSync(dir));
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), originalHead);
    assert.equal(readFileSync(join(cwd, 'tracked.txt'), 'utf8'), 'isolated\n');
    assert.equal(readFileSync(join(cwd, 'worktree-only.txt'), 'utf8'), 'created\n');
    assert.equal(readFileSync(join(cwd, 'isolated-effects'), 'utf8'), 'once\n');
    const replay = view('worktree-resume');
    evidence(replay);
    assert.equal(replay.calls[0].cached, true);
    assert.equal(replay.calls[0].label, 'renamed-isolated');
    assert.equal(replay.calls[0].sessionFile, isolated.calls[0].sessionFile);
    const bashResults = rows(isolated.calls[0].sessionFile).filter(r => r.type === 'message' && r.message?.role === 'toolResult' && r.message.toolName === 'bash');
    assert.ok(bashResults.some(r => r.message.content?.some((p: any) => p.type === 'text' && p.text.includes(realpathSync(cwd)))));
  }
  assert.equal(readFileSync(join(dir, 'tracked.txt'), 'utf8'), 'main-dirty\n');
  assert.equal(git('rev-parse', 'HEAD'), originalHead);
  assert.equal(existsSync(join(dir, 'worktree-only.txt')), false);
  {
    const nested = view('nested-saved');
    evidence(nested);
    assert.equal(nested.calls.length, 1, 'child agents are flat calls in the parent run');
    const savedChildren = readdirSync(join(nested.runDir, 'nested'));
    assert.equal(savedChildren.length, 1);
    assert.match(savedChildren[0], /^[a-f0-9]+(?:-\d+)?\.js$/);
    assert.equal(readFileSync(join(nested.runDir, 'nested', savedChildren[0]), 'utf8'),
      readFileSync(join(dir, '.pi', 'workflows', 'review-live-child.js'), 'utf8'));
    assert.equal(readFileSync(join(dir, 'nested-effects'), 'utf8'), 'NESTED_REAL\n');
    assert.equal(view('nested-limit').status, 'failed');
    assert.match(view('nested-limit').error, /Maximum nested workflow depth is one/);
    assert.doesNotMatch(view('nested-limit').error, /not supported by this build|not available/i);
    assert.equal(view('nested-author-error').status, 'failed');
    assert.match(view('nested-author-error').error, /Child workflow "review-live-broken" failed:.*REVIEW_LIVE_NESTED_AUTHOR_ERROR/s);
    for (const name of ['nested-limit', 'nested-author-error']) {
      assert.equal(json(join(view(name).runDir, 'snapshot.json')).status, 'failed');
      assert.equal(view(name).calls.length, 0, 'author errors must propagate without spawning an agent');
    }
  }
  for (const name of ['stall-default', 'stall-retry']) {
    const value = view(name);
    const running = view(name + '-running');
    const stopped = view(name + '-stopped');
    const journal = rows(join(value.runDir, 'journal.jsonl'));
    assert.deepEqual(journal.map(row => row.status), name === 'stall-retry' ? ['failed', 'completed'] : ['failed']);
    assert.ok(journal.every(row => row.callKey === running.first.callKey));
    assert.equal(journal[0].sessionFile, running.first.sessionFile);
    assert.match(journal[0].error, /stopped|timeout|ceiling|stall|limit/i);
    assert.equal(isSafeToSignal(running.pgid), true);
    assert.equal(running.groupAlive, true);
    assert.ok(running.processes.some((row: string) => new RegExp('^\\s*' + running.pid + '\\s+').test(row)
      && row.includes('first.pid')), 'retained ps evidence must attribute the live marker command');
    assert.equal(stopped.groupAlive, false);
    assert.equal(processGroupAlive(running.pgid), false);
    assert.ok(!stopped.remainingPanes.includes(running.pane));
    const livePanes = tmux('list-panes', '-a', '-F', '#{pane_id}').split('\n');
    assert.ok(!livePanes.includes(running.pane));
    assert.equal(readFileSync(join(running.cwd, 'first.pid'), 'utf8').trim(), String(running.pid));
    assert.equal(existsSync(join(running.cwd, 'leaked')), false);
    assert.equal(existsSync(join(dir, 'first.pid')), false);
    assert.equal(existsSync(join(dir, 'recovered')), false);
    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    for (const attempt of journal) {
      const messages = rows(attempt.sessionFile).filter(row => row.type === 'message').map(row => row.message);
      const responses = messages.filter(m => m.role === 'assistant');
      assert.ok(responses.some(m => m.usage?.input > 0 || m.usage?.output > 0), 'every attempt must have a real billed response');
      cumulativeInput += responses.reduce((sum, m) => sum + (m.usage?.input ?? 0), 0);
      cumulativeOutput += responses.reduce((sum, m) => sum + (m.usage?.output ?? 0), 0);
      assert.equal(attempt.usage?.inputTokens, cumulativeInput, 'journal usage includes all attempts so far');
      assert.equal(attempt.usage?.outputTokens, cumulativeOutput);
      assert.equal(attempt.usage?.totalTokens, cumulativeInput + cumulativeOutput);
      assert.equal(readSubagentLoadout(attempt.sessionFile)?.model, model);
      const bash = responses.flatMap(m => m.content ?? []).filter(isStallRecoveryCommand);
      assert.equal(bash.length, 1, 'each attempt must actually execute the conditional marker command once');
      assert.match(bash[0].arguments.command, /sleep 90/);
      if (attempt.status === 'completed') {
        assert.ok(messages.some(m => m.role === 'toolResult' && m.toolCallId === bash[0].id && !m.isError));
        const outputs = responses.flatMap(m => m.content ?? []).filter(p => p.type === 'toolCall' && p.name === 'structured_output');
        assert.ok(outputs.some(p => assertObject(p.arguments, { status: 'recovered' }) && messages.some(m => m.role === 'toolResult' && m.toolCallId === p.id && m.details?.recorded === true && !m.isError)));
      }
      // A killed bash may never emit toolResult; its live PID/group evidence
      // and persisted toolCall, rather than a fabricated success, prove entry.
    }
    if (name === 'stall-retry') {
      assert.equal(new Set(journal.map(row => row.sessionFile)).size, 2);
      assert.notEqual(journal[0].name, journal[1].name);
      assert.deepEqual(value.result, { status: 'recovered' });
      assert.equal(readFileSync(join(running.cwd, 'recovered'), 'utf8'), 'recovered\n');
      assert.deepEqual(json(join(value.runDir, 'calls', running.first.callKey, 'result.json')), { ok: true, value: { status: 'recovered' } });
    } else {
      assert.equal(value.result, null);
      assert.equal(existsSync(join(running.cwd, 'recovered')), false);
    }
    const snapshot = json(join(value.runDir, 'snapshot.json'));
    assert.equal(value.calls[0].usage?.totalTokens, cumulativeInput + cumulativeOutput);
    assert.equal(value.usage?.totalTokens, cumulativeInput + cumulativeOutput, 'failed attempt usage must not be lost or counted twice');
    assert.equal(snapshot.status, 'completed');
    assert.deepEqual(snapshot.result, value.result);
  }
  const terminal = view('terminal-failure-first');
  assert.equal(terminal.status, 'failed');
  assert.match(terminal.error, /budget exhausted/);
  assert.equal(terminal.calls.length, 2);
  assert.equal(terminal.calls[0].status, 'completed');
  assert.ok(terminal.calls[0].usage.totalTokens > 1);
  assert.equal(terminal.calls[1].status, 'aborted');
  assert.equal(terminal.calls[1].sessionFile, undefined);
  assert.equal(readFileSync(join(dir, 'terminal-charge'), 'utf8').trim(), 'charged');
  evidence({ ...terminal, calls: [terminal.calls[0]] });
  assert.deepEqual(report.checks, ['fresh-first', 'fresh-second', 'explicit-reuse', 'borrowed-resume', 'renamed-resume', 'nested-schema',
    'worktree', 'worktree-resume', 'nested-saved', 'nested-limit', 'nested-author-error', 'stall-default', 'stall-retry', 'terminal-failure-first']);
});

function assertObject(actual: unknown, expected: unknown): boolean {
  try { assert.deepEqual(actual, expected); return true; } catch { return false; }
}
