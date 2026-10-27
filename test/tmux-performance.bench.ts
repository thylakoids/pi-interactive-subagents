/** Reproduce: node test/tmux-performance.bench.ts [baseline-git-ref]
 * Subprocesses are deterministic fixtures: timings measure JS traversal/parsing,
 * not tmux startup. Query counts measure actual calls made by each implementation.
 */
import { execFileSync } from 'node:child_process';
import { mock } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { tmuxFixture } from './tmux-fixture.ts';

const baselineRef = process.argv[2] ?? '592fafa';
const dir = mkdtempSync(join(tmpdir(), 'tmux-benchmark-'));
const source = execFileSync('git', ['show', `${baselineRef}:pi-extension/subagents/tmux.ts`], { encoding: 'utf8' });
const baselineFile = join(dir, 'baseline.ts');
writeFileSync(baselineFile, source.replaceAll('"./surface-owner.ts"', JSON.stringify(new URL('../pi-extension/subagents/surface-owner.ts', import.meta.url).href))
  .replaceAll('"./layout.ts"', JSON.stringify(new URL('../pi-extension/subagents/layout.ts', import.meta.url).href)));

const results: Record<string, unknown>[] = [];
try {
  for (const [label, moduleUrl] of [
    [`baseline ${baselineRef}`, pathToFileURL(baselineFile).href],
    ['current', new URL('../pi-extension/subagents/tmux.ts', import.meta.url).href],
  ]) {
    const cleanup: (() => void)[] = [];
    mock.method(process, 'kill', () => true);
    const totalPanes = 4000;
    const ownedPanes = 120;
    const processCount = 12000;
    const paneRows = Array.from({ length: totalPanes }, (_, i) => {
      const id = i + 1;
      const parent = id > 1 && id <= ownedPanes ? `%${id - 1}` : '%foreign';
      return { id: `%${id}`, parent, pid: 100000 + id };
    });
    const processes = Array.from({ length: processCount }, (_, i) => {
      const pid = 100001 + i;
      const parent = i === 0 ? 1 : pid - 1;
      return `${pid} ${parent} tool`;
    }).join('\n');
    let phase: 'cleanup' | 'poll' = 'cleanup';
    const { tmux, calls } = await tmuxFixture({ mock, after(fn: () => void) { cleanup.push(fn); } } as any, ({ command, args }) => {
      if (command === 'ps') return processes;
      if (phase === 'poll') return new Promise(resolve => setImmediate(() => resolve('')));
      if (args[0] === 'display-message') return ''; // already closed: no layout repair needed
      if (args[0] === 'kill-pane') return '';
      const format = args[args.indexOf('-F') + 1];
      if (format.includes('@pi_subagent_parent') && format.includes('pane_pid')) {
        return paneRows.map(p => `${p.id}|${p.parent}|${p.pid}|0`).join('\n');
      }
      if (format.includes('@pi_subagent_parent')) return paneRows.map(p => `${p.id}|${p.parent}`).join('\n');
      return paneRows.map(p => `${p.id}|${p.pid}|0`).join('\n');
    }, moduleUrl);
    try {
      const durations: number[] = [];
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        tmux.closeSurfaceTree('%1');
        durations.push(performance.now() - start);
      }
      const cleanupCalls = calls.splice(0);
      phase = 'poll';
      const controller = new AbortController();
      // Baseline ignores native screen sentinels, so stop each live poll after
      // one tick; current sees the fixture's empty snapshot as a closed pane.
      await Promise.all(Array.from({ length: 64 }, (_, i) => tmux.pollForExit(`%${i}`, controller.signal, {
        cli: true, interval: 1000, onTick() { controller.abort(); },
      }).catch(() => undefined)));
      results.push({
        implementation: label,
        cleanupMedianMs: +durations.sort((a, b) => a - b)[3].toFixed(2),
        cleanupAllPaneQueriesPerRun: cleanupCalls.filter(c => c.args[0] === 'list-panes' && c.args.includes('-a')).length / 7,
        nativePollers: 64,
        nativeQueries: calls.length,
        nativeCaptures: calls.filter(c => c.args[0] === 'capture-pane').length,
      });
    } finally {
      cleanup.reverse().forEach(fn => fn());
    }
  }
  console.log(JSON.stringify({ baselineRef, totalPanes: 4000, ownedPanes: 120, processCount: 12000, results }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
