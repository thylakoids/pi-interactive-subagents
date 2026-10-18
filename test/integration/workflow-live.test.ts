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
import { ACCEPTANCE_SOURCE, verifyLiveEvidence } from './live-evidence.ts';

import { integrationModel } from './model.ts';

const live = process.env.PI_WORKFLOW_LIVE === '1';
it('real models execute old templates, advance pipeline independently and recover after Abort', { skip: !live, timeout: 1_200_000 }, async t => {
  const root = resolve(import.meta.dirname, '../..');
  const dir = mkdtempSync(join(tmpdir(), 'pi-workflow-live-'));
  const session = 'pi-wf-live-' + process.pid + '-' + Date.now();
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
  writeFileSync(join(dir, 'CONTRACT.md'), 'isAdult(age) must return true for age >= 18 and false below 18.\n');
  writeFileSync(join(dir, 'eligibility.cjs'), 'exports.isAdult = age => age >= 18;\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('add', 'eligibility.cjs', 'CONTRACT.md');
  git('-c', 'user.name=Workflow Test', '-c', 'user.email=workflow-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed test contract');
  writeFileSync(join(dir, 'eligibility.cjs'), 'exports.isAdult = age => age > 18;\n');
  writeFileSync(join(dir, 'safe.cjs'), 'exports.double = x => { const oldValue = x * 2; return oldValue; };\n');
  writeFileSync(join(dir, 'risky.cjs'), 'exports.isAdult = age => age > 18;\n');
  writeFileSync(join(dir, 'test.cjs'), ACCEPTANCE_SOURCE);
  const pane = tmux('new-session', '-d', '-s', session, '-x', '140', '-y', '42', '-P', '-F', '#{pane_id}');
  const runtime = integrationRuntime();
  const command = `cd ${shellEscape(dir)} && env PATH=${shellEscape(runtime.path)} PI_OFFLINE=1 PI_WORKFLOW_LIVE_DIR=${shellEscape(dir)} PI_TEST_MODEL=${shellEscape(model)} PI_WORKFLOW_MAX_CONCURRENT_AGENTS=4 PI_SUBAGENT_SHELL_READY_DELAY_MS=100 ${shellEscape(runtime.executable)} -ne -ns -np -nc --no-mcp --approve --model ${shellEscape(model)} --thinking off -e ${shellEscape(join(root, 'test/integration/fixtures/workflow-live.ts'))} --session ${shellEscape(join(dir, 'parent.jsonl'))} 2>${shellEscape(join(dir, 'startup-error.log'))}; status=$?; echo $status >${shellEscape(join(dir, 'parent-exit.txt'))}; sleep 120`;
  writeFileSync(join(dir, 'launch-command.sh'), command + '\n');
  tmux('respawn-pane', '-k', '-t', pane, command);
  const deadline = Date.now() + 1_150_000;
  const startupDeadline = Date.now() + 30_000;
  while (!existsSync(join(dir, 'ready')) && Date.now() < startupDeadline) await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(existsSync(join(dir, 'ready')), tmux('capture-pane', '-p', '-t', pane));
  tmux('send-keys', '-t', pane, '/live-workflows', 'Enter');
  while (!existsSync(join(dir, 'report.json')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1000));
  writeFileSync(join(dir, 'parent-screen.txt'), tmux('capture-pane', '-p', '-S', '-300', '-t', pane));
  assert.ok(existsSync(join(dir, 'report.json')), 'Timed out; inspect retained sessions and events in ' + dir);
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(report.ok, true, report.error);
  const evidence = verifyLiveEvidence(dir);
  t.diagnostic(evidence.uniqueRealChildSessions + ' real child sessions; ' + evidence.toolCalls + ' model tool calls; retained evidence verified independently');
  assert.deepEqual(report.checks, ['review', 'migration', 'pipeline-overlap', 'pipeline', 'aborted', 'aborted-disk', 'resumed']);
});
