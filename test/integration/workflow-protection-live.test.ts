import './tmux-isolation.ts';
import { integrationRuntime } from './runtime.ts';
/** Opt-in, billed live-model coverage of launch cancellation and read-only steps. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { shellEscape } from '../../pi-extension/subagents/tmux.ts';
import { readSubagentLoadout } from '../../pi-extension/subagents/session.ts';
import { cleanupSession } from './cleanup.ts';
import { integrationModel } from './model.ts';
import { findVerificationProbeResult, hasPassingGuardOutput, isSkipIoCommand } from './live-evidence.ts';

const PROTECTED = 'PROTECTED-CONTENT: a read-only step must never change these bytes.\n';
const GUARD_SOURCE = `const assert = require('node:assert/strict');
const { test } = require('node:test');
test('local guard stays green', () => assert.equal(1 + 1, 2));
`;

const rows = (file: string) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const textOf = (message: any) => (message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
const hasProviderUsage = (file: string) => rows(file).some(row => row.message?.role === 'assistant'
  && ((row.message.usage?.input ?? 0) > 0 || (row.message.usage?.output ?? 0) > 0));
const journal = (runDir: string, callKey: string) =>
  rows(join(runDir, 'journal.jsonl')).filter(entry => entry.callKey === callKey);

/**
 * Independent checks over the retained artifacts.
 *
 * The driver's report is a claim like any other: this reads the transcripts,
 * the journal, the persisted loadout and the bytes on disk, and requires the
 * claimed behaviour to be visible there.
 */
