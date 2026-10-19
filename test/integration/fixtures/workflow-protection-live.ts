/**
 * Live protection probes: cancelling a launch before its child starts, and a
 * read-only step that runs a real sandboxed command.
 *
 * Everything here uses the production extension, the production subagent
 * service, real tmux panes and a real provider model. The only test hooks are
 * timing: PI_SUBAGENT_SHELL_READY_DELAY_MS holds the launch window open long
 * enough to observe a pane that exists while its worker is not yet registered,
 * and PI_WORKFLOW_MAX_CONCURRENT_AGENTS=1 keeps the second call queued.
 *
 * Evidence is written to the retained directory for independent inspection:
 * events.jsonl (timeline), one <case>.json per run view, report.json, the
 * marker files the models write, and the child session transcripts.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, constants, existsSync, openSync, readSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import subagentsExtension, { __test__ } from '../../../pi-extension/subagents/index.ts';
import { WorkflowManager, type WorkflowRun } from '../../../pi-extension/subagents/workflow/manager.ts';
import { readNameRegistry, readSubagentLoadout } from '../../../pi-extension/subagents/session.ts';
import { surfaceExists } from '../../../pi-extension/subagents/tmux.ts';
import { waitForSandboxCommand } from '../../helpers/readonly-process.ts';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(25); }
  throw new Error('Timed out: ' + label);
}
const rows = (file: string) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const toolCalls = (file: string) => rows(file).flatMap(row =>
  row.message?.role === 'assistant' ? (row.message.content ?? []).filter((part: any) => part.type === 'toolCall') : []);
const toolResults = (file: string) => rows(file).filter(row => row.message?.role === 'toolResult');
const textOf = (message: any) => (message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
const hasProviderUsage = (file: string) => rows(file).some(row => row.message?.role === 'assistant'
  && ((row.message.usage?.input ?? 0) > 0 || (row.message.usage?.output ?? 0) > 0));
const script = (name: string, body: string) =>
  'export const meta = ' + JSON.stringify({ name, description: 'Live protection regression' }) + '\n' + body;

const READONLY_SCHEMA = {
  type: 'object',
  properties: {
    writeDenied: { type: 'boolean' },
    writeError: { type: 'string' },
    fifoDenied: { type: 'boolean' },
    testPassed: { type: 'boolean' },
    testSummary: { type: 'string' },
  },
  required: ['writeDenied', 'writeError', 'fifoDenied', 'testPassed', 'testSummary'],
};

const VERIFY_ABORT_COMMAND =
  "node -e \"require('node:fs').writeFileSync(require('node:path').join(process.env.TMPDIR, 'started.pid'), String(process.pid)); setInterval(() => {}, 1000)\"";

const VERIFY_ABORT_PROMPT =
  'Call verify_command exactly once with this exact command and timeout_ms 240000: ' + VERIFY_ABORT_COMMAND + '. ' +
  'The step is read-only and the command is meant to keep running until this workflow is cancelled. ' +
  'Do not call any other tool, do not retry, and do not write anywhere else.';

const READONLY_PROMPT = [
  'Run exactly these three commands, each in a separate verify_command call, without retrying:',
  '1. Try a workspace write (it should be denied):',
  '```sh',
  `node -e "require('node:fs').writeFileSync('protected.txt','tampered')"`,
  '```',
  '2. Try writing to the existing external FIFO (it has a live reader and should be denied):',
  '```sh',
  'printf unexpected > restricted.fifo',
  '```',
  '3. Run the local test suite (it should pass):',
  '```sh',
  'node --test guard.test.cjs',
  '```',
  'Then call structured_output once with the actual writeDenied, writeError, fifoDenied, testPassed and testSummary.',
  'Report observed results, not assumed success. Do not use any other tool or retry a denied write.',
].join('\n');

export default function protectionFixture(pi: any) {
  subagentsExtension(pi);
  const dir = process.env.PI_WORKFLOW_LIVE_DIR!;
  const record = (event: string, details: unknown = {}) =>
    appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ at: Date.now(), event, details }) + '\n');
  const save = (name: string, value: unknown) => writeFileSync(join(dir, name + '.json'), JSON.stringify(value, null, 2));
  let manager: WorkflowManager | undefined;

  pi.on('session_start', () => writeFileSync(join(dir, 'ready'), 'ready'));
  pi.on('session_shutdown', () => manager?.abortAll('live protection shutdown'));

  pi.registerCommand('live-protection', {
    description: 'Run launch-window cancellation and read-only sandbox probes with real models',
    handler: async (_args: string, ctx: any) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionDir = ctx.sessionManager.getSessionDir();
      const artifactDir = join(sessionDir, 'artifacts', sessionId);
      const options = {
        baseDir: join(dir, 'artifacts'),
        cwd: dir,
        sessionFile: ctx.sessionManager.getSessionFile(),
        sessionId,
        agentDir: process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME!, '.pi', 'agent'),
        service: (globalThis as any).__pi_interactive_subagents.workflow,
      };
      manager = new WorkflowManager(options);

      // Only this test's tmux session can contain the panes this run opens;
      // a foreign pane created by the user must never look like a launch
      // window, and no tmux command may read or act on another session.
      const parentPane = process.env.TMUX_PANE;
      assert.ok(parentPane, 'workflow panes need the parent tmux pane (TMUX_PANE)');
      const tmuxSession = execFileSync('tmux', ['display-message', '-p', '-t', parentPane!, '#{session_name}'], { encoding: 'utf8' }).trim();
      const paneIds = () => execFileSync('tmux', ['list-panes', '-s', '-t', tmuxSession, '-F', '#{pane_id}'], { encoding: 'utf8' })
        .trim().split('\n').filter(Boolean);
      const paneCommand = (id: string) => {
        try { return execFileSync('tmux', ['display-message', '-p', '-t', id, '#{pane_current_command}'], { encoding: 'utf8' }).trim(); }
        catch { return ''; }
      };
      // The parent registry is the durable "worker launched" signal; check the
      // plausible session-dir resolutions so the assertion cannot pass for the
      // wrong path.
      const registryDirs = [artifactDir, join(dir, 'artifacts', sessionId), join(sessionDir, 'artifacts')];
      const registered = (name: string) => registryDirs.some(candidate => {
        try { return Object.keys(readNameRegistry(candidate)).includes(name); } catch { return false; }
      });
      /** Wait for a pane this run opened, before its child command was sent. */
      const waitNewPane = async (before: Set<string>, label: string) => {
        await until(() => paneIds().some(id => !before.has(id)), label + ': a new pane exists', 30_000);
        return paneIds().find(id => !before.has(id))!;
      };

      let fifoFd: number | undefined;
      try {
        assert.equal(options.service.isAvailable().ok, true, 'Production subagent service must be available');
        record('start', { model: process.env.PI_TEST_MODEL, pid: process.pid });

        // ── Case 1: Skip inside the launch window ─────────────────────────
        // The launch command is held back by the shell-ready delay, so the pane
        // exists while no worker is registered. Skip must close it at once and
        // hand the single slot to the queued successor.
        process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = '20000';
        process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS = '1';
        const panesBeforeSkip = new Set(paneIds());
        const skipRun: WorkflowRun = await manager.start({
          source: script('live-launch-skip', [
            'return await parallel([',
            "  () => agent('Use bash to write the single line FIRST to first-marker, then reply FIRST_DONE.', {label:'first'}),",
            "  () => agent('Use bash to write the single line SUCCESSOR to successor-marker, then reply SUCCESSOR_DONE.', {label:'successor'}),",
            ']);',
          ].join('\n')),
          args: {},
          reuse: 'none',
        });
        record('skip-run-start', { runId: skipRun.runId });
        const skipExecution = skipRun.execute();
        const firstPane = await waitNewPane(panesBeforeSkip, 'skip launch window');
        const firstCall = skipRun.view().calls.find(call => call.label === 'first')!;
        assert.ok(firstCall.name, 'the call must have claimed its agent name before the pane exists');
        assert.ok(options.service.takenNames().has(firstCall.name!), 'pending workflow launch must reserve its name');
        assert.ok(__test__.reservedNames.has(firstCall.name!), 'the production adapter must share manual-tool reservations');
        assert.notEqual(__test__.uniqueRunningName(firstCall.name!), firstCall.name, 'manual naming must avoid a pending workflow name');
        assert.equal(registered(firstCall.name!), false, 'the worker must not be registered during the launch window');
        assert.doesNotMatch(paneCommand(firstPane), /(^|\/)(pi|node)$/, 'the pane must still be a bare shell during the launch window');
        save('skip-window', { pane: firstPane, paneCommand: paneCommand(firstPane), call: firstCall, registered: registered(firstCall.name!) });
        record('skip-window-proven', { pane: firstPane, paneCommand: paneCommand(firstPane), registered: false });

        process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = '100';
        const skippedAt = Date.now();
        assert.equal(skipRun.skip(firstCall.callKey), true, 'the launch window must still be open when Skip lands');
        await until(() => !surfaceExists(firstPane), 'skipped pane is closed', 1_500);
        const skipCloseMs = Date.now() - skippedAt;
        assert.ok(skipCloseMs < 1_000, 'the skipped pane must disappear within 1s, took ' + skipCloseMs + 'ms');

        const skippedView = await skipExecution;
        save('skip', skippedView);
        assert.equal(skippedView.status, 'completed', skippedView.error);
        const firstAfter = skippedView.calls.find(call => call.label === 'first')!;
        const successorAfter = skippedView.calls.find(call => call.label === 'successor')!;
        assert.equal(firstAfter.status, 'skipped');
        assert.equal(__test__.reservedNames.has(firstCall.name!), false, 'cancelled startup must release its reservation');
        assert.equal(successorAfter.status, 'completed', successorAfter.error);
        assert.ok(existsSync(join(dir, 'successor-marker')), 'the queued successor must run a real model');
        assert.equal(existsSync(join(dir, 'first-marker')), false, 'the skipped call must never start');
        assert.ok(hasProviderUsage(successorAfter.sessionFile!), 'the successor must show real provider usage');
        assert.ok(toolCalls(successorAfter.sessionFile!).some(call => call.name === 'bash'), 'the successor must actually use its tools');
        assert.deepEqual(
          rows(join(skippedView.runDir, 'journal.jsonl')).filter(entry => entry.callKey === firstAfter.callKey).map(entry => entry.status),
          ['skipped'],
          'the skipped call must keep exactly one terminal journal line',
        );
        record('skip-passed', { runId: skipRun.runId, closeMs: skipCloseMs, successor: successorAfter.name });

        // ── Case 2: Abort inside the launch window, then Resume ───────────
        process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = '20000';
        const panesBeforeAbort = new Set(paneIds());
        const abortRun: WorkflowRun = await manager.start({
          source: script('live-launch-abort', [
            "return await agent('Use bash to write the single line RESUMED to resume-marker, then reply RESUME_DONE.', {label:'resumed'});",
          ].join('\n')),
          args: {},
          reuse: 'none',
        });
        record('abort-run-start', { runId: abortRun.runId });
        const abortExecution = abortRun.execute();
        const abortPane = await waitNewPane(panesBeforeAbort, 'abort launch window');
        const abortCall = abortRun.view().calls[0];
        assert.equal(registered(abortCall.name!), false, 'the worker must not be registered during the abort window');
        assert.equal(existsSync(join(dir, 'resume-marker')), false, 'no child may run before the Abort');
        save('abort-window', { pane: abortPane, paneCommand: paneCommand(abortPane), call: abortCall });
        record('abort-window-proven', { pane: abortPane, paneCommand: paneCommand(abortPane) });

        const abortedAt = Date.now();
        abortRun.abort('live protection: abort during the launch window');
        await until(() => !surfaceExists(abortPane), 'aborted pane is closed', 1_500);
        const abortCloseMs = Date.now() - abortedAt;
        assert.ok(abortCloseMs < 1_000, 'the aborted pane must disappear within 1s, took ' + abortCloseMs + 'ms');

        const abortedView = await abortExecution;
        save('abort', abortedView);
        assert.equal(abortedView.status, 'aborted', abortedView.error);
        assert.equal(abortedView.calls[0].status, 'aborted');
        // Capture the on-disk abort evidence NOW: Resume reuses this run
        // directory, so reading snapshot.json or journal.jsonl after it would
        // show the resumed completion instead of the cancelled launch.
        const abortDisk = JSON.parse(readFileSync(join(abortedView.runDir, 'snapshot.json'), 'utf8'));
        const abortJournal = rows(join(abortedView.runDir, 'journal.jsonl')).filter(entry => entry.callKey === abortCall.callKey);
        assert.equal(abortDisk.status, 'aborted', 'the terminal state must reach snapshot.json before Resume');
        assert.deepEqual(abortJournal.map(entry => entry.status), ['aborted'], 'a cancelled launch must never be journaled as completed');
        save('abort-disk', abortDisk);
        save('abort-journal', abortJournal);
        // Verify the saved evidence itself, not only the values read above.
        assert.equal(JSON.parse(readFileSync(join(dir, 'abort-disk.json'), 'utf8')).status, 'aborted');
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'abort-journal.json'), 'utf8')).map((entry: any) => entry.status), ['aborted']);
        assert.equal(existsSync(join(dir, 'resume-marker')), false, 'the aborted child must never run');
        record('abort-window-passed', { runId: abortRun.runId, closeMs: abortCloseMs, disk: abortDisk.status, journal: ['aborted'] });

        // Resume from disk: the cancelled call must really run now, proving the
        // cancel neither cached a success nor locked the run.
        process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = '100';
        const resumeManager = new WorkflowManager(options);
        manager = resumeManager;
        const resumedRun = await resumeManager.resume(abortRun.runId);
        record('resume-start', { runId: abortRun.runId });
        const resumedView = await resumedRun.execute();
        save('resume', resumedView);
        assert.equal(resumedView.status, 'completed', resumedView.error);
        const resumedCall = resumedView.calls[0];
        assert.equal(resumedCall.status, 'completed', resumedCall.error);
        assert.equal(resumedCall.cached, undefined, 'a cancelled call must not replay as a cached answer');
        assert.ok(existsSync(join(dir, 'resume-marker')), 'the resumed call must run a real model');
        assert.equal(readFileSync(join(dir, 'resume-marker'), 'utf8').trim(), 'RESUMED');
        assert.ok(statSync(join(dir, 'resume-marker')).mtimeMs >= abortedAt, 'the marker must be written after the Abort');
        assert.ok(hasProviderUsage(resumedCall.sessionFile!), 'the resumed call must show real provider usage');
        assert.ok(toolCalls(resumedCall.sessionFile!).some(call => call.name === 'bash'), 'the resumed call must actually use its tools');
        // Resume owns the same directory now: its completion is the final state,
        // and the cancelled line stays in the journal next to the completed one.
        const finalSnapshot = JSON.parse(readFileSync(join(abortedView.runDir, 'snapshot.json'), 'utf8'));
        const finalJournal = rows(join(abortedView.runDir, 'journal.jsonl')).filter(entry => entry.callKey === abortCall.callKey);
        assert.equal(finalSnapshot.status, 'completed', 'Resume must persist the completed terminal state');
        assert.deepEqual(finalJournal.map(entry => entry.status), ['aborted', 'completed'], 'the same call key keeps the abort and the resumed completion');
        record('resume-passed', { runId: abortRun.runId, resumed: resumedCall.name, snapshot: finalSnapshot.status, journal: finalJournal.map(entry => entry.status) });

        // ── Case 3: readOnly step under the verify_command sandbox ────────
        const fifoPath = join(dir, 'restricted.fifo');
        execFileSync('mkfifo', [fifoPath]);
        fifoFd = openSync(fifoPath, constants.O_RDWR | constants.O_NONBLOCK);
        writeSync(fifoFd, Buffer.from('OUTSIDE-CONTROL'));
        const control = Buffer.alloc(15);
        assert.equal(readSync(fifoFd, control), 15);
        assert.equal(control.toString(), 'OUTSIDE-CONTROL');
        const protectedBefore = readFileSync(join(dir, 'protected.txt'));
        process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = '100';
        const readonlyRun: WorkflowRun = await manager.start({
          source: script('live-readonly', [
            'return await agent(' + JSON.stringify(READONLY_PROMPT) + ', {',
            "  label: 'readonly',",
            '  readOnly: true,',
            '  schema: ' + JSON.stringify(READONLY_SCHEMA) + ',',
            '});',
          ].join('\n')),
          args: {},
          reuse: 'none',
        });
        record('readonly-start', { runId: readonlyRun.runId });
        const readonlyView = await readonlyRun.execute();
        save('readonly', readonlyView);
        assert.equal(readonlyView.status, 'completed', readonlyView.error);
        const readonlyCall = readonlyView.calls[0];
        assert.equal(readonlyCall.status, 'completed', readonlyCall.error);
        const scripts = join(artifactDir, 'subagent-scripts');
        const launchFile = readdirSync(scripts).find(file => file.startsWith(readonlyCall.name! + '-') && file.endsWith('.sh'));
        assert.ok(launchFile, 'the production launch script must exist');
        const launchScript = join(scripts, launchFile!);
        const scratch = /PI_SUBAGENT_VERIFY_SCRATCH='([^']+)'/.exec(readFileSync(launchScript, 'utf8'))?.[1];
        assert.ok(scratch, 'the real launcher must supply a private scratch root');
        assert.equal(existsSync(scratch!), false, 'the completed child must release its scratch root');
        save('readonly-scratch', { path: scratch, launchScript });

        // The model's own report is only a claim; the loadout, the transcript
        // and the bytes on disk are the evidence.
        const structured = readonlyView.result as any;
        assert.equal(structured?.writeDenied, true, 'structured result must report the denied write');
        assert.equal(structured?.fifoDenied, true, 'the existing FIFO must be protected by runtime permissions');
        assert.equal(structured?.testPassed, true, 'structured result must report a passing local test');
        assert.match(String(structured?.writeError), /permission|denied|EPERM|not permitted|EROFS|read.only file system/i);

        const loadout = readSubagentLoadout(readonlyCall.sessionFile!)!;
        assert.equal(loadout.readOnly, true, 'the persisted loadout must be read-only');
        const tools = (loadout.toolAllowlist ?? '').split(',').map(tool => tool.trim()).filter(Boolean);
        for (const denied of ['write', 'edit', 'bash', 'subagent', 'subagent_message', 'subagents_list']) {
          assert.ok(!tools.includes(denied), denied + ' must never be granted to a read-only step');
        }
        assert.ok(tools.includes('verify_command'), 'the read-only step must get verify_command');
        assert.ok(tools.includes('ask_question'), 'the read-only step keeps its question channel');

        const verifyResults = toolResults(readonlyCall.sessionFile!)
          .filter(row => row.message.toolName === 'verify_command');
        assert.ok(verifyResults.length >= 2, 'the model must really run verify_command twice');
        const denial = verifyResults.find(row => row.message.details?.exitCode !== 0);
        assert.ok(denial, 'the write attempt must fail inside the sandbox');
        assert.match(textOf(denial!.message), /permission|denied|EPERM|not permitted|sandbox/i, 'the transcript must contain the real refusal');
        const passing = verifyResults.find(row => row.message.details?.exitCode === 0);
        assert.ok(passing, 'the local test run must succeed under the sandbox');
        assert.match(textOf(passing!.message), /# pass 1|ok 1 -/, 'the transcript must contain the passing test output');
        assert.ok(toolCalls(readonlyCall.sessionFile!).filter(call => call.name === 'verify_command').length >= 2);
        assert.ok(hasProviderUsage(readonlyCall.sessionFile!), 'the read-only step must show real provider usage');
        assert.equal(readFileSync(join(dir, 'protected.txt')).equals(protectedBefore), true, 'the protected file bytes must be unchanged');
        const fifoCall = toolCalls(readonlyCall.sessionFile!).find(call => call.name === 'verify_command' && String(call.arguments?.command).includes('restricted.fifo'));
        assert.ok(fifoCall, 'the model must really attempt the FIFO write');
        const fifoResult = toolResults(readonlyCall.sessionFile!).find(row => row.message.toolCallId === fifoCall!.id);
        assert.ok(fifoResult && fifoResult.message.details?.exitCode !== 0, 'the actual FIFO command must fail');
        assert.match(textOf(fifoResult!.message), /denied|EPERM|not permitted/i);
        let fifoBytes = 0;
        try { fifoBytes = readSync(fifoFd, Buffer.alloc(128)); }
        catch (error: any) { if (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK') throw error; }
        assert.equal(fifoBytes, 0, 'the live reader must receive no bytes from the sandbox');
        save('readonly-fifo', { control: control.toString(), receivedBytes: fifoBytes, command: fifoCall!.arguments.command });
        closeSync(fifoFd);
        fifoFd = undefined;
        record('readonly-passed', { runId: readonlyRun.runId, tools });

        // ── Case 4: Abort while a read-only verify_command is running ─────
        // Closing the pane kills the child pi, but the sandboxed command runs
        // in its own detached process group: the launcher has to reap that
        // group. The command proves it started by writing its pid inside its
        // private scratch directory, which only that command can write.
        const verifyRun: WorkflowRun = await manager.start({
          source: script('live-readonly-abort', [
            'return await agent(' + JSON.stringify(VERIFY_ABORT_PROMPT) + ', {',
            "  label: 'verify-abort',",
            '  readOnly: true,',
            '});',
          ].join('\n')),
          args: {},
          reuse: 'none',
        });
        record('readonly-abort-start', { runId: verifyRun.runId });
        const verifyExecution = verifyRun.execute();

        // Attribute the scratch root through this call's own launch script.
        // Scanning the shared tmpdir would happily pick up a parallel suite's
        // root, and the cleanup below must never touch another test's command.
        let launchCallName = '';
        await until(() => {
          const name = verifyRun.view().calls[0]?.name;
          if (!name) return false;
          launchCallName = name;
          return true;
        }, 'the call to claim its agent name', 60_000);
        let verifyLaunchFile = '';
        await until(() => {
          const scriptsDir = join(artifactDir, 'subagent-scripts');
          const file = existsSync(scriptsDir)
            ? readdirSync(scriptsDir).find(entry => entry.startsWith(launchCallName + '-') && entry.endsWith('.sh'))
            : undefined;
          if (!file) return false;
          verifyLaunchFile = join(scriptsDir, file);
          return true;
        }, 'the read-only launch script for this call', 60_000);
        const verifyScratch = /PI_SUBAGENT_VERIFY_SCRATCH='([^']+)'/.exec(readFileSync(verifyLaunchFile, 'utf8'))?.[1];
        assert.ok(verifyScratch, 'the launcher must hand this read-only step a private scratch root');

        const { ref, scratchDir: commandScratch } = await waitForSandboxCommand({
          parentScratch: verifyScratch!, markerName: 'started.pid', timeoutMs: 120_000,
        });
        const marker = join(commandScratch, 'started.pid');
        // A PID printed inside Linux's sandbox is not a host PID. The helper
        // attributes it through TMPDIR and /proc NSpid before ps/kill may use it.
        const markerPid = ref.hostPid;
        const markerNamespacePid = ref.namespacePid;
        // view() returns copies, so the object captured before the child
        // launched has no sessionFile yet. Re-read the view now that the child
        // is really running, and require a real session for the checks below.
        const verifyCall = verifyRun.view().calls.find(call => call.name === launchCallName);
        assert.ok(verifyCall, 'the running call must still be visible in the view');
        assert.ok(verifyCall!.sessionFile, 'the launched call must have a real child session');
        assert.equal(verifyCall!.status, 'running', 'the call must still be running when Abort lands');
        // Capture the group while it is alive: the group id is what the launcher
        // must reap, not merely the pane it was started from.
        const pgidText = execFileSync('ps', ['-o', 'pgid=', '-p', String(markerPid)], { encoding: 'utf8' }).trim();
        assert.match(pgidText, /^\d+$/, 'the running command must have a process group');
        const verifyPgid = Number(pgidText);
        // Pi is usually not a process-group leader, so compare against the real
        // parent group rather than the parent pid.
        const driverPgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
        assert.ok(Number.isInteger(driverPgid) && driverPgid > 0, 'the driver must know its own process group');
        assert.notEqual(verifyPgid, driverPgid, 'the command must not run in the driver process group');
        // The marker proves it started; this proves it is still running, so the
        // Abort below lands on a live command rather than on a finished one.
        const commandAlive = (() => { try { process.kill(markerPid, 0); return true; } catch { return false; } })();
        assert.equal(commandAlive, true, 'the long-running command must still be alive when Abort lands');
        // The marker pid must be this call's command in this call's scratch: the
        // path is inside the root parsed from the launch script, the command line
        // is the one this case asked for, and it belongs to the group above.
        assert.ok(marker.startsWith(verifyScratch! + '/'), 'the pid marker must live in this call scratch root');
        const markerCommand = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(markerPid)], { encoding: 'utf8' }).trim();
        assert.match(markerCommand, /started\.pid/, 'the marker pid must be the command this call launched');
        const markerPgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(markerPid)], { encoding: 'utf8' }).trim());
        assert.equal(markerPgid, verifyPgid, 'the marker pid must belong to the group being checked');
        save('readonly-abort-start', { marker, markerPid, markerNamespacePid, pgid: verifyPgid, driverPgid, call: verifyCall, commandAlive, markerCommand, scratchRoot: verifyScratch, launchScript: verifyLaunchFile });
        record('readonly-abort-command-started', { pid: markerPid, pgid: verifyPgid, commandAlive });

        verifyRun.abort('live protection: abort while verify_command runs');
        const verifyView = await verifyExecution;
        save('readonly-abort', verifyView);
        assert.equal(verifyView.status, 'aborted', verifyView.error);
        assert.equal(verifyView.calls[0].status, 'aborted');
        const verifySnapshot = JSON.parse(readFileSync(join(verifyView.runDir, 'snapshot.json'), 'utf8'));
        assert.equal(verifySnapshot.status, 'aborted', 'the aborted run must persist its terminal state');
        assert.deepEqual(
          rows(join(verifyView.runDir, 'journal.jsonl')).filter(entry => entry.callKey === verifyCall.callKey).map(entry => entry.status),
          ['aborted'],
          'the cancelled read-only call must keep one terminal journal line',
        );

        // Nothing from that command may outlive the call that started it.
        const alivePid = () => { try { process.kill(markerPid, 0); return true; } catch { return false; } };
        const psRows = () => execFileSync('ps', ['-eo', 'pid=,pgid=,command='], { encoding: 'utf8' })
          .trim().split('\n').map(line => {
            const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
            return match ? { pid: Number(match[1]), pgid: Number(match[2]), command: match[3] } : null;
          })
          .filter((row): row is { pid: number; pgid: number; command: string } => row !== null);
        const ownPgid = () => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
        const collectSurvivors = () => psRows().filter(row => row.pgid === verifyPgid && row.pid !== process.pid);
        let survivors: Array<{ pid: number; pgid: number; command: string }> = collectSurvivors();
        let cleanedUp = false;
        try {
          await until(() => {
            survivors = collectSurvivors();
            return !alivePid() && survivors.length === 0;
          }, 'the verify_command process group to be reaped', 15_000);
        } finally {
          // Even when production did not reap the group (or an assertion above
          // failed first), this case cleans up only a group it demonstrably owns:
          // the id came from this command's marker, it is not the driver's own
          // group, and a survivor still carries our command line. A failure here
          // must not leave a process behind to pollute later tests.
          survivors = collectSurvivors();
          // Re-read the driver's own group right before killing: the command
          // group must still be a different, non-init group at this moment.
          const ownNow = ownPgid();
          const isOwnGroup = verifyPgid > 1 && verifyPgid !== ownNow && verifyPgid !== driverPgid;
          const isOurCommand = survivors.some(row => row.command.includes('started.pid'));
          if (survivors.length > 0 && isOwnGroup && isOurCommand) {
            try { process.kill(-verifyPgid, 'SIGKILL'); } catch {}
            await until(() => collectSurvivors().length === 0, 'the case-owned group to die after cleanup', 5_000).catch(() => {});
            cleanedUp = collectSurvivors().length === 0;
            record('readonly-abort-cleanup', { pgid: verifyPgid, ownPgid: ownNow, cleanedUp });
          }
          save('readonly-abort-survivors', { pid: markerPid, pgid: verifyPgid, ownPgid: ownNow, driverPgid, survivors: collectSurvivors(), cleanedUp });
        }

        // Real-model evidence, independent of anything the command reported.
        assert.ok(hasProviderUsage(verifyCall.sessionFile!), 'the read-only child must have real provider usage');
        const verifyToolCalls = toolCalls(verifyCall.sessionFile!).filter(call => call.name === 'verify_command');
        assert.ok(verifyToolCalls.length >= 1, 'the model must really call verify_command');
        assert.match(JSON.stringify(verifyToolCalls[0].arguments), /started\.pid/, 'the call must be the long-running marker command');
        record('readonly-abort-passed', { runId: verifyRun.runId, pid: markerPid, pgid: verifyPgid });

        writeFileSync(join(dir, 'report.json'), JSON.stringify({
          ok: true,
          model: process.env.PI_TEST_MODEL,
          checks: ['skip-launch-window', 'abort-launch-window', 'resume-after-abort', 'readonly-verify', 'readonly-abort-verify'],
          skip: { runId: skipRun.runId, closeMs: skipCloseMs, successor: successorAfter.sessionFile },
          abort: { runId: abortRun.runId, closeMs: abortCloseMs, preResumeSnapshot: abortDisk.status },
          resume: { runId: abortRun.runId, session: resumedCall.sessionFile, finalSnapshot: finalSnapshot.status, journal: ['aborted', 'completed'] },
          readonly: { runId: readonlyRun.runId, session: readonlyCall.sessionFile, tools },
          readonlyAbort: {
            runId: verifyRun.runId,
            session: verifyCall.sessionFile,
            pid: markerPid,
            pgid: verifyPgid,
            marker,
            survivors,
          },
        }, null, 2));
        record('all-passed');
      } catch (error: any) {
        record('failed', { message: error?.message, stack: error?.stack });
        manager?.abortAll('live protection failure');
        writeFileSync(join(dir, 'report.json'), JSON.stringify({ ok: false, error: error?.stack ?? String(error) }, null, 2));
      } finally {
        if (fifoFd !== undefined) closeSync(fifoFd);
      }
    },
  });
}
