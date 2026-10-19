/**
 * Regressions for the two manager bugs from issue #3.
 *
 * 1. `launchAgent` created the per-call directory and wrote the schema sidecar
 *    outside its try, so an IO failure there (ENOSPC/EACCES) rejected the
 *    enqueue task: the waiter was never resolved (the script hung forever) and
 *    the rejection surfaced as an unhandled rejection.
 * 2. A same-name/same-args `start` reuses the predecessor run's completed
 *    calls. Their journaled usage was seeded into the new run's live view, and
 *    `budgetView()` sums live usage — so the new run began with the previous
 *    run's tokens already spent and could fail before it launched anything.
 *
 * Everything runs through the real VM, scheduler and journal.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers/workflow.ts';

interface JournalEntry { status: string; error?: string; callKey: string; label: string }

function journalRows(runDir: string): JournalEntry[] {
  const raw = readFileSync(join(runDir, 'journal.jsonl'), 'utf8').trim();
  return raw ? raw.split('\n').map(line => JSON.parse(line)) : [];
}

/**
 * Await a run, bounded: a lost waiter leaves the script awaiting forever, and a
 * hanging suite would hide the regression instead of reporting it.
 */
async function settlesWithin(run: { execute(): Promise<any>; abort(reason?: string): void }, ms: number): Promise<any> {
  const raced = await Promise.race([
    run.execute().then((view: any) => ({ view })),
    new Promise<{ timedOut: true }>(resolve => {
      const timer = setTimeout(() => resolve({ timedOut: true }), ms);
      (timer as any).unref?.();
    }),
  ]);
  assert.ok(!('timedOut' in raced), 'the run must settle instead of hanging on a lost waiter');
  return (raced as { view: any }).view;
}

const REACHED_SCRIPT = [
  "export const meta = { name: 'io-call-dir', description: 'x', agent: 'worker' }",
  "const value = await agent('probe', { label: 'probe' });",
  "return { value, reached: true };",
  '',
].join('\n');

it('reports a call whose directory cannot be created instead of hanging the script', async t => {
  const f = fixture(t, () => ({ text: 'never launched' }));
  const run = await f.manager.start({ source: REACHED_SCRIPT, args: {}, reuse: 'none' });
  // The run directory exists, but its `calls` path is a file: creating the
  // per-call directory fails (ENOTDIR) before any agent is launched.
  writeFileSync(join(run.runDir, 'calls'), 'not a directory');

  const view = await settlesWithin(run, 5_000);
  assert.equal(view.status, 'completed', view.error);
  assert.deepEqual(view.result, { value: null, reached: true }, 'the script must continue with null');
  assert.equal(f.calls.length, 0, 'no agent may be spawned after the IO failure');
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0].status, 'failed');
  const journal = journalRows(run.runDir);
  assert.deepEqual(journal.map(entry => entry.status), ['failed']);
  assert.match(String(journal[0].error), /ENOTDIR|not a directory/i);
});

const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

it('does not turn a journal write failure into an unhandled rejection', {
  // The probe denies writes with a directory mode; root ignores that mode.
  skip: runningAsRoot ? 'chmod cannot deny writes to root; run unprivileged' : false,
}, async t => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));

  const f = fixture(t, () => ({ text: 'never launched' }));
  const run = await f.manager.start({ source: REACHED_SCRIPT, args: {}, reuse: 'none' });
  // Both writes fail: the call directory cannot be created and the journal
  // cannot be appended. Recording the failure therefore throws as well — the
  // script still has to settle, and nothing may escape as a second rejection.
  chmodSync(run.runDir, 0o500);
  try {
    const view = await settlesWithin(run, 5_000);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(rejections, [], 'no rejection may escape the enqueue task');
    assert.equal(view.status, 'completed', view.error);
    assert.deepEqual(view.result, { value: null, reached: true }, 'the script must continue with null');
    assert.equal(f.calls.length, 0);
    assert.equal(view.calls[0].status, 'failed', 'the call is settled in memory even without a journal');
  } finally {
    chmodSync(run.runDir, 0o700);
  }
});

const REUSE_V1 = [
  "export const meta = { name: 'budget-reuse', description: 'x', agent: 'worker' }",
  "await agent('a', { label: 'a' });",
  "return 'first';",
  '',
].join('\n');

const REUSE_V2 = [
  "export const meta = { name: 'budget-reuse', description: 'x', agent: 'worker' }",
  "const a = await agent('a', { label: 'a' });",
  "const spentAfterCache = await budget.spent();",
  "const b = await agent('b', { label: 'b' });",
  "return { a, b, spentAfterCache, spentAfterB: await budget.spent() };",
  '',
].join('\n');

it('does not charge a reused predecessor run tokens to the new run budget', async t => {
  const f = fixture(t, () => ({ text: 'ok', tokens: 800 }), { budgetTotal: 1_000 });
  const first = await (await f.manager.start({ source: REUSE_V1, args: {} })).execute();
  assert.equal(first.status, 'completed', first.error);
  assert.equal(f.calls.length, 1);

  // Same meta name and args: this start replays call 'a' from the predecessor.
  const second = await (await f.manager.start({ source: REUSE_V2, args: {}, budgetTotal: 500, reuse: 'auto' })).execute();
  assert.equal(second.status, 'completed', second.error);
  const result = second.result as { a: unknown; b: unknown; spentAfterCache: number; spentAfterB: number };
  assert.equal(result.a, 'ok', 'the predecessor answer is replayed');
  assert.equal(result.spentAfterCache, 0, 'a replayed call must not look like spend in this run');
  assert.equal(result.b, 'ok');
  assert.equal(result.spentAfterB, 800, 'only the call this run launched is charged');
  assert.equal(f.calls.length, 2, 'only the new call spawns an agent');
});

const RESUME_SCRIPT = [
  "export const meta = { name: 'budget-resume', description: 'x', agent: 'worker' }",
  "await agent('a', { label: 'a' });",
  "await agent('b', { label: 'b' });",
  "return 'done';",
  '',
].join('\n');

it('still charges a resumed run the tokens its own earlier calls spent', async t => {
  const f = fixture(t, () => ({ text: 'ok', tokens: 800 }), { budgetTotal: 500 });
  const run = await f.manager.start({ source: RESUME_SCRIPT, args: {}, reuse: 'none' });
  const first = await run.execute();
  assert.equal(first.status, 'failed');
  assert.match(String(first.error), /budget exhausted/);
  assert.equal(f.calls.length, 1, 'the budget stops the second call before it launches');
  const journal = journalRows(run.runDir);
  assert.equal(journal[0].status, 'completed', 'the first call really ran and is journaled');
  assert.ok(
    journal.slice(1).every(entry => entry.status === 'aborted'),
    'the call the fatal budget error caught in flight is aborted, never completed: ' + JSON.stringify(journal.map(entry => entry.status)),
  );

  // Resume of the same run: its own earlier spend still counts, so the budget
  // must stop the retried second call again instead of handing out a new one.
  const resumed = await (await f.manager.resume(run.runId)).execute();
  assert.equal(resumed.status, 'failed');
  assert.match(String(resumed.error), /budget exhausted/);
  assert.equal(f.calls.length, 1, 'resume must not launch past the same budget');
});