function verifyProtectionEvidence(dir: string, tmux: (...args: string[]) => string, sessionName: string) {
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(report.ok, true, report.error);
  assert.deepEqual(report.checks, ['skip-launch-window', 'abort-launch-window', 'resume-after-abort', 'readonly-verify', 'readonly-abort-verify']);

  const events = rows(join(dir, 'events.jsonl')).map(event => event.event);
  for (const required of ['skip-window-proven', 'skip-passed', 'skip-io-passed', 'abort-window-proven', 'abort-window-passed', 'resume-passed', 'readonly-passed', 'readonly-abort-command-started', 'readonly-abort-passed', 'all-passed']) {
    assert.ok(events.includes(required), 'the timeline must record ' + required);
  }

  // Both launch windows were observed while the panes existed and before any
  // worker was registered; their panes must be gone now.
  const skipWindow = JSON.parse(readFileSync(join(dir, 'skip-window.json'), 'utf8'));
  const abortWindow = JSON.parse(readFileSync(join(dir, 'abort-window.json'), 'utf8'));
  assert.equal(skipWindow.registered, false, 'the pane must exist before its worker is registered');
  assert.doesNotMatch(String(skipWindow.paneCommand), /(^|\/)(pi|node)$/, 'the launch window pane must still be a shell');
  const livePanes = new Set(tmux('list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}').split('\n').filter(Boolean));
  for (const pane of [skipWindow.pane, abortWindow.pane]) {
    assert.equal(livePanes.has(pane), false, 'cancelled pane ' + pane + ' must be closed');
  }

  // Files only real children can create; the cancelled call never writes one.
  assert.equal(existsSync(join(dir, 'first-marker')), false, 'the skipped call must never start');
  assert.equal(readFileSync(join(dir, 'successor-marker'), 'utf8').trim(), 'SUCCESSOR');
  assert.equal(readFileSync(join(dir, 'resume-marker'), 'utf8').trim(), 'RESUMED');

  const skip = JSON.parse(readFileSync(join(dir, 'skip.json'), 'utf8'));
  const aborted = JSON.parse(readFileSync(join(dir, 'abort.json'), 'utf8'));
  const resumed = JSON.parse(readFileSync(join(dir, 'resume.json'), 'utf8'));
  const readonly = JSON.parse(readFileSync(join(dir, 'readonly.json'), 'utf8'));

  // Case 1: skipped call terminal in the journal, successor is a real model.
  assert.equal(skip.status, 'completed');
  const first = skip.calls.find((call: any) => call.label === 'first')!;
  const successor = skip.calls.find((call: any) => call.label === 'successor')!;
  assert.equal(first.status, 'skipped');
  assert.equal(first.sessionFile, undefined, 'the skipped call never launched a child');
  assert.deepEqual(journal(skip.runDir, first.callKey).map((entry: any) => entry.status), ['skipped']);
  assert.equal(successor.status, 'completed');
  assert.ok(hasProviderUsage(successor.sessionFile), 'the successor must have real provider usage');

  const skipIO = JSON.parse(readFileSync(join(dir, 'skip-io.json'), 'utf8'));
  assert.equal(skipIO.status, 'completed');
  assert.equal(skipIO.calls[0].status, 'skipped');
  assert.ok(hasProviderUsage(skipIO.calls[0].sessionFile));
  assert.ok(rows(skipIO.calls[0].sessionFile).some(row => Array.isArray(row.message?.content) && row.message.content.some(isSkipIoCommand)),
  'the cancelled command must be an actual model tool call');
  assert.equal(readFileSync(join(dir, 'skip-io-started'), 'utf8').trim(), 'STARTED');
  assert.equal(existsSync(join(dir, 'skip-io-escaped')), false);
  assert.ok(skipIO.logs.some((message: string) => message.includes('could not persist Skip')));

  // Case 2: aborted during launch, then resumed for real. The run directory is
  // shared, so the abort evidence must be the copy the driver saved *before*
  // Resume; only the pre-Resume files may claim an aborted snapshot.
  assert.equal(aborted.status, 'aborted');
  const cancelled = aborted.calls[0];
  assert.equal(cancelled.status, 'aborted');
  assert.equal(cancelled.sessionFile, undefined, 'the aborted launch never produced a child session');
  const abortDisk = JSON.parse(readFileSync(join(dir, 'abort-disk.json'), 'utf8'));
  const abortJournal = JSON.parse(readFileSync(join(dir, 'abort-journal.json'), 'utf8'));
  assert.equal(abortDisk.status, 'aborted', 'the saved pre-Resume snapshot must be aborted');
  assert.deepEqual(abortJournal.map((entry: any) => entry.status), ['aborted'], 'the saved pre-Resume journal holds only the abort');
  const finalSnapshot = JSON.parse(readFileSync(join(aborted.runDir, 'snapshot.json'), 'utf8'));
  assert.equal(finalSnapshot.status, 'completed', 'Resume must leave a completed snapshot on disk');
  assert.deepEqual(
    journal(aborted.runDir, cancelled.callKey).map((entry: any) => entry.status),
    ['aborted', 'completed'],
    'the journal keeps the aborted line and the resumed completion for the same key',
  );
  assert.equal(resumed.status, 'completed');
  const resumedCall = resumed.calls[0];
  assert.equal(resumedCall.status, 'completed');
  assert.equal(resumedCall.cached, undefined, 'a cancelled call must not replay as a cached answer');
  assert.ok(hasProviderUsage(resumedCall.sessionFile), 'the resumed call must have real provider usage');

  // Case 3: the read-only step is real, sandboxed and unchanged.
  assert.equal(readonly.status, 'completed');
  const step = readonly.calls[0];
  assert.equal(step.status, 'completed', step.error);
  const loadout = readSubagentLoadout(step.sessionFile)!;
  const tools = (loadout.toolAllowlist ?? '').split(',').map((tool: string) => tool.trim()).filter(Boolean);
  assert.equal(loadout.readOnly, true, 'the persisted loadout must be read-only');
  for (const denied of ['write', 'edit', 'bash', 'subagent', 'subagent_message', 'subagents_list']) {
    assert.ok(!tools.includes(denied), denied + ' must never be granted to a read-only step');
  }
  assert.ok(tools.includes('verify_command'));
  assert.ok(tools.includes('ask_question'));
  const verifyResults = rows(step.sessionFile).filter(row => row.message?.role === 'toolResult' && row.message.toolName === 'verify_command');
  assert.ok(verifyResults.length >= 3, 'the model must really run all three verification commands');
  for (const result of verifyResults) {
    assert.equal(result.message.details?.backend, process.platform === 'linux' ? 'bwrap' : 'sandbox-exec');
  }
  const verificationCalls = rows(step.sessionFile).flatMap(row => row.message?.role === 'assistant' ? row.message.content ?? [] : []);
  const denial = findVerificationProbeResult(verificationCalls, verifyResults, 'write');
  assert.ok(denial, 'the write attempt must fail inside the sandbox');
  assert.match(textOf(denial!.message), /permission|denied|EPERM|EACCES|not permitted|EROFS|read.only file system/i, 'the transcript must contain the real refusal');
  const passing = findVerificationProbeResult(verificationCalls, verifyResults, 'test');
  assert.ok(passing, 'the local test run must succeed under the sandbox');
  assert.ok(hasPassingGuardOutput(textOf(passing!.message)), 'the transcript must contain the passing test output');
  assert.ok(hasProviderUsage(step.sessionFile), 'the read-only step must have real provider usage');
  assert.equal((readonly.result as any).writeDenied, true);
  assert.equal((readonly.result as any).fifoDenied, true);
  const fifoProof = JSON.parse(readFileSync(join(dir, 'readonly-fifo.json'), 'utf8'));
  assert.equal(fifoProof.control, 'OUTSIDE-CONTROL', 'the FIFO must have had a working outside peer');
  assert.equal(fifoProof.receivedBytes, 0);
  const fifoResult = findVerificationProbeResult(verificationCalls, verifyResults, 'fifo');
  assert.ok(fifoResult && fifoResult.message.details?.exitCode !== 0, 'the actual FIFO write must fail');
  assert.match(textOf(fifoResult.message), /denied|EPERM|not permitted/i);
  assert.equal((readonly.result as any).testPassed, true);
  assert.equal(readFileSync(join(dir, 'protected.txt'), 'utf8'), PROTECTED, 'the protected file bytes must be unchanged');
  assert.equal(readFileSync(join(dir, 'guard.test.cjs'), 'utf8'), GUARD_SOURCE, 'the fixture test must be unchanged');
  const scratch = JSON.parse(readFileSync(join(dir, 'readonly-scratch.json'), 'utf8'));
  assert.match(readFileSync(scratch.launchScript, 'utf8'), /PI_SUBAGENT_VERIFY_SCRATCH=/);
  assert.equal(existsSync(scratch.path), false, 'the real process must not leave its scratch root behind');

  // Case 4: the long-running verify_command and its process group.
  const verifyAbort = JSON.parse(readFileSync(join(dir, 'readonly-abort.json'), 'utf8'));
  const verifyStart = JSON.parse(readFileSync(join(dir, 'readonly-abort-start.json'), 'utf8'));
  const survivors = JSON.parse(readFileSync(join(dir, 'readonly-abort-survivors.json'), 'utf8'));
  assert.equal(verifyAbort.status, 'aborted');
  assert.equal(verifyAbort.calls[0].status, 'aborted');
  assert.deepEqual(
    journal(verifyAbort.runDir, verifyAbort.calls[0].callKey).map((entry: any) => entry.status),
    ['aborted'],
  );
  const verifySnapshot = JSON.parse(readFileSync(join(verifyAbort.runDir, 'snapshot.json'), 'utf8'));
  assert.equal(verifySnapshot.status, 'aborted', 'the cancelled read-only run must be persisted as aborted');
  assert.ok(Number.isInteger(verifyStart.markerPid) && verifyStart.markerPid > 0, 'the command must have recorded its pid');
  assert.equal(verifyStart.commandAlive, true, 'the command must have been alive when Abort landed');
  assert.ok(Number.isInteger(verifyStart.markerNamespacePid) && verifyStart.markerNamespacePid > 0);
  if (process.platform === 'linux') assert.notEqual(verifyStart.markerPid, verifyStart.markerNamespacePid, 'Linux must attribute namespace PIDs to host PIDs');
  // Attribution and group safety, checked against real process groups: pi is
  // usually not a group leader, so a pid comparison proves nothing.
  const harnessPgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
  assert.ok(Number.isInteger(harnessPgid) && harnessPgid > 0, 'the harness must know its own process group');
  assert.ok(Number.isInteger(verifyStart.driverPgid) && verifyStart.driverPgid > 0, 'the driver must have recorded its own group');
  assert.notEqual(verifyStart.pgid, verifyStart.driverPgid, 'the command must not share the driver process group');
  assert.notEqual(verifyStart.pgid, harnessPgid, 'the command must not share the harness process group');
  assert.ok(String(verifyStart.marker).startsWith(String(verifyStart.scratchRoot) + '/'), 'the pid marker must live in this call scratch root');
  assert.match(String(verifyStart.markerCommand), /started\.pid/, 'the recorded pid must be the command this call launched');
  assert.deepEqual(survivors.survivors, [], 'no member of the command group may survive the Abort');
  assert.equal(survivors.cleanedUp, false, 'production must reap the group; the fallback cleanup must stay unused');
  const survivorsNow = execFileSync('ps', ['-eo', 'pid=,pgid='], { encoding: 'utf8' })
    .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
    .filter(row => row[1] === verifyStart.pgid && row[0] !== process.pid);
  assert.deepEqual(survivorsNow, [], 'the command group must still be empty now');
  assert.ok(hasProviderUsage(verifyAbort.calls[0].sessionFile), 'the read-only child must have real provider usage');
  const verifyAbortCall = rows(verifyAbort.calls[0].sessionFile)
    .flatMap((row: any) => row.message?.role === 'assistant' ? row.message.content ?? [] : [])
    .filter((part: any) => part.type === 'toolCall' && part.name === 'verify_command');
  assert.ok(verifyAbortCall.length >= 1, 'the model must really call verify_command');
  assert.match(JSON.stringify(verifyAbortCall[0].arguments), /started\.pid/);

  const summary = {
    ok: true,
    checks: report.checks,
    skip: { closeMs: report.skip.closeMs, successorSession: successor.sessionFile },
    abort: { closeMs: report.abort.closeMs, preResumeSnapshot: abortDisk.status, finalSnapshot: finalSnapshot.status },
    resume: { session: resumedCall.sessionFile, cached: resumedCall.cached ?? null },
    readonly: { tools, verifyCalls: verifyResults.length, protectedBytes: readFileSync(join(dir, 'protected.txt'), 'utf8').length },
    readonlyAbort: { pid: verifyStart.markerPid, pgid: verifyStart.pgid, survivors: survivors.survivors.length, snapshot: verifySnapshot.status },
  };
  writeFileSync(join(dir, 'evidence-summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

const live = process.env.PI_WORKFLOW_LIVE === '1';
it('cancels a launch before its child starts and runs a read-only step under the sandbox', { skip: !live, timeout: 1_250_000 }, async t => {
  const root = resolve(import.meta.dirname, '../..');
  const dir = mkdtempSync(join(tmpdir(), 'pi-workflow-protection-'));
  const session = 'pi-wf-protection-' + process.pid + '-' + Date.now();
  const model = integrationModel();
  console.log('Live model: ' + model + '; retained evidence: ' + dir);
  // Retain every session, script, journal and marker after success or failure;
  // only this test's tmux session is removed.
  t.after(() => cleanupSession(session, dir, { preserveArtifacts: true }));

  const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const agentsDir = join(dir, '.pi', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  // Real bundled identities/tools; omit the model so the parent model is
  // inherited, and keep reasoning low for this billed test.
  for (const name of ['worker', 'scout', 'researcher']) {
    const definition = readFileSync(join(root, 'agents', name + '.md'), 'utf8')
      .replace(/^thinking: .*$/m, 'thinking: off');
    writeFileSync(join(agentsDir, name + '.md'), definition);
  }
  writeFileSync(join(dir, 'protected.txt'), PROTECTED);
  writeFileSync(join(dir, 'guard.test.cjs'), GUARD_SOURCE);

  const pane = tmux('new-session', '-d', '-s', session, '-x', '140', '-y', '42', '-P', '-F', '#{pane_id}');
  const runtime = integrationRuntime();
  // The launch windows are opened by the driver through the same environment
  // the launcher reads; concurrency=1 keeps the second Skip-case call queued.
  const command = `cd ${shellEscape(dir)} && env PATH=${shellEscape(runtime.path)} PI_OFFLINE=1 PI_WORKFLOW_LIVE_DIR=${shellEscape(dir)} PI_TEST_MODEL=${shellEscape(model)} PI_WORKFLOW_MAX_CONCURRENT_AGENTS=1 PI_SUBAGENT_SHELL_READY_DELAY_MS=15000 ${shellEscape(runtime.executable)} -ne -ns -np -nc --no-mcp --approve --model ${shellEscape(model)} --thinking off -e ${shellEscape(join(root, 'test/integration/fixtures/workflow-protection-live.ts'))} --session ${shellEscape(join(dir, 'parent.jsonl'))} 2>${shellEscape(join(dir, 'startup-error.log'))}; status=$?; echo $status >${shellEscape(join(dir, 'parent-exit.txt'))}; sleep 120`;
  writeFileSync(join(dir, 'launch-command.sh'), command + '\n');
  tmux('respawn-pane', '-k', '-t', pane, command);

  const startupDeadline = Date.now() + 30_000;
  while (!existsSync(join(dir, 'ready')) && Date.now() < startupDeadline) await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(existsSync(join(dir, 'ready')), tmux('capture-pane', '-p', '-t', pane));
  tmux('send-keys', '-t', pane, '/live-protection', 'Enter');

  // 20 minute driver cap; the retained directory keeps stderr and the pane
  // screen for whatever happened.
  const deadline = Date.now() + 20 * 60 * 1000;
  while (!existsSync(join(dir, 'report.json')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
  writeFileSync(join(dir, 'parent-screen.txt'), tmux('capture-pane', '-p', '-S', '-300', '-t', pane));
  const stderrTail = existsSync(join(dir, 'startup-error.log')) ? readFileSync(join(dir, 'startup-error.log'), 'utf8').slice(-4000) : '(no startup-error.log)';
  assert.ok(existsSync(join(dir, 'report.json')), 'Timed out after 20 min; retained evidence in ' + dir + '; stderr tail:\n' + stderrTail);

  const summary = verifyProtectionEvidence(dir, tmux, session);
  t.diagnostic(summary.checks.join(', ') + '; evidence verified independently in ' + dir);
  assert.deepEqual(summary.checks, ['skip-launch-window', 'abort-launch-window', 'resume-after-abort', 'readonly-verify', 'readonly-abort-verify']);
});
