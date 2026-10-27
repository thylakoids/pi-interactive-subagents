/** Input/stream redraw cost. Run: node --expose-gc test/benchmarks/widget.mjs */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import extension, { __test__ } from '../../pi-extension/subagents/index.ts';
import { createStatusState } from '../../pi-extension/subagents/status.ts';

const hooks = new Map();
let factory;
const api = { on(event, handler) { hooks.set(event, [...(hooks.get(event) ?? []), handler]); },
  registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
  getThinkingLevel: () => 'off', getAllTools: () => [], sendMessage() {} };
const ctx = { hasUI: true, ui: { notify() {}, setWidget(_key, value) { factory = value; } } };
extension(api);
for (const hook of hooks.get('session_start') ?? []) await hook({}, ctx);
try {
  const startTime = Date.now();
  for (let i = 0; i < 16; i++) __test__.runningSubagents.set(String(i), {
    id: String(i), name: 'worker-' + i, agent: 'worker', cli: 'codex', startTime,
    statusState: createStatusState({ source: 'codex', startTimeMs: startTime }),
  });
  __test__.updateWidget();
  const widget = factory({ requestRender() {} }, {});
  widget.render(100);
  const samples = [];
  for (let round = 0; round < 7; round++) {
    global.gc?.();
    const cpu = process.cpuUsage(), start = performance.now();
    for (let i = 0; i < 1000; i++) assert.equal(widget.render(100).length, 18);
    const wallMs = performance.now() - start, used = process.cpuUsage(cpu);
    samples.push({ wallMs, cpuMs: (used.user + used.system) / 1000 });
  }
  samples.sort((a, b) => a.wallMs - b.wallMs);
  console.log(JSON.stringify({ agents: 16, redrawsPerSample: 1000, median: samples[3], samples }, null, 2));
} finally {
  __test__.runningSubagents.clear();
  for (const hook of hooks.get('session_shutdown') ?? []) await hook({ reason: 'quit' }, ctx);
}
