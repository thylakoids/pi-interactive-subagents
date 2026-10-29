import './tmux-isolation.ts';
/** Opt-in real Pi/provider/process coverage for named inspection and stop. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { shellEscape } from '../../pi-extension/subagents/tmux.ts';
import { cleanupSession } from './cleanup.ts';
import { integrationModel } from './model.ts';
import { integrationRuntime } from './runtime.ts';

it('real children inspect without input, stop safely, and deliberately resume across parent restart', {
  skip: process.env.PI_WORKFLOW_LIVE !== '1', timeout: 900_000,
}, async t => {
  const model = integrationModel();
  const root = resolve(import.meta.dirname, '../..');
  const dir = mkdtempSync(join(tmpdir(), 'pi-inspect-stop-live-'));
  const session = `pi-inspect-stop-live-${process.pid}-${Date.now()}`;
  t.after(() => cleanupSession(session, dir, { preserveArtifacts: true }));
  const tmux = (...args: string[]) => execFileSync('tmux', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const agents = join(dir, '.pi', 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'inspect-stop-probe.md'), [
    '---', 'name: inspect-stop-probe', 'description: Live lifecycle probe',
    'tools: bash, read, write', 'thinking: off', 'auto-exit: true', '---',
    'Follow the exact test task. Use actual tools; plain text does not execute them.',
    'Do not delegate, inspect parent artifacts, or add setup and cleanup commands.',
  ].join('\n'));
  const parentFile = join(dir, 'parent.jsonl');
  const pane = tmux('new-session', '-d', '-s', session, '-x', '140', '-y', '42', '-P', '-F', '#{pane_id}');
  const runtime = integrationRuntime();
  const launch = (phase: string) => {
    const command = `cd ${shellEscape(dir)} && env PATH=${shellEscape(runtime.path)} PI_OFFLINE=1 PI_INSPECT_STOP_LIVE_DIR=${shellEscape(dir)} PI_TEST_MODEL=${shellEscape(model)} PI_SUBAGENT_SHELL_READY_DELAY_MS=100 ${shellEscape(runtime.executable)} -ne -ns -np -nc --no-mcp --approve --model ${shellEscape(model)} --thinking off -e ${shellEscape(join(root, 'test/integration/fixtures/subagent-inspect-stop-live.ts'))} --session ${shellEscape(parentFile)} 2>${shellEscape(join(dir, phase + '-stderr.log'))}; status=$?; echo $status >${shellEscape(join(dir, phase + '-exit'))}; sleep 120`;
    tmux('respawn-pane', '-k', '-t', pane, command);
  };
  const until = async (check: () => boolean, label: string, timeout = 360_000) => {
    const deadline = Date.now() + timeout;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(check(), label + '; retained evidence: ' + dir + '\n' + tmux('capture-pane', '-p', '-S', '-100', '-t', pane));
  };
  const generation = () => existsSync(join(dir, 'generation')) ? Number(readFileSync(join(dir, 'generation'), 'utf8')) : 0;
  launch('first');
  await until(() => generation() === 1, 'parent Pi starts', 30_000);
  tmux('send-keys', '-t', pane, '/live-inspect-stop', 'Enter');
  await until(() => existsSync(join(dir, 'first-report.json')), 'live lifecycle probe finishes');
  const first = JSON.parse(readFileSync(join(dir, 'first-report.json'), 'utf8'));
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(first.checks, ['running-inspect', 'stale-id-refused', 'running-stop', 'double-stop',
    'late-input-refused', 'deliberate-resume', 'waiting-inspect', 'waiting-stop', 'parent-sibling-preserved', 'automatic-result']);
  tmux('send-keys', '-t', pane, '/quit', 'Enter');
  await until(() => existsSync(join(dir, 'first-exit')), 'original parent exits', 30_000);
  assert.equal(readFileSync(join(dir, 'first-exit'), 'utf8').trim(), '0');
  launch('restart');
  await until(() => generation() === 2, 'same parent session restarts', 30_000);
  tmux('send-keys', '-t', pane, '/live-inspect-stop-restart', 'Enter');
  await until(() => existsSync(join(dir, 'restart-report.json')), 'persisted inspection and explicit resume finish');
  const restarted = JSON.parse(readFileSync(join(dir, 'restart-report.json'), 'utf8'));
  assert.equal(restarted.ok, true, restarted.error);
  assert.deepEqual(restarted.checks, ['persisted-inspect-readonly', 'persisted-double-stop', 'persisted-late-reply-refused', 'deliberate-waiter-resume']);
  for (const child of first.children) {
    const rows = readFileSync(child.sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(rows.some(row => row.message?.role === 'assistant' &&
      ((row.message.usage?.input ?? 0) > 0 || (row.message.usage?.output ?? 0) > 0)),
    'Every child must have real provider usage: ' + child.name);
    const calls = rows.flatMap(row => row.message?.role === 'assistant'
      ? row.message.content.filter((part: any) => part.type === 'toolCall') : []);
    assert.ok(calls.some(call => call.name === (child.name === 'live-waiting' ? 'ask_question' : 'bash')));
  }
  assert.equal(readFileSync(join(dir, 'running-resumed'), 'utf8').trim(), 'RESUMED_RUNNING');
  assert.equal(readFileSync(join(dir, 'waiting-resumed'), 'utf8').trim(), 'RESUMED_WAITING');
  assert.equal(readFileSync(join(dir, 'sibling-done'), 'utf8'), 'done');
  assert.equal(existsSync(join(dir, 'running-done')), false, 'stopped original blocking tool cannot complete later');
  assert.equal(existsSync(join(dir, 'forbidden-late-reply')), false, 'stopped waiter must not consume late replies');
  writeFileSync(join(dir, 'parent-screen.txt'), tmux('capture-pane', '-p', '-S', '-300', '-t', pane));
  t.diagnostic('Real provider responses, tool processes and persisted lifecycle evidence retained: ' + dir);
});
