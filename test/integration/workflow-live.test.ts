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

const live = process.env.PI_WORKFLOW_LIVE === '1';
it('real models execute old templates, advance pipeline independently and recover after Abort', { skip: !live, timeout: 1_200_000 }, async t => {
  const root = resolve(import.meta.dirname, '../..');
  const dir = mkdtempSync(join(tmpdir(), 'pi-workflow-live-'));
  const session = 'pi-wf-live-' + process.pid + '-' + Date.now();
  const model = process.env.PI_TEST_MODEL ?? 'anthropic/claude-haiku-4-5';
  console.log('Live model: ' + model + '; retained evidence: ' + dir);
  // Retain all sessions, scripts, journals and tool-side markers after success
  // or failure; remove only our tmux processes.
  t.after(() => cleanupSession(session, dir, { preserveArtifacts: true }));
  const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const agentsDir = join(dir, '.pi', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const name of ['worker', 'scout', 'workflow-subagent']) {
    writeFileSync(join(agentsDir, name + '.md'), `---
name: ${name}
description: Live regression test agent with real provider and tools
model: ${model}
thinking: off
tools: ${name === 'scout' ? 'read,grep,find,ls' : 'read,write,edit,bash,grep,find,ls'}
spawning: false
auto-exit: true
system-prompt: append
---
Execute the supplied task directly and concisely. Do not delegate or ask questions.
Read the relevant source files. Do not modify anything unless the task explicitly requests it.
If structured_output is available, finish by calling it with evidence-based values.
`);
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
  const command = `cd ${shellEscape(dir)} && exec env PI_OFFLINE=1 PI_WORKFLOW_LIVE_DIR=${shellEscape(dir)} PI_TEST_MODEL=${shellEscape(model)} PI_WORKFLOW_MAX_CONCURRENT_AGENTS=4 PI_SUBAGENT_SHELL_READY_DELAY_MS=100 pi -ne -ns -np -nc --no-mcp --approve --model ${shellEscape(model)} --thinking off -e ${shellEscape(join(root, 'test/integration/fixtures/workflow-live.ts'))} --session ${shellEscape(join(dir, 'parent.jsonl'))}`;
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
