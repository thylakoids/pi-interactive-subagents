/** Shared accounting for live views, recovered journals and the status widget. */
import type { WorkflowAgentResultMeta, WorkflowCallStatus, WorkflowUsage } from './types.ts';

export function isCallSettled(status: WorkflowCallStatus): boolean {
  return status !== 'queued' && status !== 'running';
}

export function summarizeCalls(calls: WorkflowAgentResultMeta[]) {
  const usage: WorkflowUsage = {};
  let settled = 0;
  let completed = 0;
  let failed = 0;
  let active = 0;
  for (const call of calls) {
    if (isCallSettled(call.status)) settled++;
    if (call.status === 'completed') completed++;
    if (call.status === 'failed') failed++;
    if (call.status === 'running') active++;
    if (call.usage) {
      for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'cost'] as const) {
        if (call.usage[field] !== undefined) usage[field] = (usage[field] ?? 0) + call.usage[field];
      }
    }
  }
  return { settled, completed, failed, active, usage, progress: calls.length ? settled / calls.length : 0 };
}
