/**
 * Launch-cancellation tests.
 *
 * A workflow call (or a foreground `subagent` launch) can be cancelled while
 * its pane is still being opened. These tests pin the contract at the seam the
 * runtime owns: the spawn request carries an AbortSignal, a cancelled spawn
 * rejects without a child, the scheduler frees the call's slot immediately
 * instead of waiting for the launcher, and a handle that arrives late is closed
 * without rewriting the terminal journal line.
 *
 * The fake service's spawn is gate-controlled, so every scenario is a state the
 * test drives, never a sleep long enough to probably work.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkflowManager } from "../pi-extension/subagents/workflow/manager.ts";
import { createWorkflowSubagentService } from "../pi-extension/subagents/wiring.ts";
import {
  SubagentLaunchCancelledError,
  throwIfLaunchCancelled,
  waitForShellReady,
} from "../pi-extension/subagents/index.ts";
import type {
  WorkflowSubagentCompletion,
  WorkflowSubagentRequest,
  WorkflowSubagentService,
} from "../pi-extension/subagents/workflow/types.ts";

// ── helpers ────────────────────────────────────────────────────────────────

/** A promise the test resolves by hand, so a launch window is a state. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function drainTicks(turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const caseDirs: string[] = [];
after(() => {
  for (const dir of caseDirs) rmSync(dir, { recursive: true, force: true });
});

function createManager(service: WorkflowSubagentService): WorkflowManager {
  const dir = mkdtempSync(join(tmpdir(), "wf-cancel-"));
  caseDirs.push(dir);
  return new WorkflowManager({
    baseDir: dir,
    cwd: dir,
    sessionFile: join(dir, "session.jsonl"),
    sessionId: "cancel-session",
    agentDir: dir,
    service,
  });
}

/**
 * The launcher seam, controlled by the test.
 *
 * `gated` tasks block in spawn until the test releases their gate: that is the
 * window in which a call is decided while its pane is still being opened.
 * `honourSignal` decides whether a cancelled spawn rejects (the launcher this
 * change adds) or resolves anyway (a pane that raced past the cancel: its late
 * handle must still be closed).
 */
function fakeService(options: { honourSignal?: boolean; gated?: string[] } = {}) {
  const honourSignal = options.honourSignal ?? true;
  const gated = options.gated ?? [];
  const spawns: WorkflowSubagentRequest[] = [];
  const stopped: string[] = [];
  /** Spawns whose request signal actually fired: proof the cancel arrived. */
  const cancelled: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();

  const service: WorkflowSubagentService = {
    isAvailable: () => ({ ok: true }),
    allowedAgents: () => ({ allowed: ["worker"], unknown: () => false }),
    agentKind: () => "pi",
    sessionDefaults: () => ({}),
    takenNames: () => new Set(spawns.map((spawn) => spawn.name)),
    status: () => ({ kind: "active", detail: "work" }),
    focus: () => ({ ok: true }),
    steer: async () => ({ ok: true }),
    stop(name: string) {
      stopped.push(name);
    },
    spawn(request: WorkflowSubagentRequest) {
      spawns.push(request);
      const isGated = gated.some((needle) => request.task.includes(needle));
      const gate = deferred();
      if (isGated) gates.set(request.name, gate);

      const completion = isGated
        ? new Promise<WorkflowSubagentCompletion>(() => {})
        : Promise.resolve({
            exitCode: 0,
            summary: `echo:${request.task}`,
            elapsedMs: 1,
          } satisfies WorkflowSubagentCompletion);

      const handle = {
        id: request.name,
        name: request.name,
        sessionFile: `/tmp/${request.name}.jsonl`,
        completion,
      };

      if (!isGated) return Promise.resolve(handle);

      return new Promise((resolve, reject) => {
        const signal = request.signal;
        if (honourSignal && signal?.aborted) {
          cancelled.push(request.name);
          reject(new SubagentLaunchCancelledError());
          return;
        }
        const onAbort = () => {
          cancelled.push(request.name);
          reject(new SubagentLaunchCancelledError());
        };
        if (honourSignal) signal?.addEventListener("abort", onAbort, { once: true });
        gate.promise.then(() => {
          if (honourSignal) signal?.removeEventListener("abort", onAbort);
          resolve(handle);
        });
      });
    },
  };

  return { service, spawns, stopped, cancelled, gates };
}

