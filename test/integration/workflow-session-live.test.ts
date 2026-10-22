import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { integrationRuntime } from './runtime.ts';
import { integrationModel } from './model.ts';
import { cleanupSession } from './cleanup.ts';
import { shellEscape } from '../../pi-extension/subagents/tmux.ts';

it('real workflow survives reload, records child crash, and drains parent shutdown', { skip: process.env.PI_WORKFLOW_LIVE !== '1', timeout: 600_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-session-live-'));
  const root = resolve(import.meta.dirname, '../..');
  const session = 'pi-session-live-' + process.pid + '-' + Date.now();
  console.log('Session lifecycle evidence: ' + dir);
  t.after(() => cleanupSession(session, dir, { preserveArtifacts: true }));
  const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  const until = async (check: () => boolean, label: string) => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.fail(label + '; evidence: ' + dir);
  };
  mkdirSync(join(dir, '.pi', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.pi', 'agents', 'worker.md'), readFileSync(join(root, 'agents/worker.md'), 'utf8').replace(/^thinking: .*$/m, 'thinking: off'));
  const pane = tmux('new-session', '-d', '-s', session, '-x', '140', '-y', '42', '-P', '-F', '#{pane_id}');
  const runtime = integrationRuntime();
  const command = `cd ${shellEscape(dir)} && env PATH=${shellEscape(runtime.path)} PI_OFFLINE=1 PI_SESSION_LIVE_DIR=${shellEscape(dir)} PI_SUBAGENT_SHELL_READY_DELAY_MS=100 ${shellEscape(runtime.executable)} -ne -ns -np -nc --no-mcp --approve --model ${shellEscape(integrationModel())} --thinking off -e ${shellEscape(join(root, 'test/integration/fixtures/workflow-session-live.ts'))} --session ${shellEscape(join(dir, 'parent.jsonl'))} 2>>${shellEscape(join(dir, 'parent-stderr.log'))}; echo $? > ${shellEscape(join(dir, 'parent-exit'))}; sleep 120`;
  tmux('respawn-pane', '-k', '-t', pane, command);
  const send = (text: string) => tmux('send-keys', '-t', pane, text, 'Enter');
  const record = (tag: string) => json(join(dir, tag + '.json'));
  const snapshot = (tag: string) => json(join(record(tag).runDir, 'snapshot.json'));
  const journal = (tag: string) => readFileSync(join(record(tag).runDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const paneIds = () => tmux('list-panes', '-s', '-t', session, '-F', '#{pane_id}').split('\n');
  const begin = async (tag: string) => {
    send('/lifecycle-start ' + tag);
    await until(() => existsSync(join(dir, tag + '.json')) && existsSync(join(dir, tag + '-blocked')), tag + ' blocks in real bash');
    assert.equal(snapshot(tag).status, 'running');
  };
  const beginManual = async (tag: string) => {
    send('/lifecycle-manual ' + tag);
    await until(() => existsSync(join(dir, tag + '-manual-start')), 'manual child runs before ' + tag);
  };
  await until(() => existsSync(join(dir, 'ready.json')), 'parent ready');
  await begin('reload');
  await beginManual('reload');
  send('/reload');
  await until(() => json(join(dir, 'ready.json')).generation === 2, 'actual Pi reload finished');
  assert.equal(snapshot('reload').status, 'aborted');
  assert.equal(existsSync(join(record('reload').runDir, 'lock')), false);
  assert.equal(existsSync(join(dir, 'shutdown-1.json')), true);
  assert.equal(paneIds().length, 1, 'reload must not leave child panes');
  assert.equal(journal('reload').at(-1).status, 'aborted');
  const stopped = journal('reload').at(-1);
  assert.equal(existsSync(stopped.sessionFile + '.workflow-aborted'), true, 'abort marker must precede registry teardown');
  writeFileSync(join(dir, 'reload-release'), 'release');
  send('/lifecycle-resume reload');
  await until(() => snapshot('reload').status === 'completed', 'disk resume completes after reload');
  assert.equal(readFileSync(join(dir, 'reload-saved'), 'utf8'), 'once\n', 'completed side effect must not repeat');
  assert.equal(readFileSync(join(dir, 'reload-blocked'), 'utf8'), 'started\nstarted\n');

  await begin('crash');
  const crashedPane = paneIds().find(id => id !== pane)!;
  assert.ok(crashedPane);
  tmux('kill-pane', '-t', crashedPane);
  await until(() => snapshot('crash').status === 'failed' && !existsSync(join(record('crash').runDir, 'lock')), 'unreported child exit reaches failed workflow');
  assert.equal(journal('crash').at(-1).status, 'failed');
  assert.equal(existsSync(join(record('crash').runDir, 'lock')), false);
  assert.equal(existsSync(join(dir, 'crash-done')), false);

  await begin('quit');
  await beginManual('quit');
  send('/quit');
  await until(() => existsSync(join(dir, 'parent-exit')), 'actual parent exits');
  assert.equal(snapshot('quit').status, 'aborted');
  assert.equal(existsSync(join(record('quit').runDir, 'lock')), false);
  assert.equal(paneIds().length, 1, 'parent exit must close children before process.exit');
  assert.equal(existsSync(join(dir, 'quit-done')), false);
  rmSync(join(dir, 'parent-exit'));
  tmux('respawn-pane', '-k', '-t', pane, command);
  await until(() => json(join(dir, 'ready.json')).generation === 3, 'new parent process ready');
  await begin('signal');
  await beginManual('signal');
  process.kill(json(join(dir, 'ready.json')).pid, 'SIGTERM');
  await until(() => existsSync(join(dir, 'parent-exit')), 'SIGTERM finishes graceful shutdown');
  assert.equal(snapshot('signal').status, 'aborted');
  assert.equal(existsSync(join(record('signal').runDir, 'lock')), false);
  assert.equal(paneIds().length, 1);
  assert.equal(existsSync(join(dir, 'signal-done')), false);
  assert.doesNotMatch(readFileSync(join(dir, 'parent-stderr.log'), 'utf8'), /stale after session replacement or reload|UnhandledPromiseRejection/);
  for (const tag of ['reload', 'crash', 'quit', 'signal']) {
    for (const entry of journal(tag).filter(row => row.status === 'completed')) {
      const rows = readFileSync(entry.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(rows.some(row => row.message?.role === 'assistant' && row.message.usage?.output > 0));
      assert.ok(rows.some(row => Array.isArray(row.message?.content) && row.message.content.some((part: any) => part.type === 'toolCall')));
    }
  }
  writeFileSync(join(dir, 'passed.json'), JSON.stringify({ checks: ['reload-abort', 'reload-resume', 'child-crash', 'parent-quit', 'parent-sigterm'] }));
});
