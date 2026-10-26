/** Opt-in CPU/memory probe. Run with: node --expose-gc test/benchmarks/runtime.mjs */
import assert from 'node:assert/strict';
import { openSync, writeSync, closeSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = resolve(import.meta.dirname, '../..');
const { getLeafId, summarizeSession } = await import(pathToFileURL(join(root, 'pi-extension/subagents/session.ts')));
const { WorkflowPanel } = await import(pathToFileURL(join(root, 'pi-extension/subagents/workflow/ui.ts')));
const dir = mkdtempSync(join(tmpdir(), 'pi-runtime-benchmark-'));
const measure = (work) => {
  global.gc?.();
  const before = process.memoryUsage(), cpu = process.cpuUsage(), start = performance.now();
  const value = work();
  const wallMs = performance.now() - start, used = process.cpuUsage(cpu), after = process.memoryUsage();
  global.gc?.();
  return { value, wallMs, cpuMs: (used.user + used.system) / 1000,
    heapGrowthMB: (after.heapUsed - before.heapUsed) / 1048576,
    retainedHeapMB: (process.memoryUsage().heapUsed - before.heapUsed) / 1048576,
    rssGrowthMB: (after.rss - before.rss) / 1048576 };
};
try {
  const file = join(dir, 'session.jsonl'), fd = openSync(file, 'w');
  writeSync(fd, JSON.stringify({ type: 'session', id: 'session' }) + '\n');
  const chunk = Array.from({ length: 500 }, (_, i) => JSON.stringify({ type: 'message', id: 'entry-' + i,
    message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(2000) }] } })).join('\n') + '\n';
  for (let i = 0; i < 50; i++) writeSync(fd, chunk);
  writeSync(fd, JSON.stringify({ type: 'message', id: 'last-entry', message: { role: 'assistant', model: 'benchmark',
    content: [{ type: 'text', text: 'Summary ready ✓' }], usage: { input: 123, output: 456, totalTokens: 579 } } }) + '\n');
  closeSync(fd);
  const leaf = measure(() => getLeafId(file));
  assert.equal(leaf.value, 'last-entry');
  const completion = measure(() => summarizeSession(file));
  assert.equal(completion.value.summary, 'Summary ready ✓');
  assert.equal(completion.value.stats.contextTokens, 579);
  const views = Array.from({ length: 500 }, (_, i) => ({ runId: 'r' + i,
    meta: { name: 'task-' + i, description: 'bench', phases: ['Review'] }, status: 'completed',
    createdAt: i, updatedAt: i + 1000, startedAtWall: i, finishedAt: i + 1000,
    calls: Array.from({ length: 20 }, (_, j) => ({ callKey: 'c' + j, label: 'call-' + j, status: 'completed', phase: 'Review' })),
    usage: {}, totalCount: 20, activeCount: 0, completedCount: 20, failedCount: 0, progress: 1, logs: [] }));
  const panel = new WorkflowPanel({ views: () => views, isLive: () => false, notify() {},
    callbacks: { focus() { return { ok: true }; }, skip() {}, abort() {}, resume() {} } });
  const theme = { fg: (_, text) => text, bold: text => text };
  panel.renderPanel(theme, 100, undefined, 36);
  const redraw = measure(() => { for (let i = 0; i < 20; i++) panel.renderPanel(theme, 100, undefined, 36); return 20; });
  console.log(JSON.stringify({ sessionMB: statSync(file).size / 1048576, leaf, completion,
    panelRuns: views.length, redraw, maxRSSMB: process.resourceUsage().maxRSS / 1024 }, null, 2));
} finally { rmSync(dir, { recursive: true, force: true }); }
