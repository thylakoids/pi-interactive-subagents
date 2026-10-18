/** Regression sensitivity: reintroduce one historical fault in an isolated copy. */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(join(tmpdir(), 'workflow-mutations-'));
const tests = ['test/workflow-contract.test.ts', 'test/workflow-templates.test.ts', 'test/workflow-worker.test.ts', 'test/model-inheritance.test.ts'];
const mutants = [
  ['workflow control tools re-enabled', 'pi-extension/subagents/workflow/execution.ts',
    '!BLOCKED_TOOLS.has(tool)', 'true'],
  ['workflow policy not passed to launcher', 'pi-extension/subagents/wiring.ts',
    '          workflow: true,', '          workflow: false,'],
  ['old default journal reuse disabled', 'pi-extension/subagents/workflow/manager.ts',
    'if (!hasNamespace(base) && hasNamespace(legacyBase))', 'if (false)'],
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
const execute = () => spawnSync(process.execPath, ['--test', ...tests], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
try {
  for (const path of ['pi-extension', 'agents', 'examples', 'skills', 'test', 'package.json', 'config.json.example']) cpSync(join(root, path), join(dir, path), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const baseline = execute();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  console.log('Baseline: passed');
  for (const [name, path, before, after] of mutants) {
    const target = join(dir, path);
    const source = readFileSync(target, 'utf8');
    assert.equal(source.split(before).length, 2, 'Mutation must match exactly once: ' + name);
    writeFileSync(target, source.replace(before, after));
    try {
      const result = execute();
      assert.equal(result.status, 1, 'Mutant survived or crashed: ' + name + '\n' + result.stdout + result.stderr);
      assert.match(result.stdout, /ERR_ASSERTION/, 'Must fail an assertion, not a syntax/import error: ' + name);
      assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/);
      console.log('Detected: ' + name);
    } finally { writeFileSync(target, source); }
  }
  console.log(mutants.length + '/' + mutants.length + ' regression faults detected');
} finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
