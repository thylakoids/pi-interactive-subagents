/** Independent checks over retained live artifacts, also reusable after a run. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { WorkflowRunView } from '../../pi-extension/subagents/workflow/types.ts';

/** Count the blocking branch, not unrelated inspections of its marker file. */
export function isStallRecoveryCommand(call: any): boolean {
  return call?.type === 'toolCall' && call.name === 'bash' && typeof call.arguments?.command === 'string'
    && /\bif test -f first\.pid; then/.test(call.arguments.command) && call.arguments.command.includes('sleep 90');
}

/** Recognize the cache probe's append, not inspections mentioning its file. */
const CACHE_EFFECT_APPEND = /(?:^|[;\n]|&&|\|\|)\s*printf\s+['"]effect\\+n['"]\s*>>\s*(?:cache-effects|'cache-effects'|"cache-effects")(?=\s*(?:[;\n]|&&|\|\||$))/;
export function isCacheEffectCommand(call: any): boolean {
  return call?.type === 'toolCall' && call.name === 'bash' && typeof call.arguments?.command === 'string'
    && CACHE_EFFECT_APPEND.test(call.arguments.command);
}

const SKIP_IO_SEQUENCE = /(?:^|[;\n]|&&|\|\|)\s*echo\s+STARTED\s*>\s*skip-io-started\s*(?:;|\n|&&)\s*sleep\s+5\s*(?:;|\n|&&)\s*echo\s+ESCAPED\s*>\s*skip-io-escaped(?=\s*(?:;|\n|&&|\|\||$))/;
export function isSkipIoCommand(call: any): boolean {
  return call?.type === 'toolCall' && call.name === 'bash' && typeof call.arguments?.command === 'string'
    && SKIP_IO_SEQUENCE.test(call.arguments.command);
}

/** Correlate each sandbox probe to its own execution, never the first exit=0. */
export function findVerificationProbeResult(calls: any[], results: any[], probe: 'test' | 'write' | 'fifo'): any {
  const patterns = {
    test: /(?:^|[;\n]|&&|\|\|)\s*node\s+--test\s+(?:\.\/)?guard\.test\.cjs(?=\s*(?:[;\n]|&&|\|\||$))/,
    write: /\bwriteFileSync\s*\(\s*['"]protected\.txt['"]\s*,/,
    fifo: /(?:^|[;\n]|&&|\|\|)\s*printf\s+(?:unexpected|'unexpected'|"unexpected")\s*>\s*(?:restricted\.fifo|'restricted\.fifo'|"restricted\.fifo")(?=\s*(?:[;\n]|&&|\|\||$))/,
  };
  const ids = new Set(calls.filter(call => call?.type === 'toolCall' && call.name === 'verify_command'
    && typeof call.arguments?.command === 'string' && patterns[probe].test(call.arguments.command)).map(call => call.id));
  return results.find(row => {
    const message = row.message;
    const details = message?.details;
    return message?.role === 'toolResult' && message.toolName === 'verify_command' && ids.has(message.toolCallId)
      && !message.isError && details?.ok === true && !details.timedOut && !details.cancelled
      && typeof details.exitCode === 'number' && (probe === 'test' ? details.exitCode === 0 : details.exitCode !== 0);
  });
}

export function hasPassingGuardOutput(text: string): boolean {
  return /^# pass 1\r?$/m.test(text) && /^# fail 0\r?$/m.test(text);
}

export const ACCEPTANCE_SOURCE = `const assert = require('node:assert/strict');
const { test } = require('node:test');
test('stable double', () => assert.equal(require('./safe.cjs').double(4), 8));
test('inclusive boundary', () => {
  const { isAdult } = require('./risky.cjs');
  assert.equal(isAdult(17), false); assert.equal(isAdult(18), true); assert.equal(isAdult(19), true);
});
`;

export function verifyLiveEvidence(dir: string) {
  const read = (name: string): WorkflowRunView => JSON.parse(readFileSync(join(dir, name + '.json'), 'utf8'));
  const review = read('review'), migration = read('migration'), pipeline = read('pipeline');
  const aborted = read('aborted'), resumed = read('resumed');
  assert.equal(readFileSync(join(dir, 'test.cjs'), 'utf8'), ACCEPTANCE_SOURCE, 'Models may not rewrite acceptance tests');
  assert.equal(readFileSync(join(dir, 'eligibility.cjs'), 'utf8'), 'exports.isAdult = age => age > 18;\n', 'Out-of-scope file must be untouched');
  execFileSync(process.execPath, ['-e', `
    const a = require('node:assert/strict');
    const { isAdult } = require('./risky.cjs');
    a.equal(isAdult(17), false); a.equal(isAdult(18), true); a.equal(isAdult(19), true);
    a.equal(require('./safe.cjs').double(4), 8);
  `], { cwd: dir });
  const snapshot = JSON.parse(readFileSync(join(resumed.runDir, 'snapshot.json'), 'utf8'));
  assert.equal((resumed.result as any).epoch, snapshot.startedAt);
  const fast = pipeline.calls.find(call => call.label === 'verify-fast')!;
  const slow = pipeline.calls.find(call => call.label === 'recon-slow')!;
  assert.ok(fast.startedAt! < slow.finishedAt!, 'Fast Verify must start before slow Recon finishes');
  assert.equal(readFileSync(join(dir, 'slow-end'), 'utf8'), 'ended');
  for (const item of ['slow', 'fast']) assert.equal(readFileSync(join(dir, item + '-verify'), 'utf8'), item);
  const files = [...new Set([review, migration, pipeline, aborted, resumed].flatMap(view => view.calls.map(call => call.sessionFile)).filter(Boolean))];
  const models = new Set<string>();
  let assistantResponses = 0, toolCalls = 0;
  for (const file of files) {
    const rows = readFileSync(file!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    for (const row of rows) if (row.message?.role === 'assistant') {
      assistantResponses++;
      models.add(row.message.provider + '/' + row.message.model);
      toolCalls += row.message.content.filter((part: any) => part.type === 'toolCall').length;
    }
  }
  assert.equal(files.length, 15, '2 review + 6 migration + 4 pipeline + 2 interrupted run + 1 resume session');
  const completed = resumed.calls.find(call => call.label === 'completed')!;
  assert.equal(completed.cached, true);
  assert.equal(completed.sessionFile, aborted.calls.find(call => call.label === 'completed')!.sessionFile);
  assert.equal(readFileSync(join(dir, 'completed-side-effect'), 'utf8'), 'done\n');
  assert.equal(readFileSync(join(dir, 'resume-attempts'), 'utf8'), 'started\nstarted\n');
  assert.equal(readFileSync(join(dir, 'resumed-side-effect'), 'utf8'), 'resumed\n');
  const summary = {
    ok: true, uniqueRealChildSessions: files.length, models: [...models], assistantResponses, toolCalls,
    review: { runId: review.runId, confirmed: (review.result as any).confirmed.length },
    migration: { runId: migration.runId, verified: (migration.result as any).verified, acceptanceTestUnchanged: true, independentAssertionsPassed: true },
    pipeline: { runId: pipeline.runId, fastVerifyStartedAt: fast.startedAt, slowReconFinishedAt: slow.finishedAt, overlapMs: slow.finishedAt! - fast.startedAt! },
    recovery: { runId: resumed.runId, cachedCompleted: true, completedSideEffectCount: 1, attempts: 2, resumedSideEffectCount: 1, persistedClockVerified: true },
  };
  writeFileSync(join(dir, 'evidence-summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}
