/** Exercises the real replay bridge while counting cache-key traversal. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WorkflowRun } from '../../pi-extension/subagents/workflow/manager.ts';
import { callKey } from '../../pi-extension/subagents/workflow/journal.ts';
import type { WorkflowJournalEntry, WorkflowSubagentService } from '../../pi-extension/subagents/workflow/types.ts';

type Cached = { value: unknown; entry: WorkflowJournalEntry };
class CountingCache extends Map<string, Cached> {
  keyVisits = 0;
  override *keys(): MapIterator<string> {
    for (const key of super.keys()) { this.keyVisits++; yield key; }
  }
}

export async function probeWorkflowCache(size: number) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-cache-probe-'));
  try {
    const cache = new CountingCache();
    for (let i = 0; i < size; i++) {
      const prompt = 'task-' + i;
      const key = callKey({ kind: 'agent', prompt, label: 'worker', agent: 'worker' });
      cache.set(key, { value: i, entry: { type: 'call', callKey: key, label: 'worker', agentType: 'worker', prompt, status: 'completed', value: i } });
    }
    const service: WorkflowSubagentService = {
      isAvailable: () => ({ ok: true }),
      allowedAgents: () => ({ allowed: ['worker'], unknown: name => name !== 'worker' }),
      agentKind: () => 'pi', sessionDefaults: () => ({}), takenNames: () => new Set(), status: () => undefined,
      spawn: async () => { throw new Error('A cache hit must never launch an agent'); },
      stop() {}, steer: async () => ({ ok: true }), focus: () => ({ ok: true }),
    };
    const started = performance.now();
    const run = new WorkflowRun({ baseDir: dir, cwd: dir, sessionFile: join(dir, 'session.jsonl'), sessionId: 'cache', agentDir: dir, service }, {
      runId: 'probe', meta: { name: 'probe', description: 'Cache work probe', agent: 'worker' },
      source: 'return null;', scriptSource: 'return null;', args: {}, seed: 1, startedAt: 1, cache, cachedUsageIsSpent: true,
    });
    const buildMs = performance.now() - started;
    for (let i = 0; i < size; i++) {
      await run.dispatch({ id: i, target: 'global', name: '__wfBridgeAgent', args: ['task-' + i] }, outcome => {
        assert.equal(outcome.ok, true);
        if (outcome.ok) assert.equal(outcome.value, i);
      });
    }
    return { size, keyVisits: cache.keyVisits, buildMs, replayMs: performance.now() - started - buildMs };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
