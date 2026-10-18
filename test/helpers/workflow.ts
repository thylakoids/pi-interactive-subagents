/** Scripted subagent boundary; scheduling, VM execution and journals remain real. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { WorkflowManager, type WorkflowManagerOptions } from '../../pi-extension/subagents/workflow/manager.ts';
import type { WorkflowSubagentRequest, WorkflowSubagentService } from '../../pi-extension/subagents/workflow/types.ts';

export interface Reply {
  value?: unknown;
  text?: string;
  error?: string;
  tokens?: number;
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export function script(body: string, name = 'contract') {
  return `export const meta = ${JSON.stringify({ name, description: 'Executable contract test', agent: 'worker' })}\n${body}`;
}
export function schemaFor(request: WorkflowSubagentRequest): Record<string, any> | undefined {
  return request.schemaFile ? JSON.parse(readFileSync(request.schemaFile, 'utf8')) : undefined;
}
export function fixture(
  t: TestContext,
  handle: (request: WorkflowSubagentRequest, index: number) => Reply | Promise<Reply>,
  options: Partial<WorkflowManagerOptions> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-contract-'));
  const calls: WorkflowSubagentRequest[] = [];
  const stopped: string[] = [];
  const unexpected: unknown[] = [];
  const listeners: Array<{ match: (call: WorkflowSubagentRequest) => boolean; done: (call: WorkflowSubagentRequest) => void }> = [];
  const service: WorkflowSubagentService = {
    isAvailable: () => ({ ok: true }),
    allowedAgents: () => ({ allowed: ['worker', 'scout', 'researcher', 'workflow-subagent'], unknown: name => !['worker', 'scout', 'researcher', 'workflow-subagent'].includes(name) }),
    agentKind: () => 'pi',
    sessionDefaults: () => ({}),
    takenNames: () => new Set(calls.map(call => call.name)),
    status: () => undefined,
    steer: async () => ({ ok: true }),
    focus: () => ({ ok: true }),
    stop: name => { stopped.push(name); },
    async spawn(request) {
      const index = calls.push(request) - 1;
      for (let i = listeners.length - 1; i >= 0; i--) {
        if (listeners[i].match(request)) listeners.splice(i, 1)[0].done(request);
      }
      const completion = Promise.resolve().then(() => handle(request, index)).then(reply => {
        if (request.resultFile && !reply.error) {
          assert.notEqual(reply.value, undefined, 'Structured calls need an explicitly scripted result');
          writeFileSync(request.resultFile, JSON.stringify({ ok: true, value: reply.value }));
        }
        return {
          exitCode: reply.error ? 1 : 0,
          summary: reply.text ?? '',
          error: reply.error,
          elapsedMs: 0,
          usage: { totalTokens: reply.tokens ?? 0, inputTokens: 0, outputTokens: reply.tokens ?? 0 },
        };
      }).catch(error => {
        // A test assertion must fail the test even if the workflow tolerates null.
        unexpected.push(error);
        return { exitCode: 1, summary: '', error: String(error), elapsedMs: 0 };
      });
      return { id: request.name, name: request.name, sessionFile: join(dir, `${request.name}.jsonl`), completion };
    },
  };
  const config: WorkflowManagerOptions = {
    baseDir: dir, cwd: dir, sessionFile: join(dir, 'parent.jsonl'),
    sessionId: 'contract', agentDir: dir, service, ...options,
  };
  const manager = new WorkflowManager(config);
  t.after(() => {
    manager.abortAll('test cleanup');
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
    assert.deepEqual(unexpected, [], 'Assertions in scripted agents must not be swallowed as agent failures');
  });
  return {
    dir, calls, stopped, manager, service,
    reload: () => new WorkflowManager(config),
    waitForCall(match: (call: WorkflowSubagentRequest) => boolean) {
      const existing = calls.find(match);
      return existing ? Promise.resolve(existing) : new Promise<WorkflowSubagentRequest>(done => listeners.push({ match, done }));
    },
  };
}
