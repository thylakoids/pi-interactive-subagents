/** Billed Pi inbox probe: real TUI, foreground tool, multiline steering and queued continuation. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createPiInbox, piInbox, queuePiMessage } from '../../pi-extension/subagents/control.ts';
import { shellEscape } from '../../pi-extension/subagents/tmux.ts';
import { integrationModel } from './model.ts';
import { integrationRuntime } from './runtime.ts';
import { cleanupSession } from './cleanup.ts';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { summarizeSession } from '../../pi-extension/subagents/session.ts';

it('real Pi preserves multiline steering and completes queued followUp before automatic exit', {
  skip: process.env.PI_WORKFLOW_LIVE !== '1', timeout: 300_000,
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-control-live-'));
  const session = `pi-control-${process.pid}-${Date.now()}`;
  t.after(() => cleanupSession(session, dir, { preserveArtifacts: true }));
  const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const until = async (check: () => boolean, label: string) => {
    const deadline = Date.now() + 240_000;
    while (!check()) {
      assert.ok(Date.now() < deadline, label + '; evidence: ' + dir);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const file = join(dir, 'child.jsonl'), id = 'control-live';
  const initial = 'Use bash to execute exactly:\n```sh\nprintf ready > ready; while ! test -f release; do sleep 0.1; done\n```\n'
    + 'Do not create release yourself. After the command exits, carry out any additional instructions, then answer PRIMARY_DONE.';
  const steer = 'After the waiting command finishes, execute exactly this bash script, preserving its newlines:\n```sh\n'
    + "cat > observed.txt <<'PROOF'\nfirst line\n  中文🙂 $literal\nlast line\nPROOF\n```\nThen answer PRIMARY_DONE.";
  const next = 'Separate follow-up task after the primary task: use read on observed.txt, then bash to execute '
    + '`printf follow-up >> follow-up.txt`. Finally answer FOLLOWUP_DONE and quote the exact three lines you read.';
  createPiInbox(file, id);
  const pane = tmux('new-session', '-d', '-s', session, '-x', '120', '-y', '36', '-P', '-F', '#{pane_id}');
  const runtime = integrationRuntime();
  const root = resolve(import.meta.dirname, '../..');
  const command = `cd ${shellEscape(dir)} && env PATH=${shellEscape(runtime.path)} PI_OFFLINE=1 PI_SUBAGENT_SESSION=${shellEscape(file)} PI_SUBAGENT_ID=${id} PI_SUBAGENT_NAME=control-live PI_SUBAGENT_AUTO_EXIT=1 PI_SUBAGENT_ALLOWED= PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(join(dir, 'activity.json'))} ${shellEscape(runtime.executable)} -ne -ns -np -nc --no-mcp --approve --tools bash,read --model ${shellEscape(integrationModel())} --thinking off -e ${shellEscape(join(root, 'pi-extension/subagents/subagent-done.ts'))} --session ${shellEscape(file)} ${shellEscape(initial)} 2>${shellEscape(join(dir, 'stderr.log'))}; echo $? > ${shellEscape(join(dir, 'exit'))}; sleep 30`;
  tmux('respawn-pane', '-k', '-t', pane, command);
  await until(() => existsSync(join(dir, 'ready')), 'real model must enter the blocking bash tool');
  queuePiMessage(file, id, { message: steer, deliverAs: 'steer' });
  queuePiMessage(file, id, { message: next, deliverAs: 'followUp' });
  await until(() => readdirSync(join(piInbox(file, id), 'inbox')).length === 0, 'child must drain the API inbox while bash is running');
  writeFileSync(join(dir, 'release'), 'release');
  await until(() => existsSync(join(dir, 'exit')), 'queued follow-up must finish before exit');
  assert.equal(readFileSync(join(dir, 'exit'), 'utf8').trim(), '0');
  const entries = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const text = (entry: any) => (entry.message?.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
  const users = entries.filter(entry => entry.message?.role === 'user');
  assert.equal(users.filter(entry => text(entry) === steer).length, 1);
  assert.equal(users.filter(entry => text(entry) === next).length, 1);
  const followIndex = entries.findIndex(entry => entry.message?.role === 'user' && text(entry) === next);
  assert.ok(entries.slice(0, followIndex).some(entry => entry.message?.role === 'assistant' && text(entry).includes('PRIMARY_DONE')), 'followUp starts after the primary final response');
  assert.ok(entries.slice(followIndex + 1).some(entry => entry.message?.role === 'assistant' && text(entry).includes('FOLLOWUP_DONE')));
  assert.equal(readFileSync(join(dir, 'observed.txt'), 'utf8'), 'first line\n  中文🙂 $literal\nlast line\n');
  assert.equal(readFileSync(join(dir, 'follow-up.txt'), 'utf8'), 'follow-up');
  assert.ok(entries.filter(entry => entry.message?.role === 'assistant' && entry.message.usage?.output > 0).length >= 3);
  // Branch a copy of the actual model transcript using official Pi's writer.
  const branched = join(dir, 'branched.jsonl'); copyFileSync(file, branched);
  const primary = entries.slice(0, followIndex).findLast(entry => entry.message?.role === 'assistant' && text(entry).includes('PRIMARY_DONE'))!;
  const original = summarizeSession(branched);
  const manager = SessionManager.open(branched, dir);
  manager.branchWithSummary(primary.id, 'Return to the completed primary task.');
  const result = summarizeSession(branched);
  assert.equal(result.summary, text(primary));
  assert.equal(result.stats.outputTokens, original.stats.outputTokens, 'branch selection cannot erase actual spend');
  assert.equal(summarizeSession(branched, entries.length).summary, null, 'branch metadata alone is not a new answer');
  t.diagnostic('Real provider messages, tool side effects and turn order verified; evidence: ' + dir);
});
