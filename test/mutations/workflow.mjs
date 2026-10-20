/** Regression sensitivity: reintroduce one historical fault in an isolated copy. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(join(tmpdir(), 'workflow-mutations-'));
const tests = ['test/workflow-contract.test.ts', 'test/workflow-templates.test.ts', 'test/workflow-worker.test.ts', 'test/model-inheritance.test.ts', 'test/workflow-questions.test.ts'];
const mutants = [
  ['torn journal tail absorbs the next settlement', 'pi-extension/subagents/workflow/journal.ts',
    'Buffer.from(separator + JSON.stringify(entry) + "\\n")', 'Buffer.from(JSON.stringify(entry) + "\\n")',
    'result settled after a torn append', 'test/workflow-journal-recovery.test.ts'],
  ['journal success does not flush its settlement', 'pi-extension/subagents/workflow/journal.ts',
    '    fsyncSync(fd);', '',
    'durability boundary handles short-write', 'test/workflow-journal-recovery.test.ts'],
  ['journal ignores short writes', 'pi-extension/subagents/workflow/journal.ts',
    '      offset += written;', '      offset = bytes.length;',
    'durability boundary handles short-write', 'test/workflow-journal-recovery.test.ts'],
  ['live marker inspections mistaken for recovery execution', 'test/integration/live-evidence.ts',
    "    && /\\bif test -f first\\.pid; then/.test(call.arguments.command) && call.arguments.command.includes('sleep 90');",
    "    && call.arguments.command.includes('first.pid');",
    'live evidence counts the blocking recovery command', 'test/workflow-live-evidence.test.ts'],
  ['no-work resume loses lifetime counters', 'pi-extension/subagents/workflow/manager.ts',
    '  private persistSnapshot(force = false): void {\n    this.snapshot.spentTokens = this.budgetView().spent;\n    this.snapshot.agentAttempts = this.launchedAgents;',
    '  private persistSnapshot(force = false): void {',
    'no-work resume preserves lifetime', 'test/workflow-accounting-recovery.test.ts'],
  ['SIGKILL recovery ignores failed journal spend', 'pi-extension/subagents/workflow/manager.ts',
    'entry.replayed ? 0 : entry.attemptTokens ?? entry.usage?.totalTokens ?? 0',
    'entry.replayed || entry.status !== "completed" ? 0 : entry.attemptTokens ?? entry.usage?.totalTokens ?? 0',
    'SIGKILL recovery charges durable failed', 'test/workflow-accounting-recovery.test.ts'],
  ['child returns before its own agents settle', 'pi-extension/subagents/workflow/manager.ts',
    'if (result.ok && scope.pending > 0 && !this.signal.aborted)', 'if (false)',
    'child-local unawaited work', 'test/workflow-nested.test.ts'],
  ['retry journal cumulatives are charged twice on reload', 'pi-extension/subagents/workflow/manager.ts',
    'attemptTokens: observed?.totalTokens ?? 0,', 'attemptTokens: liveCall.usage?.totalTokens ?? 0,',
    'opt-in retries keep attempt evidence', 'test/workflow-retry.test.ts'],
  ['parent accepts a forged structured sidecar', 'pi-extension/subagents/workflow/manager.ts',
    'if (parsed.opts.schema && !Value.Check(workflowResultSchema(parsed.opts.schema), value))', 'if (false)',
    'rejects a sidecar value', 'test/workflow-sidecar-validation.test.ts'],
  ['same-run resume erases historical spend', 'pi-extension/subagents/workflow/manager.ts',
    'if (!this.cachedUsageIsSpent && !this.replayedLogged.has(key))', 'if (!this.replayedLogged.has(key))',
    'opt-in retries keep attempt evidence', 'test/workflow-retry.test.ts'],
  ['start implicitly reuses previous answers', 'pi-extension/subagents/workflow/manager.ts',
    'params.reuse === "auto" ? this.findResumablePredecessor(parsed.meta.name, params.args) : null',
    'params.reuse === "none" ? null : this.findResumablePredecessor(parsed.meta.name, params.args)',
    'start is fresh unless', 'test/workflow-cache-identity.test.ts'],
  ['failed launch reporting strands the waiter', 'pi-extension/subagents/workflow/manager.ts',
    'outcome = this.settleLaunchFailure(liveCall, error);', 'return;',
    'journal write failure', 'test/workflow-review-manager.test.ts'],
  ['worktree cwd lost at the service boundary', 'pi-extension/subagents/workflow/manager.ts',
    '        cwd,\n        // Cancels a spawn', '        cwd: this.manager.cwd,\n        // Cancels a spawn',
    'manager executes isolated calls', 'test/workflow-worktree-integration.test.ts'],
  ['failed calls automatically retry', 'pi-extension/subagents/workflow/manager.ts',
    'attempt >= (parsed.opts.retries ?? 0)', 'attempt >= (parsed.opts.retries ?? 1)',
    'does not retry a failed call by default', 'test/workflow-retry.test.ts'],
  ['nested depth guard removed', 'pi-extension/subagents/workflow/manager.ts',
    'if (scope) throw new WorkflowScriptError("Maximum nested workflow depth is one: a child cannot nest another workflow.");', '',
    'refuses a child workflow that starts another', 'test/workflow-nested.test.ts'],
  ['cosmetic labels become semantic cache keys again', 'pi-extension/subagents/workflow/journal.ts',
    '    "v2", parts.kind, parts.agent ?? "",', '    "v2", parts.label, parts.kind, parts.agent ?? "",',
    'renaming labels replays', 'test/workflow-cache-identity.test.ts'],
  ['workflow name reservation lost before launch', 'pi-extension/subagents/wiring.ts',
    '      reserved.add(request.name);', '', 'reserves a workflow launch before await', 'test/workflow-review-wiring.test.ts'],
  ['nested free-form object closed again', 'pi-extension/subagents/workflow/structured-output.ts',
    'return Type.Object({}, { additionalProperties: true });', 'return Type.Object({}, { additionalProperties: false });',
    'keeps a nested object without properties', 'test/workflow-review-schema.test.ts'],
  ['read-only permission cache isolation disabled', 'pi-extension/subagents/workflow/journal.ts',
    '    parts.readOnly ? "readOnly" : "", parts.isolation ?? "",', '    "", parts.isolation ?? "",', 'readOnly reaches the service', 'test/workflow-readonly-integration.test.ts'],
  ['read-only adapter propagation disabled', 'pi-extension/subagents/wiring.ts',
    '          ...(request.readOnly ? { readOnly: true } : {}),', '', 'adapter forwards the restriction', 'test/workflow-readonly-integration.test.ts'],
  ['read-only resume enforcement disabled', 'pi-extension/subagents/index.ts',
    '  if (loadout.readOnly) {\n    // Re-enforce', '  if (false) {\n    // Re-enforce', 'saved readonly loadouts', 'test/workflow-readonly-integration.test.ts'],
  ['read-only tools unrestricted again', 'pi-extension/subagents/workflow/execution.ts',
    'const readOnly = options.readOnly === true;', 'const readOnly = false;', 'read-only execution keeps', 'test/workflow-readonly.test.ts'],
  ['sandbox filesystem default made writable', 'pi-extension/subagents/workflow/readonly.ts',
    '    "(deny default)",', '    "(allow default)",', 'runs a real test suite read-only', 'test/workflow-readonly.test.ts'],
  ['verification survives owning Pi death', 'pi-extension/subagents/workflow/readonly.ts',
    '  "  while :; do",', '  "  while false; do",', 'kills its process group when the owning pi process is SIGKILLed', 'test/workflow-readonly.test.ts'],
  ['Linux root made writable', 'pi-extension/subagents/workflow/readonly.ts',
    '    "--ro-bind", "/", "/",', '    "--bind", "/", "/",', 'runs a real test suite read-only', 'test/workflow-readonly.test.ts'],
  ['Linux socket filter removed', 'pi-extension/subagents/workflow/readonly.ts',
    '    "--seccomp", "3",', '', 'runs a real test suite read-only', 'test/workflow-readonly.test.ts'],
  ['Linux parent-death cleanup removed', 'pi-extension/subagents/workflow/readonly.ts',
    '    "--die-with-parent",', '', 'kills its process group when the owning pi process is SIGKILLed', 'test/workflow-readonly.test.ts'],
  ['Linux io_uring bypass reopened', 'pi-extension/subagents/workflow/readonly.ts',
    '[abi.socket, 425, 426, 427]', '[abi.socket]', 'Linux seccomp filter', 'test/workflow-readonly.test.ts'],
  ['Linux setup cancellation becomes a backend error', 'pi-extension/subagents/workflow/readonly.ts',
    '!executed && !error && !cancelled && !timedOut', '!executed && !error', 'preserves cancel while Linux sandbox setup', 'test/workflow-readonly.test.ts'],
  ['Linux FIFO write restrictions removed', 'pi-extension/subagents/workflow/linux-landlock.ts',
    'if libc.syscall(ctypes.c_long(RESTRICT_SELF), ctypes.c_int(ruleset), ctypes.c_uint32(0)) != 0:', 'if False:',
    'refuses writing to an existing FIFO', 'test/workflow-readonly.test.ts'],
  ['launch cancellation not forwarded', 'pi-extension/subagents/wiring.ts',
    '          ...(request.signal ? { signal: request.signal } : {}),', '', 'forwards the workflow request', 'test/workflow-launch-cancellation.test.ts'],
  ['pending spawn keeps its logical slot', 'pi-extension/subagents/workflow/manager.ts',
    '    this.slotReleases.get(callKey)?.();', '', 'frees a skipped call\x27s slot while its spawn is still pending', 'test/workflow-launch-cancellation.test.ts'],
  ['nonzero exit without error text is accepted', 'pi-extension/subagents/workflow/manager.ts',
    'if (result.exitCode !== 0)', 'if (result.error && result.exitCode !== 0)', 'fails a non-zero exit that carries no error text'],
  ['Skip holds its scheduling slot', 'pi-extension/subagents/workflow/manager.ts',
    '    this.abandonment.get(callKey)?.abort();\n    // The spawn may still be opening its pane; the queue must not wait for it.\n    this.slotReleases.get(callKey)?.();', '', 'frees a skipped call'],
  ['fatal failure is not persisted', 'pi-extension/subagents/workflow/manager.ts',
    '    this.persistSnapshot(true);\n  }\n\n  /**\n   * Stop everything',
    '  }\n\n  /**\n   * Stop everything', 'writes a fatal run failure to disk'],
  ['waiting is charged as working time', 'pi-extension/subagents/workflow/manager.ts',
    'if (waiting && waitedMs < waitAllowanceMs)', 'if (false)', 'starts counting work again when a wait ends'],
  ['research gaps incorrectly reported complete', 'examples/workflows/deep-research.js',
    ' && evidenceGaps.length === 0', ''],
  ['omitted research queries incorrectly reported complete', 'examples/workflows/deep-research.js',
    ' && omittedQueries.length === 0', ''],
  ['review admission ignores severity', 'examples/workflows/review-changes.js',
    'findings.slice().sort((left, right) => severityOf(left) - severityOf(right))', 'findings.slice()'],
  ['delegated result incorrectly answers pending question', 'pi-extension/subagents/subagent-done.ts',
    '    recorder.agentStart();', '    awaitingAnswer = false;\n    recorder.agentStart();'],
  ['working continues before parent reply', 'pi-extension/subagents/subagent-done.ts',
    'if (awaitingAnswer) return { block: true,', 'if (false) return { block: true,'],
  ['notification lost when parent delivery fails', 'pi-extension/subagents/index.ts',
    '} catch { return; } // Retry on the next watcher tick if delivery is unavailable.',
    '} catch { unlinkSync(askFile); return; } // Regression'],
  ['late reply accepted after workflow Abort', 'pi-extension/subagents/index.ts',
    'if (existsSync(`${running.sessionFile}.workflow-aborted`)) {', 'if (false) {'],
  ['undeclared workflow delegation enabled', 'pi-extension/subagents/workflow/execution.ts',
    '!BLOCKED_TOOLS.has(tool)', 'true'],
  ['workflow questions hidden again', 'pi-extension/subagents/workflow/execution.ts',
    "  tools.push('ask_question');", ''],
  ['declared workflow delegation disabled', 'pi-extension/subagents/workflow/execution.ts',
    'if (spawnable) tools.push(...SPAWNING_TOOLS);', ''],
  ['workflow policy not passed to launcher', 'pi-extension/subagents/wiring.ts',
    '          workflow: true,', '          workflow: false,'],
  ['old default journal reuse disabled', 'pi-extension/subagents/workflow/manager.ts',
    'if (!hasNamespace(base)) {', 'if (false) {', 'old default journals resume', 'test/workflow-worker.test.ts'],
  ['legacy name alias disabled', 'pi-extension/subagents/workflow/manager.ts',
    'requestedAgent === "workflow-subagent" && defined.unknown(requestedAgent)', 'false'],
  ['native Codex model pinned again', 'agents/codex-cli.md',
    'cli: codex\n', 'cli: codex\nmodel: hardcoded-test-model\n'],
  ['host clock leaks into replay', 'pi-extension/subagents/workflow/runner.ts',
    'run.deliver(nextResultSeq++, options.startedAt,', 'run.deliver(nextResultSeq++, Date.now(),'],
  ['aborted omitted from settled', 'pi-extension/subagents/workflow/state.ts',
    "status !== 'queued' && status !== 'running'", "status !== 'queued' && status !== 'running' && status !== 'aborted'"],
  ['failed audit treated as empty', 'examples/workflows/review-changes.js',
    '    if (!audit) return null\n', ''],
  ['failed apply still verified', 'examples/workflows/migrate-files.js',
    '    if (applied === null) return null\n', ''],
  ['failed fetch counted as evidence', 'examples/workflows/deep-research.js',
    'researched.filter((entry) => entry && entry.evidence)', 'researched.filter(Boolean)'],
  ['budget ignores failed branches', 'examples/workflows/deep-research.js',
    '(maxCalls - 1 - issuedCalls)', '(maxCalls - 2 - evidence.length * 2)'],
  ['missing votes reported complete', 'examples/workflows/deep-research.js',
    " && verdicts.every((entry) => entry && (entry.status === 'supported' || entry.status === 'refuted'))", ''],
];
const sandboxMutants = new Set(['sandbox filesystem default made writable', 'verification survives owning Pi death']);
const linuxMutants = new Set(['Linux root made writable', 'Linux socket filter removed', 'Linux parent-death cleanup removed', 'Linux FIFO write restrictions removed']);
const applicable = mutants.filter(([name]) => {
  if (sandboxMutants.has(name)) return process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
  return !linuxMutants.has(name) || process.platform === 'linux';
});
if (applicable.length !== mutants.length) console.log('Not run: mutations for the other OS backend (never claim simulated sandbox coverage).');
const execute = (pattern, testFile = 'test/workflow.test.ts') => spawnSync(process.execPath, pattern
  ? ['--test', '--test-timeout=10000', '--test-name-pattern=' + pattern, testFile]
  : ['--test', ...tests], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
let primaryFailed = false;
try {
  for (const path of ['pi-extension', 'agents', 'examples', 'skills', 'test', 'package.json', 'config.json.example']) cpSync(join(root, path), join(dir, path), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const baseline = execute();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  console.log('Baseline: passed');
  for (const [name, path, before, after, pattern, testFile] of applicable) {
    if (pattern) {
      const control = execute(pattern, testFile);
      assert.equal(control.status, 0, 'Targeted baseline failed: ' + name + '\n' + control.stdout + control.stderr);
    }
    const target = join(dir, path);
    const source = readFileSync(target, 'utf8');
    assert.equal(source.split(before).length, 2, 'Mutation must match exactly once: ' + name);
    writeFileSync(target, source.replace(before, after));
    try {
      const result = execute(pattern, testFile);
      assert.equal(result.status, 1, 'Mutant survived or crashed: ' + name + '\n' + result.stdout + result.stderr);
      assert.match(result.stdout, /ERR_ASSERTION/, 'Must fail an assertion, not a syntax/import error: ' + name);
      assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/);
      console.log('Detected: ' + name);
    } finally { writeFileSync(target, source); }
  }
  console.log(applicable.length + '/' + applicable.length + ' regression faults detected');
} catch (error) {
  primaryFailed = true;
  throw error;
} finally {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  catch (error) {
    if (!primaryFailed) throw error;
    console.error('Mutation fixture cleanup also failed:', error);
  }
}
