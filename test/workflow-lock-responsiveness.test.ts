import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const cycles = 20;
const heartbeatIntervalMs = 5;

async function measure(journal: URL) {
  const { acquireLock, releaseLock } = await import(journal.href);
  const dir = mkdtempSync(join(tmpdir(), 'workflow-lock-heartbeat-'));
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const lock = await acquireLock(dir);
      assert.ok(lock.ok, JSON.stringify(lock));
      assert.equal(await releaseLock(lock.path), true);
    }
    let previous = performance.now();
    let maximumGapMs = 0;
    let heartbeatsDuringWork = 0;
    let running = false;
    timer = setInterval(() => {
      const now = performance.now();
      maximumGapMs = Math.max(maximumGapMs, now - previous);
      previous = now;
      if (running) heartbeatsDuringWork++;
    }, heartbeatIntervalMs);
    await delay(20);
    previous = performance.now();
    maximumGapMs = 0;
    running = true;
    const start = performance.now();
    for (let i = 0; i < cycles; i++) {
      const lock = await acquireLock(dir);
      assert.ok(lock.ok, JSON.stringify(lock));
      assert.equal(await releaseLock(lock.path), true);
    }
    const elapsedMs = performance.now() - start;
    running = false;
    // Observe the delayed heartbeat after a sync baseline's microtask-only loop.
    await delay(20);
    return {
      cycles, helperTransactions: cycles * 2, heartbeatIntervalMs,
      elapsedMs: +elapsedMs.toFixed(2), heartbeatsDuringWork,
      maximumGapMs: +maximumGapMs.toFixed(2),
    };
  } finally {
    clearInterval(timer);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Optional before/after benchmark against an untouched checkout, on one machine:
// WORKFLOW_LOCK_BENCHMARK_BASELINE=/tmp/baseline-checkout \
//   node --test test/workflow-lock-responsiveness.test.ts
it('lock transactions allow heartbeat callbacks during 20 acquire/release cycles', { timeout: 20000 }, async t => {
  const baseline = process.env.WORKFLOW_LOCK_BENCHMARK_BASELINE;
  if (baseline) {
    const journal = pathToFileURL(resolve(baseline, 'pi-extension/subagents/workflow/journal.ts'));
    t.diagnostic(JSON.stringify({ label: 'baseline', ...await measure(journal) }));
  }
  const result = await measure(new URL('../pi-extension/subagents/workflow/journal.ts', import.meta.url));
  t.diagnostic(JSON.stringify({ label: 'current', node: process.version, platform: process.platform, arch: process.arch, ...result }));
  // Callback progress catches a synchronous regression without a flaky latency limit.
  assert.ok(result.heartbeatsDuringWork > 0, 'the main thread must service timers while lock helpers run');
});