function journalFor(runDir: string, callKey: string) {
  return readFileSync(join(runDir, "journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.callKey === callKey);
}

// ── scheduler: the slot is a runtime resource ──────────────────────────────

describe("workflow launch cancellation", () => {
  it("frees a skipped call's slot while its spawn is still pending", async (t) => {
    // One slot, two calls, the first spawn gated open. The skip must return the
    // slot immediately: the second call starts before the first launcher does.
    const previous = process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS;
    process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS = "1";
    try {
      const fake = fakeService({ honourSignal: false, gated: ["slow"] });
      const manager = createManager(fake.service);
      const script = `export const meta = { name: 'cancel-slot', description: 'x' }
return await parallel([
  () => agent('slow one', { label: 'slow' }),
  () => agent('quick one', { label: 'quick' }),
]);
`;
      const run = await manager.start({ source: script, args: {} });
      t.after(() => run.abort());
      const executing = run.execute();
      await waitFor(() => fake.gates.size === 1, "the first spawn to be pending");

      const slow = run.view().calls.find((call) => call.label === "slow")!;
      const slowName = [...fake.gates.keys()][0];
      assert.equal(run.skip(slow.callKey), true);

      // The gated spawn has not returned yet, and the second call already runs.
      // Bounded observation, then a plain assertion so a regression fails with
      // ERR_ASSERTION instead of a timeout error.
      await waitFor(() => fake.spawns.length === 2, "the freed slot to start the second call", 1000)
        .catch(() => undefined);
      assert.equal(fake.spawns.length, 2, "the freed slot must start the second call before the first spawn returns");
      assert.equal(fake.gates.size, 1, "the first spawn is still open inside the launcher");

      const view = await executing;
      assert.equal(view.status, "completed", view.error);
      assert.equal(view.calls.find((call) => call.label === "slow")?.status, "skipped");
      assert.equal(view.calls.find((call) => call.label === "quick")?.status, "completed");

      // The pane that raced past the cancel arrives now and is closed.
      fake.gates.get(slowName)!.resolve();
      await waitFor(() => fake.stopped.includes(slowName), "the late pane to be closed");
      assert.deepEqual(journalFor(view.runDir, slow.callKey).map((entry) => entry.status), ["skipped"]);
    } finally {
      if (previous === undefined) delete process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS;
      else process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS = previous;
    }
  });

  it("frees an aborted call's slot and closes the pane that arrives late", async (t) => {
    const previous = process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS;
    process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS = "1";
    try {
      const fake = fakeService({ honourSignal: false, gated: ["slow"] });
      const manager = createManager(fake.service);
      const script = `export const meta = { name: 'abort-launch', description: 'x' }
return await parallel([
  () => agent('slow one', { label: 'slow' }),
  () => agent('quick one', { label: 'quick' }),
]);
`;
      const run = await manager.start({ source: script, args: {} });
      t.after(() => run.abort());
      const executing = run.execute();
      await waitFor(() => fake.gates.size === 1, "the first spawn to be pending");
      const slowName = [...fake.gates.keys()][0];
      const slow = run.view().calls.find((call) => call.label === "slow")!;

      run.abort();
      const view = await executing;
      assert.equal(view.status, "aborted", view.error);
      assert.equal(view.calls.find((call) => call.callKey === slow.callKey)?.status, "aborted");

      fake.gates.get(slowName)!.resolve();
      await waitFor(() => fake.stopped.includes(slowName), "the late pane to be closed");
      assert.deepEqual(journalFor(view.runDir, slow.callKey).map((entry) => entry.status), ["aborted"]);
    } finally {
      if (previous === undefined) delete process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS;
      else process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS = previous;
    }
  });

  it("consumes a cancelled spawn's rejection without rewriting the journal", async (t) => {
    const leaked: unknown[] = [];
    const onRejection = (reason: unknown) => leaked.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const fake = fakeService({ honourSignal: true, gated: ["slow"] });
      const manager = createManager(fake.service);
      const script = `export const meta = { name: 'cancel-reject', description: 'x' }
return await agent('slow one', { label: 'slow' });
`;
      const run = await manager.start({ source: script, args: {} });
      t.after(() => run.abort());
      const executing = run.execute();
      await waitFor(() => fake.gates.size === 1, "the spawn to be pending");
      const slow = run.view().calls.find((call) => call.label === "slow")!;
      assert.equal(run.skip(slow.callKey), true);

      const view = await executing;
      await drainTicks();
      assert.equal(view.status, "completed", view.error);
      assert.equal(view.result, null);
      assert.equal(view.calls.find((call) => call.callKey === slow.callKey)?.status, "skipped");
      assert.deepEqual(journalFor(view.runDir, slow.callKey).map((entry) => entry.status), ["skipped"]);
      // The launcher must actually have been cancelled: without this the test
      // would pass for a spawn that simply ignored the signal.
      await waitFor(() => fake.cancelled.length === 1, "the spawn request to be cancelled")
        .catch(() => undefined);
      assert.equal(fake.cancelled.length, 1, "the launcher must be cancelled, not ignored");
      assert.deepEqual(leaked, [], "a cancelled spawn rejection must not leak");
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("does not spawn at all when the run is cancelled before the call arrives", async (t) => {
    const fake = fakeService({ honourSignal: true });
    const manager = createManager(fake.service);
    const script = `export const meta = { name: 'pre-abort', description: 'x' }
return await agent('never', { label: 'never' });
`;
    const run = await manager.start({ source: script, args: {} });
    t.after(() => run.abort());
    const executing = run.execute();
    // Cancel before the VM has had a chance to issue the call.
    run.abort();
    const view = await executing;
    assert.equal(view.status, "aborted");
    assert.equal(fake.spawns.length, 0, "a cancelled run must not open a pane");
    assert.equal(view.calls.length, 0, "the call never reached the runtime");
  });

  it("keeps a sibling running when one call is cancelled", async (t) => {
    const fake = fakeService({ honourSignal: true, gated: ["slow"] });
    const manager = createManager(fake.service);
    const script = `export const meta = { name: 'cancel-sibling', description: 'x' }
return await parallel([
  () => agent('slow one', { label: 'slow' }),
  () => agent('quick one', { label: 'quick' }),
]);
`;
    const run = await manager.start({ source: script, args: {} });
    t.after(() => run.abort());
    const executing = run.execute();
    await waitFor(() => fake.gates.size === 1, "the gated spawn to be pending");
    const slow = run.view().calls.find((call) => call.label === "slow")!;
    run.skip(slow.callKey);

    const view = await executing;
    assert.equal(view.status, "completed", view.error);
    assert.deepEqual(view.result, [null, "echo:quick one"]);
  });
});

// ── the launcher seam: signal pass-through and abortable shell wait ────────

describe("subagent launch signal", () => {
  it("forwards the workflow request's signal to the launcher", async (t) => {
    const launched: Array<{ options?: { signal?: AbortSignal } }> = [];
    const surface = {
      launch: async (
        params: { name: string },
        _ctx: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        launched.push({ options });
        return {
          id: params.name,
          name: params.name,
          task: "",
          agent: "worker",
          surface: "%1",
          startTime: Date.now(),
          sessionFile: "/tmp/forward.jsonl",
          interactive: false,
          statusState: {},
        };
      },
      watch: async () => ({ exitCode: 0, summary: "ok", elapsedMs: 1 }),
      steer: async () => ({ ok: true as const }),
      resolveRunning: () => ({ error: "none" }),
      runningSubagents: new Map(),
      registerName: () => undefined,
      readNameRegistry: () => ({}),
      getArtifactDir: () => "/tmp",
      updateWidget: () => undefined,
      startWidgetRefresh: () => undefined,
      discoverAgents: () => [],
      isAgentAllowed: () => true,
      agentKind: () => "pi" as const,
      sessionSnapshot: () => ({ sessionFile: "/tmp/p.jsonl", sessionId: "p", sessionDir: "/tmp" }),
      sessionDefaults: () => ({}),
      agentDir: () => "/tmp",
      cwd: () => "/tmp",
      focus: async () => ({ ok: true as const }),
    };

    const controller = new AbortController();
    controller.abort();
    const service = createWorkflowSubagentService(surface as never);
    await service.spawn({
      agentType: "worker",
      name: "forwarded",
      task: "task",
      signal: controller.signal,
    });

    assert.equal(launched.length, 1);
    assert.equal(launched[0].options?.signal, controller.signal, "the launcher must receive the signal");
  });

  it("refuses an already-cancelled launch without waiting", async (t) => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await assert.rejects(waitForShellReady(300, controller.signal), SubagentLaunchCancelledError);
    assert.ok(Date.now() - started < 500, "a cancelled launch must not wait out the shell delay");
    assert.throws(() => throwIfLaunchCancelled(controller.signal), SubagentLaunchCancelledError);
    assert.doesNotThrow(() => throwIfLaunchCancelled(undefined));
  });

  it("stops waiting for the shell as soon as the launch is cancelled", async (t) => {
    const controller = new AbortController();
    const started = Date.now();
    const waiting = waitForShellReady(1_000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(waiting, SubagentLaunchCancelledError);
    assert.ok(Date.now() - started < 1_000, "the wait must end with the cancel, not with the timer");
  });

  it("resolves the shell wait when nothing cancels it", async (t) => {
    const controller = new AbortController();
    await waitForShellReady(10, controller.signal);
    await waitForShellReady(10, undefined);
    assert.equal(controller.signal.aborted, false);
  });
});
