import './tmux-isolation.ts';
import { integrationRuntime } from './runtime.ts';
/** Opt-in, billed live-model coverage. No service or model substitutions. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { shellEscape } from '../../pi-extension/subagents/tmux.ts';
import { cleanupSession } from './cleanup.ts';

import { integrationModel } from './model.ts';

const live = process.env.PI_WORKFLOW_LIVE === '1';
it('real parent answers workflow questions, worker delegates, and waiting workflow can Abort', { skip: !live, timeout: 1_200_000 }, async t => {
  const root = resolve(import.meta.dirname, '../..');
  const dir = mkdtempSync(join(tmpdir(), 'pi-workflow-collaboration-'));
  const session = 'pi-wf-collab-' + process.pid + '-' + Date.now();
  const model = integrationModel();
  console.log('Live model: ' + model + '; retained evidence: ' + dir);
  // Retain all sessions, scripts, journals and tool-side markers after success
  // or failure; remove only our tmux processes.
  t.after(() => cleanupSession(session, dir, { preserveArtifacts: true }));
  const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const agentsDir = join(dir, '.pi', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  // Real bundled identities/tools; omit model so the parent model is inherited.
  // Keep reasoning low for this billed test, not in the shipped definitions.
  for (const name of ['worker', 'scout', 'researcher']) {
    const definition = readFileSync(join(root, 'agents', name + '.md'), 'utf8')
      .replace(/^thinking: .*$/m, 'thinking: off');
    writeFileSync(join(agentsDir, name + '.md'), definition);
  }
  writeFileSync(join(dir, 'fixture.txt'), 'SCOUT_READ_OK\n');
  for (const [name, child] of [['branch', 'relay'], ['relay', 'leaf'], ['leaf', '']] as const) {
    writeFileSync(join(agentsDir, name + '.md'), `---\nname: ${name}\ndescription: Live delegation probe\ntools: bash\nthinking: off\nauto-exit: true\n${child ? 'subagent_agents: ' + child + '\n' : ''}---\nFollow the supplied task exactly. If asked to delegate, use subagent and wait for its actual result. Do not replace delegation with your own work.\n`);
  }
  const pane = tmux('new-session', '-d', '-s', session, '-x', '140', '-y', '42', '-P', '-F', '#{pane_id}');
  const runtime = integrationRuntime();
  const command = `cd ${shellEscape(dir)} && env PATH=${shellEscape(runtime.path)} PI_OFFLINE=1 PI_WORKFLOW_LIVE_DIR=${shellEscape(dir)} PI_TEST_MODEL=${shellEscape(model)} PI_WORKFLOW_MAX_CONCURRENT_AGENTS=4 PI_SUBAGENT_SHELL_READY_DELAY_MS=100 ${shellEscape(runtime.executable)} -ne -ns -np -nc --no-mcp --approve --model ${shellEscape(model)} --thinking off -e ${shellEscape(join(root, 'test/integration/fixtures/workflow-collaboration-live.ts'))} --session ${shellEscape(join(dir, 'parent.jsonl'))} 2>${shellEscape(join(dir, 'startup-error.log'))}; status=$?; echo $status >${shellEscape(join(dir, 'parent-exit.txt'))}; sleep 120`;
  writeFileSync(join(dir, 'launch-command.sh'), command + '\n');
  tmux('respawn-pane', '-k', '-t', pane, command);
  const deadline = Date.now() + 1_150_000;
  const startupDeadline = Date.now() + 30_000;
  while (!existsSync(join(dir, 'ready')) && Date.now() < startupDeadline) await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(existsSync(join(dir, 'ready')), (existsSync(join(dir, 'startup-error.log')) ? readFileSync(join(dir, 'startup-error.log'), 'utf8') : '') + tmux('capture-pane', '-p', '-t', pane));
  tmux('send-keys', '-t', pane, '/live-collaboration', 'Enter');
  while (!existsSync(join(dir, 'report.json')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1000));
  writeFileSync(join(dir, 'parent-screen.txt'), tmux('capture-pane', '-p', '-S', '-300', '-t', pane));
  assert.ok(existsSync(join(dir, 'report.json')), 'Timed out; inspect retained sessions and events in ' + dir);
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(report.ok, true, report.error);
  assert.deepEqual(report.checks, ['real-parent-reply', 'same-session-continuation', 'real-scout-delegation', 'waiting-state', 'abort-while-waiting', 'disk-terminal-state', 'late-reply-rejected', 'blocked-delegation-retry', 'multilevel-abort-resume-isolation']);
});
