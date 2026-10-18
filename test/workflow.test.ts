/**
 * Workflow runtime tests.
 *
 * These run the real QuickJS sandbox and the real manager, with a fake
 * subagent service in place of tmux/pi children. That covers everything the
 * runtime itself decides — scheduling, concurrency, journaling, resume,
 * structured results, limits — without spawning processes or calling a model.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkflowManager } from "../pi-extension/subagents/workflow/manager.ts";
import { parseScript, WorkflowScriptError } from "../pi-extension/subagents/workflow/script.ts";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
  WorkflowPanel,
  createPanelRenderState,
  panelActions,
  sameSelection,
  type WorkflowPanelOptions,
} from "../pi-extension/subagents/workflow/ui.ts";
import { WORKFLOW_GLOBALS } from "../pi-extension/subagents/workflow/runner.ts";
import type {
  WorkflowAgentResultMeta,
  WorkflowRunView,
  WorkflowSubagentCompletion,
  WorkflowSubagentHandle,
  WorkflowSubagentRequest,
  WorkflowSubagentService,
} from "../pi-extension/subagents/workflow/types.ts";

/** Records every spawn and answers with a configurable scripted result. */
class FakeSubagentService implements WorkflowSubagentService {
  readonly spawns: WorkflowSubagentRequest[] = [];
  readonly stopped: string[] = [];
  private inFlight = 0;
  peakConcurrency = 0;
  /** prompt substring → reply; everything else echoes the task. */
  replies = new Map<string, string>();
  delays = new Map<string, number>();
  failures = new Set<string>();
  structured = new Map<string, unknown>();
  structuredMissing = new Set<string>();
  /** Agent name → kind, for the definitions this fake pretends to have. */
  kinds = new Map<string, "pi" | "cli">();
  /** What the parent session is running, for children that inherit. */
  sessionModel: { model?: string; thinking?: string } = {};
  /** Tokens each spawned agent reports, for budget tests. */
  tokensPerAgent = 0;

  isAvailable() {
    return { ok: true as const };
  }

  /** The definitions this session can spawn, in discovery order. */
  allowed: string[] = ["worker", "scout"];

  allowedAgents() {
    return { allowed: [...this.allowed], unknown: (name: string) => !this.allowed.includes(name) };
  }

  /** Overridable per test; a `cli:` definition reports "cli". */
  agentKind(name: string): "pi" | "cli" | undefined {
    return this.kinds.get(name) ?? (this.allowed.includes(name) ? "pi" : undefined);
  }

  sessionDefaults(): { model?: string; thinking?: string } {
    return this.sessionModel;
  }

  takenNames() {
    return new Set(this.spawns.map((spawn) => spawn.name));
  }

  async spawn(request: WorkflowSubagentRequest): Promise<WorkflowSubagentHandle> {
    this.spawns.push(request);
    this.inFlight++;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.inFlight);
    const delay = this.delayFor(request.task);
    const completion = new Promise<WorkflowSubagentCompletion>((resolve) => {
      setTimeout(() => {
        this.inFlight--;
        const failed = [...this.failures].some((needle) => request.task.startsWith(needle) || request.task.includes(needle + "\n"));
        // The real runtime only writes a structured result when the child
        // actually called structured_output; this harness must mirror that
        // (including writing nothing), or it would mask contract errors.
        if (request.resultFile) {
          const matchesMissing = [...this.structuredMissing].some((needle) => request.task.includes(needle));
          if (matchesMissing || failed) {
            // No structured result written: the manager must report a contract error.
          } else {
            const value = [...this.structured.entries()].find(([needle]) => request.task.includes(needle))?.[1]
              ?? { echoed: request.task.slice(0, 40) };
            writeFileSync(request.resultFile, JSON.stringify({ ok: true, value }));
          }
        }
        resolve({
          exitCode: failed ? 1 : 0,
          summary: failed ? "" : this.replyFor(request.task),
          elapsedMs: delay,
          ...(failed ? { error: "synthetic failure" } : {}),
          ...(request.resultFile ? { structured: undefined } : {}),
          ...(this.tokensPerAgent
            ? { usage: { totalTokens: this.tokensPerAgent, outputTokens: this.tokensPerAgent, inputTokens: 0 } }
            : {}),
        });
      }, delay);
    });
    return {
      id: request.name,
      name: request.name,
      sessionFile: `/tmp/${request.name}.jsonl`,
      completion,
    };
  }

  async steer(name: string) {
    if (this.permitted(name)) return { ok: true as const };
    return { error: `no agent ${name}` };
  }

  stop(name: string) {
    this.stopped.push(name);
  }

  focus(name: string) {
    return this.permitted(name) ? ({ ok: true as const }) : { error: `no agent ${name}` };
  }

  status(name: string) {
    if (!this.permitted(name)) return undefined;
    return { kind: "active" as const, elapsedMs: 10, label: "read" };
  }

  private permitted(name: string) {
    return this.spawns.some((spawn) => spawn.name === name);
  }

  private delayFor(task: string): number {
    for (const [needle, delay] of this.delays) if (task.includes(needle)) return delay;
    return 5;
  }

  private replyFor(task: string): string {
    for (const [needle, reply] of this.replies) if (task.includes(needle)) return reply;
    return `echo:${task}`;
  }
}

const SCRIPT = `export const meta = { name: 'test-flow', description: 'test workflow', phases: ['Scan', 'Verify'] }
phase('Scan');
const scanned = await pipeline([1, 2, 3],
  async (item) => agent('scan-' + item, { label: 'scan-' + item }),
  async (previous, item) => agent('verify-' + item + ':' + previous, { label: 'verify-' + item }),
);
phase('Verify');
const final = await parallel([async () => agent('summary-a', { label: 'summary-a' }), async () => agent('summary-b', { label: 'summary-b' })]);
return { scanned, final };
`;

let baseDir: string;
let service: FakeSubagentService;
const caseDirs: string[] = [];

/**
 * Each test gets its own artifact directory. Runs share a directory in
 * production (that is how a workflow finds its own journal to replay), but
 * tests must not inherit one another's caches.
 */
const createManager = (overrides: Partial<ConstructorParameters<typeof WorkflowManager>[0]> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-case-"));
  caseDirs.push(dir);
  return new WorkflowManager({
    baseDir: dir,
    cwd: dir,
    sessionFile: join(dir, "session.jsonl"),
    sessionId: "test-session",
    agentDir: dir,
    service,
    ...overrides,
  });
};

before(() => {
  baseDir = mkdtempSync(join(tmpdir(), "wf-test-"));
});

after(() => {
  rmSync(baseDir, { recursive: true, force: true });
  for (const dir of caseDirs) rmSync(dir, { recursive: true, force: true });
});

describe("script parsing", () => {
  it("accepts a pure meta literal and rewrites the export", () => {
    const parsed = parseScript(SCRIPT, "inline");
    assert.equal(parsed.meta.name, "test-flow");
    assert.deepEqual(parsed.meta.phases, ["Scan", "Verify"]);
    assert.ok(parsed.body.includes("const meta = {"));
    assert.ok(!parsed.body.includes("export const meta"));
  });

  it("accepts single quotes, unquoted keys and trailing commas", () => {
    const parsed = parseScript(
      `export const meta = { name: 'x', description: 'y', phases: ['a',], }\nreturn 1;`,
      "inline",
    );
    assert.equal(parsed.meta.name, "x");
    assert.deepEqual(parsed.meta.phases, ["a"]);
  });

  it("rejects a computed meta, missing meta and bad slugs", () => {
    assert.throws(() => parseScript("return 1;", "inline"), WorkflowScriptError);
    assert.throws(
      () => parseScript("export const meta = buildMeta();\nreturn 1;", "inline"),
      WorkflowScriptError,
    );
    assert.throws(
      () => parseScript("export const meta = { name: 'has space', description: 'x' }\nreturn 1;", "inline"),
      WorkflowScriptError,
    );
    assert.throws(
      () => parseScript("export const meta = { name: 'x' }\nreturn 1;", "inline"),
      WorkflowScriptError,
    );
    assert.throws(
      () => parseScript(`export const meta = { name: \`t\${x}\`, description: 'y' }\nreturn 1;`, "inline"),
      WorkflowScriptError,
    );
  });
});

describe("workflow run", () => {
  it("runs a multi-stage script and journals every call", async () => {
    service = new FakeSubagentService();
    service.delays.set("scan-1", 60);
    service.delays.set("scan-2", 5);
    const manager = createManager();

    const run = await manager.start({ source: SCRIPT, args: { changes: "diff" } });
    const view = await run.execute();

    assert.equal(view.status, "completed", view.error);
    assert.equal(view.totalCount, 8);
    assert.equal(view.completedCount, 8);
    assert.equal(view.failedCount, 0);
    assert.equal(view.progress, 1);
    assert.equal(view.phase, "Verify");
    assert.ok(service.peakConcurrency > 1, "pipeline stages should overlap across items");
    assert.ok(service.peakConcurrency <= view.maxConcurrent, "concurrency must respect the limit");

    const journal = readFileSync(join(view.runDir, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(journal.length, 8);
    assert.ok(journal.every((entry) => entry.type === "call" && entry.status === "completed"));
    assert.ok(journal.every((entry) => typeof entry.callKey === "string" && entry.callKey.length > 10));

    // Results reach the script in input order even though completions interleave.
    const result = view.result as { scanned: string[] };
    assert.deepEqual(result.scanned, [
      "echo:verify-1:echo:scan-1",
      "echo:verify-2:echo:scan-2",
      "echo:verify-3:echo:scan-3",
    ]);

    const stats = JSON.parse(readFileSync(join(view.runDir, "snapshot.json"), "utf8"));
    assert.equal(stats.status, "completed");
    assert.equal(stats.agentCount, 8);
  });

  it("replays a completed run from the journal without spawning agents", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const first = await manager.start({ source: SCRIPT, args: { changes: "diff" } });
    const firstView = await first.execute();
    const spawnsAfterFirst = service.spawns.length;

    const resumed = await manager.resume(firstView.runId);
    const resumedView = await resumed.execute();

    assert.equal(service.spawns.length, spawnsAfterFirst, "resume must not re-run completed calls");
    assert.equal(resumedView.status, "completed");
    assert.deepEqual(resumedView.result, firstView.result);
    assert.ok(resumedView.calls.every((call) => call.cached), "replayed calls are marked cached");
  });

  it("measures elapsed from this execution, not from the original run", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const first = await manager.start({ source: SCRIPT, args: { changes: "diff" } });
    const firstView = await first.execute();

    // A resumed run replays the original run's VM clock (that is what makes the
    // script's time-based output stable), so elapsed time must come from the
    // execution, not from the snapshot — otherwise the panel would report the
    // age of the run directory instead of how long this run took.
    const before = Date.now();
    const resumed = await manager.resume(firstView.runId);
    const view = resumed.view();
    assert.ok(
      view.startedAtWall >= before,
      `startedAtWall (${view.startedAtWall}) must be from this execution, not the original run (${firstView.startedAtWall})`,
    );

    const done = await resumed.execute();
    assert.ok(done.finishedAt && done.finishedAt >= done.startedAtWall, "a settled run freezes at its finish");
  });

  it("does not replay a previous run's answers when the args changed", async () => {
    // The cache key does not include args, so a re-run with new inputs used to
    // be answered from the previous run — the opposite of the independent
    // sample the caller asked for.
    service = new FakeSubagentService();
    const manager = createManager();
    const script = `export const meta = { name: 'arg-sensitive', description: 'x', agent: 'worker' }
return await agent('scan', { label: 'scan' });
`;
    const first = await (await manager.start({ source: script, args: { target: "a" } })).execute();
    assert.equal(first.status, "completed", first.error);
    const afterFirst = service.spawns.length;

    const sameArgs = await (await manager.start({ source: script, args: { target: "a" } })).execute();
    assert.equal(service.spawns.length, afterFirst, "the same args still reuse completed calls");
    assert.equal(sameArgs.resumedFrom, first.runId);

    const newArgs = await (await manager.start({ source: script, args: { target: "b" } })).execute();
    assert.equal(service.spawns.length, afterFirst + 1, "different args must run for real");
    assert.equal(newArgs.resumedFrom, undefined);

    const forced = await (await manager.start({ source: script, args: { target: "a" }, reuse: "none" })).execute();
    assert.equal(service.spawns.length, afterFirst + 2, "reuse: 'none' shares nothing");
    assert.equal(forced.resumedFrom, undefined);
  });

  it("resumes from an edited script and keeps the edit", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const script = (extra: string) => `export const meta = { name: 'editable', description: 'x', agent: 'worker' }
const one = await agent('scan-1', { label: 'one' });
${extra}
return one;
`;
    const first = await (await manager.start({ source: script(""), args: {} })).execute();
    assert.equal(first.status, "completed", first.error);
    const afterFirst = service.spawns.length;

    const resumed = await (
      await manager.resume(first.runId, { source: script("const two = await agent('scan-2', { label: 'two' });") })
    ).execute();
    assert.equal(resumed.status, "completed", resumed.error);
    assert.equal(service.spawns.length, afterFirst + 1, "only the added call runs");
    assert.equal(resumed.totalCount, 2, "the journaled call is still part of the run");

    // The edit is persisted, so a second resume does not lose it.
    const again = await (await manager.resume(first.runId)).execute();
    assert.equal(again.status, "completed", again.error);
    assert.equal(again.totalCount, 2);
    assert.equal(service.spawns.length, afterFirst + 1, "and nothing runs a second time");
  });

  it("re-runs only the calls whose content changed", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const first = await manager.start({ source: SCRIPT, args: {} });
    const firstView = await first.execute();
    const expectedReruns = 1; // only the edited call

    const edited = SCRIPT.replace("agent('summary-a'", "agent('summary-a-edited'");
    const rerunCount = service.spawns.length;
    const second = await manager.start({ source: edited, args: {} });
    const secondView = await second.execute();

    const newSpawns = service.spawns.slice(rerunCount);
    assert.equal(secondView.status, "completed");
    assert.equal(
      service.spawns.length - rerunCount,
      expectedReruns,
      `expected only the edited call to re-run, saw ${newSpawns.map((s) => s.task).join(", ")}`,
    );
    assert.match(newSpawns[0].task, /summary-a-edited/);
    assert.ok(firstView.runId !== secondView.runId);
  });

  it("turns a failed agent into null for the script and records the failure", async () => {
    service = new FakeSubagentService();
    service.failures.add("scan-2");
    service.failures.add("scan-3");
    const manager = createManager();
    const script = `export const meta = { name: 'failure-flow', description: 'x' }
const results = await parallel([async () => agent('scan-1', { label: 'a' }), async () => agent('scan-2', { label: 'b' })]);
// A dead agent resolves to null on the bare-await path too, the way it does
// inside parallel: one death must not discard the results of everything else.
const direct = await agent('scan-3', { label: 'c' });
return { results, direct };
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();

    assert.equal(view.status, "completed");
    const result = view.result as { results: unknown[]; direct: unknown };
    assert.equal(result.results[0], "echo:scan-1");
    assert.equal(result.results[1], null);
    assert.equal(result.direct, null);
    // Still recorded, still visible: null is the script's view, not a cover-up.
    assert.equal(view.failedCount, 2);
    const failed = view.calls.filter((call) => call.status === "failed");
    assert.equal(failed.length, 2);
    assert.match(String(failed[0].error), /synthetic failure/);
    assert.ok(view.logs.some((line) => line.includes("resolved to null")), "the run says so in its notes");
  });

  it("uses a structured result when the schema path is configured", async () => {
    service = new FakeSubagentService();
    service.structured.set("analyse", { verdict: "real", confidence: 0.9 });
    const manager = createManager();
    const script = `export const meta = { name: 'schema-flow', description: 'x' }
const out = await agent('analyse this', { label: 'analyse', schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] } });
return out;
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();

    assert.equal(view.status, "completed", view.error);
    assert.deepEqual(view.result, { verdict: "real", confidence: 0.9 });
    const spawn = service.spawns.find((entry) => entry.task.includes("analyse"));
    assert.ok(spawn?.schemaFile, "a schema file must be handed to the child");
    assert.ok(spawn?.resultFile, "a result sidecar must be handed to the child");
    // Extra extensions are the sandbox's business (wiring.ts adds the
    // structured-output extension); a harness that omits them still exercises
    // the schema protocol, so only the sidecar paths are asserted here.
  });

  it("fails the call when a schema-driven agent returns no structured output", async () => {
    service = new FakeSubagentService();
    service.structuredMissing.add("analyse");
    const manager = createManager();
    const script = `export const meta = { name: 'schema-missing', description: 'x' }
const out = await agent('analyse missing', { label: 'analyse', schema: { type: 'object', properties: {} } });
return out === null ? 'no-value' : out;
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();

    assert.equal(view.result, "no-value", "a missing structured result resolves to null");
    assert.equal(view.failedCount, 1);
    // The reason is recorded, so a null is never unexplained.
    assert.match(String(view.calls[0].error), /structured_output/);
  });

  it("skips a call on request and lets the script continue with null", async () => {
    service = new FakeSubagentService();
    service.delays.set("slow", 200);
    const manager = createManager();
    const script = `export const meta = { name: 'skip-flow', description: 'x' }
const fast = await agent('fast', { label: 'fast' });
const slow = await agent('slow', { label: 'slow' });
return { fast, slow };
`;
    const run = await manager.start({ source: script, args: {} });
    const execution = run.execute();

    // Wait for the slow call to be registered (its agent is still running).
    let slowCall = run.view().calls.find((call) => call.label === "slow");
    for (let attempt = 0; attempt < 100 && !slowCall; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      slowCall = run.view().calls.find((call) => call.label === "slow");
    }
    assert.ok(slowCall, "the slow call should be tracked");
    assert.equal(run.skip(slowCall!.callKey), true);

    const view = await execution;
    assert.equal(view.status, "completed");
    const result = view.result as { slow: unknown };
    assert.equal(result.slow, null);
    assert.ok(view.calls.some((call) => call.status === "skipped"));
    // A skip is a decision for this run only: the journal records it, but a
    // resume retries the call rather than replaying it as null.
    const resumed = await manager.resume(view.runId);
    const resumedView = await resumed.execute();
    assert.equal(resumedView.status, "completed", resumedView.error);
    assert.equal((resumedView.result as { slow: unknown }).slow, "echo:slow");
    assert.ok(
      resumedView.calls.every((call) => call.status === "completed"),
      "the retried call must end up completed, not skipped",
    );
  });

  it("aborts a run, stops its agents and marks the run aborted", async () => {
    service = new FakeSubagentService();
    service.delays.set("slow", 500);
    const manager = createManager();
    const script = `export const meta = { name: 'abort-flow', description: 'x' }
await parallel([async () => agent('slow-1', { label: 'a' }), async () => agent('slow-2', { label: 'b' })]);
return 'never';
`;
    const run = await manager.start({ source: script, args: {} });
    const execution = run.execute();
    await new Promise((resolve) => setTimeout(resolve, 60));
    run.abort("test abort");

    const view = await execution;
    assert.equal(view.status, "aborted");
    assert.match(String(view.error), /test abort/);
    assert.ok(service.stopped.length >= 1, "running agents must be stopped");
  });

  it("reports a status view without executing", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const run = await manager.start({ source: SCRIPT, args: {} });
    const view = await run.execute();
    const inspected = manager.inspect(view.runId);
    assert.equal(inspected?.meta.name, "test-flow");
    assert.equal(inspected?.status, "completed");
    assert.equal(inspected?.calls.length, 8);
    assert.equal(manager.inspect("wf-nonexistent"), null);
  });

  it("refuses resume while the run is still live", async () => {
    service = new FakeSubagentService();
    service.delays.set("slow", 300);
    const manager = createManager();
    const script = `export const meta = { name: 'live-flow', description: 'x' }
await agent('slow', { label: 'a' });
return 'done';
`;
    const run = await manager.start({ source: script, args: {} });
    const execution = run.execute();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await assert.rejects(() => manager.resume(run.runId), /still running/);
    run.abort("cleanup");
    await execution;
  });

  it("rejects an unknown agent type before scheduling", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const script = `export const meta = { name: 'bad-agent', description: 'x' }
try {
  await agent('x', { label: 'x', agent: 'nope' });
  return 'no-error';
} catch (error) {
  return 'error:' + error.message;
}
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();
    assert.match(String(view.result), /unknown agent "nope"/);
  });

  it("enforces the per-run agent cap", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const script = `export const meta = { name: 'cap-flow', description: 'x' }
for (let i = 0; i < 1200; i++) await agent('call-' + i, { label: 'c' + i });
return 'done';
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();
    assert.equal(view.status, "failed");
    assert.match(String(view.error), /1000 agents|no progress|exceeded/i);
  });

  it("kills a script that never yields", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const script = `export const meta = { name: 'spin-flow', description: 'x' }
while (true) {}
`;
    // A tiny deadline keeps the test fast; the mechanism is what matters.
    const run = await manager.start({ source: script, args: {}, budgetTotal: 0 });
    run.setScriptTimeout(1_500);
    const started = Date.now();
    const view = await run.execute();
    assert.equal(view.status, "failed");
    assert.ok(Date.now() - started < 30_000, "a spinning script must be interrupted");
    assert.match(String(view.error), /progress|timed out|abort/i);
  });

  it("exposes args and a live token budget to the script", async () => {
    service = new FakeSubagentService();
    const manager = createManager({ budgetTotal: 10_000 });
    const script = `export const meta = { name: 'budget-flow', description: 'x' }
const before = await budget.spent();
await agent('scan-1', { label: 'a' });
return { args, before, total: budget.total };
`;
    const run = await manager.start({ source: script, args: { task: "t" } });
    const view = await run.execute();
    assert.equal(view.status, "completed", view.error);
    const result = view.result as { args: { task: string }; before: number; total: number };
    assert.equal(result.args.task, "t");
    assert.equal(result.before, 0);
    assert.equal(result.total, 10_000);
    assert.equal(view.budgetTotal, 10_000);
  });

  it("forwards model and effort as separate fields", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const script = `export const meta = { name: 'effort-flow', description: 'x', agent: 'worker' }
await agent('with-both', { label: 'both', model: 'openrouter/z-ai/glm-5.3', effort: 'high' });
await agent('model-only', { label: 'model' , model: 'openrouter/z-ai/glm-5.3' });
await agent('effort-only', { label: 'effort', effort: 'low' });
return 'ok';
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();
    assert.equal(view.status, "completed", view.error);

    const spawnFor = (needle: string) => service.spawns.find((spawn) => spawn.task.includes(needle));
    assert.equal(spawnFor("with-both")?.model, "openrouter/z-ai/glm-5.3");
    assert.equal(spawnFor("with-both")?.effort, "high");
    assert.equal(spawnFor("model-only")?.model, "openrouter/z-ai/glm-5.3");
    assert.equal(spawnFor("model-only")?.effort, undefined);
    // Effort on its own is a real request — it lowers the model the definition
    // pins. It used to be dropped in silence.
    assert.equal(spawnFor("effort-only")?.model, undefined);
    assert.equal(spawnFor("effort-only")?.effort, "low");
  });

  it("keeps effort and model in the call key, so a bumped stage re-runs", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const script = (effort: string) => `export const meta = { name: 'key-effort', description: 'x', agent: 'worker' }
await agent('judge', { label: 'judge', effort: '${effort}' });
return 'ok';
`;
    const first = await (await manager.start({ source: script("low"), args: {} })).execute();
    assert.equal(first.status, "completed", first.error);
    const spawnsAfterFirst = service.spawns.length;

    // Same prompt and label, higher effort: a different call, so it must run.
    const second = await (await manager.start({ source: script("max"), args: {} })).execute();
    assert.equal(second.status, "completed", second.error);
    assert.equal(service.spawns.length, spawnsAfterFirst + 1, "raising effort must not replay the cheap answer");
  });

  it("keeps identical calls apart instead of collapsing them into one", async () => {
    // Three identical refuters are three samples. Keyed by content alone they
    // shared one key, so the journal replayed one answer for all three and a
    // plausible-but-wrong finding passed a "3 of 3" check.
    service = new FakeSubagentService();
    const manager = createManager();
    const script = `export const meta = { name: 'identical-calls', description: 'x', agent: 'worker' }
const votes = await parallel([0, 1, 2].map(() => async () => agent('refute this', { label: 'refuter' })));
return votes.length;
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();

    assert.equal(view.status, "completed", view.error);
    assert.equal(service.spawns.length, 3, "all three refuters must actually run");
    assert.equal(view.totalCount, 3, "and each is its own row");
  });

  it("counts the lifetime agent cap on launches, not on distinct calls", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    // The same call issued over and over reuses one key; counting keys would
    // never trip the backstop the cap exists to be.
    const script = `export const meta = { name: 'runaway', description: 'x', agent: 'worker' }
for (let i = 0; i < 1200; i++) { await agent('spin', { label: 'spin' }) }
return 'done';
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();

    assert.equal(view.status, "failed");
    assert.match(String(view.error), /exceeded 1000 agents/);
    assert.ok(service.spawns.length <= 1001, `the cap must stop the loop, saw ${service.spawns.length} spawns`);
  });

  it("rejects an effort level pi would not understand", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const script = `export const meta = { name: 'bad-effort', description: 'x', agent: 'worker' }
await agent('nope', { effort: 'very-high' });
return 'unreachable';
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();
    assert.equal(view.status, "failed");
    assert.match(String(view.error), /expected one of off, minimal, low, medium, high, xhigh, max/);
    assert.equal(service.spawns.length, 0, "an invalid effort must be refused before any agent starts");
  });

  it("accepts agent() called with a single options object", async () => {
    // `agent(prompt, opts)` is the documented form, but the object form reads
    // naturally; before this, it failed inside the host with "agent() requires a
    // prompt string", and inside parallel() that surfaced as a silent null.
    service = new FakeSubagentService();
    const manager = createManager();
    const run = await manager.start({
      source:
        "export const meta = { name: 'obj-args', description: 'x' }\n" +
        "const results = await parallel([\n" +
        "  () => agent({ prompt: 'one', label: 'first', agent: 'scout' }),\n" +
        "  () => agent('two', { label: 'second', agent: 'scout' }),\n" +
        "])\n" +
        "return results",
      args: {},
    });
    const view = await run.execute();

    assert.equal(service.spawns.length, 2, "both forms spawn an agent");
    assert.deepEqual(view.calls.map((call) => call.status), ["completed", "completed"]);
    assert.equal(view.calls[0].label, "first", "the object form's opts are honoured");
  });

  it("accepts Claude Code's meta.phases object form", async () => {
    // A script written for Claude Code carries `phases: [{ title, detail }]`.
    // Requiring bare strings rejected it with a message that only said "array
    // of strings", and the obvious fix for the author was to delete the phases.
    const parsed = parseScript(
      "export const meta = { name: 'cc-shaped', description: 'x', " +
        "whenToUse: 'when you want a sweep', phases: [{ title: 'Scan', detail: 'find' }, 'Verify'] }\nreturn 1;",
      "inline",
    );
    assert.equal(parsed.meta.whenToUse, "when you want a sweep");
    assert.deepEqual(parsed.meta.phases, [{ title: "Scan", detail: "find" }, "Verify"]);
    assert.throws(
      () => parseScript("export const meta = { name: 'x', description: 'y', phases: [{ detail: 'no title' }] }\nreturn 1;", "inline"),
      WorkflowScriptError,
    );
  });

  it("accepts agentType as a name for agent, and refuses both at once", async () => {
    service = new FakeSubagentService();
    service.kinds.set("cli-agent", "cli");
    const manager = createManager();
    const script = `export const meta = { name: 'agenttype', description: 'x' }
await agent('one', { label: 'one', agentType: 'scout' });
return 'ok';
`;
    const view = await (await manager.start({ source: script, args: {} })).execute();
    assert.equal(view.status, "completed", view.error);
    assert.equal(service.spawns[0].agentType, "scout", "agentType must not be dropped in silence");

    const conflict = `export const meta = { name: 'agenttype-conflict', description: 'x' }
await agent('one', { agent: 'scout', agentType: 'worker' });
return 'ok';
`;
    const failed = await (await manager.start({ source: conflict, args: {} })).execute();
    assert.equal(failed.status, "failed");
    assert.match(String(failed.error), /both agent "scout" and agentType "worker"/);
  });

  it("refuses an option it does not understand instead of dropping it", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const script = `export const meta = { name: 'typo-opts', description: 'x' }
await agent('one', { label: 'one', schemas: { type: 'object' } });
return 'ok';
`;
    const view = await (await manager.start({ source: script, args: {} })).execute();
    assert.equal(view.status, "failed");
    assert.match(String(view.error), /unknown option `schemas`/);
    assert.equal(service.spawns.length, 0, "a typo must not reach the scheduler");
  });

  it("names worktree isolation as unsupported rather than ignoring it", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const script = `export const meta = { name: 'isolation', description: 'x' }
await agent('one', { label: 'one', isolation: 'worktree' });
return 'ok';
`;
    const view = await (await manager.start({ source: script, args: {} })).execute();
    assert.equal(view.status, "failed");
    assert.match(String(view.error), /isolation.*not implemented/);
  });

  it("rejects an unsatisfiable schema before spending a model call", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const script = `export const meta = { name: 'bad-schema', description: 'x' }
await agent('one', { label: 'one', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] } });
return 'ok';
`;
    const view = await (await manager.start({ source: script, args: {} })).execute();
    assert.equal(view.status, "failed");
    assert.match(String(view.error), /requires `b`.*not in `properties`/);
    assert.equal(service.spawns.length, 0);

    const notAnObject = `export const meta = { name: 'bad-schema-2', description: 'x' }
await agent('one', { label: 'one', schema: { type: 'string' } });
return 'ok';
`;
    const second = await (await manager.start({ source: notAnObject, args: {} })).execute();
    assert.equal(second.status, "failed");
    assert.match(String(second.error), /type: 'object'/);
  });

  it("refuses a schema on an external-CLI agent, which cannot return one", async () => {
    service = new FakeSubagentService();
    service.allowed = ["claude-cli", "worker"];
    service.kinds.set("claude-cli", "cli");
    const manager = createManager();
    const script = `export const meta = { name: 'cli-schema', description: 'x' }
await agent('one', { label: 'one', agent: 'claude-cli', schema: { type: 'object', properties: {} } });
return 'ok';
`;
    const view = await (await manager.start({ source: script, args: {} })).execute();
    assert.equal(view.status, "failed");
    assert.match(String(view.error), /external CLI/);
    assert.equal(service.spawns.length, 0, "the failure must be ours, not the child's");
  });

  it("does not default an anonymous call to an external-CLI agent", async () => {
    // `claude-cli` sorts first in the bundled agents directory, so "the first
    // allowed agent" used to mean an Anthropic CLI pane for every call that
    // named none — the one backend this plugin does not run on.
    service = new FakeSubagentService();
    service.allowed = ["claude-cli", "worker"];
    service.kinds.set("claude-cli", "cli");
    const manager = createManager();
    const script = `export const meta = { name: 'anon-agent', description: 'x' }
await agent('one', { label: 'one' });
return 'ok';
`;
    const view = await (await manager.start({ source: script, args: {} })).execute();
    assert.equal(view.status, "completed", view.error);
    assert.equal(service.spawns[0].agentType, "worker", "the first non-CLI agent, not the CLI one");
  });

  it("stops a run that ignores its token budget", async () => {
    service = new FakeSubagentService();
    service.tokensPerAgent = 40;
    const manager = createManager({ budgetTotal: 100 });
    // Five calls at 40 tokens against a 100-token ceiling. The ceiling is
    // checked before a call is queued, so the call that crosses it runs and the
    // next one is refused — and refused fatally, because a script that ignores
    // `remaining()` would otherwise swallow the rejection through parallel()
    // and keep going until the wall clock.
    const script = `export const meta = { name: 'budgeted', description: 'x', agent: 'worker' }
for (let i = 0; i < 5; i++) { await agent('spin', { label: 'spin' + i }) }
return 'finished';
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();

    assert.equal(view.status, "failed");
    assert.match(String(view.error), /budget exhausted/);
    assert.ok(service.spawns.length < 5, `the ceiling must stop the loop, saw ${service.spawns.length}`);
  });

  it("lets a script that scales to budget.remaining() stop on its own", async () => {
    service = new FakeSubagentService();
    service.tokensPerAgent = 40;
    const manager = createManager({ budgetTotal: 100 });
    const script = `export const meta = { name: 'budget-aware', description: 'x', agent: 'worker' }
let runs = 0;
while (budget.total && budget.remaining() > 0) {
  await agent('spin', { label: 'spin' + runs });
  runs++;
  if (runs > 10) break;
}
return runs;
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();

    assert.equal(view.status, "completed", view.error);
    assert.equal(service.spawns.length, 3, "it stops when the budget says to, not when the run dies");
  });

  it("reports budget.spent() as a number the script can compare", async () => {
    service = new FakeSubagentService();
    service.tokensPerAgent = 10;
    const manager = createManager({ budgetTotal: 1000 });
    const script = `export const meta = { name: 'budget-types', description: 'x', agent: 'worker' }
await agent('one', { label: 'one' });
return { spent: budget.spent(), remaining: budget.remaining(), total: budget.total };
`;
    const view = await (await manager.start({ source: script, args: {} })).execute();
    const result = view.result as { spent: number; remaining: number; total: number };
    assert.equal(typeof result.spent, "number");
    assert.equal(typeof result.remaining, "number");
    assert.equal(result.spent, 10, "the value is fresh as of the last settled call");
    assert.equal(result.remaining, 990);
    assert.equal(result.total, 1000);
  });

  it("rejects a parallel/pipeline batch over the item limit", async () => {
    service = new FakeSubagentService();
    const manager = createManager();
    const script = `export const meta = { name: 'batch-flow', description: 'x' }
const items = [];
for (let i = 0; i < 4097; i++) items.push(i);
await parallel(items.map((i) => async () => agent('item-' + i, { label: 'i' + i })));
return 'unreachable';
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();
    assert.equal(view.status, "failed");
    assert.match(String(view.error), /at most 4096 items/);
    assert.equal(service.spawns.length, 0, "an oversized batch must be refused before any agent starts");
  });
});

describe("observability", () => {
  /** The panel needs a theme; the tests only care about the text it emits. */
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  const call = (overrides: Partial<WorkflowAgentResultMeta> = {}): WorkflowAgentResultMeta => ({
    callKey: "key-1",
    label: "review:panel-ui",
    status: "completed",
    agentType: "scout",
    durationMs: 60_000,
    ...overrides,
  });

  const run = (overrides: Partial<WorkflowRunView> = {}): WorkflowRunView =>
    ({
      runId: "wf-1",
      meta: { name: "review-changes", description: "x" },
      status: "running",
      createdAt: 0,
      updatedAt: 0,
      startedAtWall: Date.now() - 5_000,
      agentCount: 4,
      activeCount: 2,
      completedCount: 2,
      failedCount: 1,
      totalCount: 4,
      maxConcurrent: 6,
      progress: 0.5,
      usage: { totalTokens: 1234 },
      scriptPath: "/tmp/script.js",
      runDir: "/tmp/run",
      sessionFile: "/tmp/session.jsonl",
      cwd: "/tmp",
      calls: [],
      logs: [],
      ...overrides,
    }) as WorkflowRunView;

  const liveness = (views: WorkflowRunView[]) => (runId: string) =>
    views.some((view) => view.runId === runId && view.status === "running");

  const panelFor = (views: WorkflowRunView[], overrides: Partial<WorkflowPanelOptions> = {}) =>
    new WorkflowPanel({
      callbacks: {
        steer: () => {},
        focus: () => ({ ok: true as const }),
        stop: () => {},
        skip: () => {},
        abort: () => {},
        resume: () => {},
      },
      views: () => views,
      isLive: liveness(views),
      notify: () => {},
      prompt: async () => undefined,
      confirm: async () => false,
      ...overrides,
    });

  const render = (
    views: WorkflowRunView[],
    state = createPanelRenderState(),
    height = Number.POSITIVE_INFINITY,
  ) => panelFor(views).renderPanel(theme, 100, state, height);

  it("renders a run header with status, progress and counts", () => {
    const body = render([
      run({
        phase: "Verify",
        calls: [
          call({ callKey: "c1", label: "one", status: "completed" }),
          call({ callKey: "c2", label: "two", status: "completed" }),
          call({ callKey: "c3", label: "three", status: "failed", error: "boom" }),
          call({ callKey: "c4", label: "four", status: "running", name: "four" }),
        ],
        completedCount: 2,
        failedCount: 1,
        activeCount: 1,
        totalCount: 4,
      }),
    ]).join("\n");
    assert.match(body, /review-changes/);
    assert.match(body, /running · \d+s/);
    assert.match(body, /3\/4 agents · 1\.2k tokens/);
    assert.match(body, /1 failed/);
    assert.match(body, /▰+▱+ 50%/);
    assert.doesNotMatch(body, /wf-1/, "the header must not show the run id");
    // `view.phase` is the *last* phase() call, so it contradicts the rows while
    // earlier phases are still running; the per-call groups carry phase instead.
    assert.doesNotMatch(body, /running · Verify/);
  });

  it("groups the rows by phase and shows the run's own notes", () => {
    const view = run({
      calls: [
        call({ callKey: "s1", label: "scan-one", phase: "Scan", status: "running", name: "scan-one" }),
        call({ callKey: "s2", label: "scan-two", phase: "Scan", status: "running", name: "scan-two" }),
        call({ callKey: "v1", label: "verify-one", phase: "Verify", status: "queued" }),
      ],
      logs: ["reusing 3 completed call(s) from run wf-9", "halfway"],
      logsDropped: 4,
    });
    const lines = render([view]);
    const body = lines.join("\n");
    assert.match(body, /Scan/, "the phase appears once as a group header");
    assert.equal(lines.filter((line) => line.trim() === "Scan").length, 1, "identical phases merge into one group");
    assert.match(body, /Verify/);
    assert.ok(
      lines.findIndex((line) => line.includes("Scan")) < lines.findIndex((line) => line.includes("scan-one")),
      "the group header precedes its rows",
    );
    assert.match(body, /reusing 3 completed call/, "the run's notes are visible");
    assert.match(body, /4 earlier notes dropped/, "a trimmed log says so");
  });

  it("keeps every line inside the width it is given", () => {
    const calls = [
      call({ callKey: "a", label: "a-very-long-agent-label-that-keeps-going", status: "running", name: "wf-a", live: { kind: "active", detail: "Reading pi-extension/subagents/workflow/manager.ts and thinking about it" } }),
      call({ callKey: "b", label: "b", status: "failed", error: "exited with code 1: the model returned nothing useful at all" }),
    ];
    const view = run({ calls, meta: { name: "a-run-with-a-long-name-of-its-own", description: "x" } });
    for (const width of [40, 80, 100]) {
      for (const line of panelFor([view]).renderPanel(theme, width, createPanelRenderState())) {
        assert.ok(visibleWidth(line) <= width, `line wider than ${width}: ${JSON.stringify(line)}`);
      }
    }
  });

  it("says so when the session has no runs", () => {
    const body = render([]).join("\n");
    assert.match(body, /No workflow runs in this session\./);
    assert.match(body, /q close/);
  });

  it("freezes a settled run's elapsed time instead of tracking the wall clock", () => {
    // The run finished in seconds; the pane stayed open for hours. Measuring
    // against the current clock here used to report the pane's age (7h44m)
    // as if it were the run's duration.
    const startedAtWall = Date.now() - 7 * 60 * 60 * 1000;
    const body = render([
      run({
        status: "completed",
        phase: undefined,
        progress: 1,
        completedCount: 2,
        failedCount: 0,
        startedAtWall,
        finishedAt: startedAtWall + 18_800,
      }),
    ]).join("\n");
    assert.match(body, /18s/);
    assert.doesNotMatch(body, /7h/, "a finished run must not report the pane's age");
  });

  it("shows one run at a time and switches between them", () => {
    const first = run({ runId: "wf-1", calls: [call({ callKey: "a", label: "first-run-agent" })] });
    // Settled and older: the live run is the one on screen to begin with.
    const second = run({
      runId: "wf-2",
      status: "completed",
      createdAt: 0,
      finishedAt: Date.now(),
      meta: { name: "second-run", description: "y" },
      calls: [call({ callKey: "b", label: "second-run-agent" })],
    });

    const state = createPanelRenderState();
    const body = panelFor([first, second]).renderPanel(theme, 100, state).join("\n");
    assert.match(body, /first-run-agent/);
    assert.doesNotMatch(body, /second-run-agent/, "only one run's agents are listed");
    assert.match(body, /1\/2/, "the header says where in the run list this is");

    state.runId = "wf-2";
    const switched = panelFor([first, second]).renderPanel(theme, 100, state).join("\n");
    assert.match(switched, /second-run/);
    assert.match(switched, /second-run-agent/);
    assert.doesNotMatch(switched, /first-run-agent/);
  });

  it("windows a long list to the height and keeps the cursor visible", () => {
    const calls = Array.from({ length: 40 }, (_, index) =>
      call({ callKey: `key-${index}`, label: `agent-${index}`, status: "running", name: `agent-${index}` }),
    );
    const long = run({ calls, totalCount: 40, activeCount: 40, completedCount: 0, failedCount: 0, progress: 0 });
    const state = createPanelRenderState();
    state.selection = { kind: "call", callKey: "key-30" };

    const lines = panelFor([long]).renderPanel(theme, 100, state, 12);
    assert.ok(lines.length <= 12, `the panel must fit the height, got ${lines.length} lines`);
    assert.match(lines.join("\n"), /agent-30/, "the cursor's row stays visible");
    assert.match(lines.join("\n"), /\(\d+\/4\d\)/, "a windowed list reports its position");

    // Paging to the top shows the first rows, not a stale window.
    state.selection = { kind: "call", callKey: "key-0" };
    const top = panelFor([long]).renderPanel(theme, 100, state, 12);
    assert.match(top.join("\n"), /agent-0/);
    assert.ok(top.length <= 12);
  });

  it("keeps the cursor on the same call when rows appear above it", () => {
    const state = createPanelRenderState();
    state.selection = { kind: "call", callKey: "a" };
    const grown = run({
      calls: [
        call({ callKey: "b", label: "zeroth", status: "running", name: "zeroth" }),
        call({ callKey: "a", label: "first" }),
      ],
    });
    const body = panelFor([grown]).renderPanel(theme, 100, state, Number.POSITIVE_INFINITY).join("\n");
    assert.ok(sameSelection(state.selection, { kind: "call", callKey: "a" }), "selection is by identity");
    assert.match(body, /❯ ✓ first/, "the pointer stays on the same call");
  });

  it("offers only the actions that apply to the selected row", () => {
    const ids = (selection: any, views: WorkflowRunView[]) =>
      panelActions(selection, views, liveness(views)).map((action) => action.id);

    const queued = run({ calls: [call({ callKey: "q", status: "queued", name: undefined })] });
    assert.deepEqual(ids({ kind: "call", callKey: "q" }, [queued]), ["skip"]);

    const running = run({ calls: [call({ callKey: "r", status: "running", name: "wf-run" })] });
    assert.deepEqual(ids({ kind: "call", callKey: "r" }, [running]), ["focus", "steer", "stop", "skip"]);

    const done = run({ status: "completed", calls: [call({ callKey: "d", name: "wf-done" })] });
    assert.deepEqual(ids({ kind: "call", callKey: "d" }, [done]), ["focus", "steer"]);

    assert.deepEqual(ids({ kind: "run", runId: "wf-1" }, [running]), ["abort"]);
    assert.deepEqual(ids({ kind: "run", runId: "wf-1" }, [done]), ["resume"]);
  });

  it("renders an open action menu under its row", () => {
    const view = run({ calls: [call({ callKey: "k", status: "running", name: "wf-agent" })] });
    const state = createPanelRenderState();
    state.selection = { kind: "call", callKey: "k" };
    state.menu = {
      selection: state.selection,
      actions: panelActions(state.selection, [view], liveness([view])),
      index: 1,
    };
    const body = panelFor([view]).renderPanel(theme, 100, state, Number.POSITIVE_INFINITY).join("\n");
    assert.match(body, /❯ message/, "the highlighted action is marked");
    assert.match(body, /esc cancel/, "the footer switches to the menu's keys");
  });

  it("drives the selected row through its action menu", async () => {
    const view = run({ calls: [call({ callKey: "k1", status: "running", name: "wf-agent", label: "agent:one" })] });
    const focused: string[] = [];
    const skipped: string[] = [];
    const panel = panelFor([view], {
      callbacks: {
        steer: () => {},
        focus: (name) => {
          focused.push(name);
          return { ok: true as const };
        },
        stop: () => {},
        skip: (callKey) => skipped.push(callKey),
        abort: () => {},
        resume: () => {},
      },
    });
    let component: any;
    const ctx = {
      ui: {
        custom: (factory: any) => {
          component = factory({ terminal: { rows: 40 } }, theme, {}, () => {});
          return Promise.resolve(undefined);
        },
        notify: () => {},
      },
    };
    // The panel refreshes on a timer while a run is live, so the component must
    // always be disposed even when an assertion fails.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    try {
      await panel.open(ctx);

      // The cursor starts on the run header; step onto the call, then into its menu.
      component.handleInput("j");
      component.handleInput("\r");
      assert.match(component.render(100).join("\n"), /❯ focus/, "the menu opens on its first action");
      component.handleInput("k"); // the first action is already the top one
      component.handleInput("\r");
      assert.deepEqual(focused, ["wf-agent"]);
      await settle();

      // Reopen the menu and walk down to \`skip\`.
      component.handleInput("\r");
      component.handleInput("j");
      component.handleInput("j");
      component.handleInput("j");
      component.handleInput("\r");
      await settle();
      assert.deepEqual(skipped, ["k1"]);
    } finally {
      component?.dispose?.();
    }
  });

  it("switches runs with [ and ]", async () => {
    const live = run({ runId: "wf-1", calls: [call({ callKey: "a", label: "first-agent" })] });
    const settled = run({
      runId: "wf-2",
      status: "completed",
      createdAt: 0,
      finishedAt: Date.now(),
      meta: { name: "second-run", description: "y" },
      calls: [call({ callKey: "b", label: "second-agent" })],
    });
    let component: any;
    const ctx = {
      ui: {
        custom: (factory: any) => {
          component = factory({ terminal: { rows: 40 } }, theme, {}, () => {});
          return Promise.resolve(undefined);
        },
        notify: () => {},
      },
    };
    try {
      await panelFor([live, settled]).open(ctx);
      assert.match(component.render(100).join("\n"), /first-agent/);

      component.handleInput("]");
      const second = component.render(100).join("\n");
      assert.match(second, /second-agent/);
      assert.doesNotMatch(second, /first-agent/);

      component.handleInput("[");
      assert.match(component.render(100).join("\n"), /first-agent/);
    } finally {
      component?.dispose?.();
    }
  });

  it("repaints while a run is live, and not once everything has settled", async () => {
    const repaints = { count: 0 };
    const open = async (views: WorkflowRunView[]) => {
      let component: any;
      const ctx = {
        ui: {
          custom: (factory: any) => {
            component = factory(
              { terminal: { rows: 40 }, requestRender: () => (repaints.count += 1) },
              theme,
              {},
              () => {},
            );
            return Promise.resolve(undefined);
          },
          notify: () => {},
        },
      };
      await panelFor(views).open(ctx);
      return component;
    };

    const settled = await open([run({ status: "completed", finishedAt: Date.now() })]);
    try {
      settled.render(100);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(repaints.count, 0, "a settled run must not repaint on a clock");
    } finally {
      settled.dispose();
    }

    const live = await open([run({ calls: [call({ callKey: "k", status: "running", name: "wf-agent" })] })]);
    try {
      live.render(100);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.ok(repaints.count > 0, "a live run repaints so its elapsed time stays current");
    } finally {
      live.dispose();
    }
  });

  it("scopes an overlay opened for one run and refuses an unknown run id", async () => {
    const views = [run({ runId: "wf-1" }), run({ runId: "wf-2", meta: { name: "other-run", description: "y" } })];
    const notified: string[] = [];
    let opened = 0;
    let rendered: string[] = [];
    const ctx = {
      ui: {
        custom: (factory: any) => {
          opened++;
          const component = factory({ terminal: { rows: 40 } }, theme, {}, () => {});
          rendered = component.render(100);
          component.dispose();
          return Promise.resolve(undefined);
        },
        notify: () => {},
      },
    };

    const panel = panelFor(views, { notify: (message) => notified.push(message) });
    await panel.open(ctx, "wf-2");
    const body = rendered.join("\n");
    assert.match(body, /other-run/);
    assert.doesNotMatch(body, /review-changes/, "the overlay only shows the requested run");
    assert.doesNotMatch(body, /wf-2/, "the run id stays out of the panel");

    await panel.open(ctx, "wf-9");
    assert.equal(opened, 1, "an unknown run id never opens the overlay");
    assert.match(notified.join("\n"), /No workflow run wf-9/);
  });

  it("opens a run that only exists on disk", async () => {
    // `/workflow wf-xxxx` after a restart used to refuse a run that
    // `action: 'status'` reads happily: the panel only knew what was in memory.
    const onDisk = run({ runId: "wf-disk" });
    let opened = 0;
    let rendered: string[] = [];
    const ctx = {
      ui: {
        custom: (factory: any) => {
          opened++;
          const component = factory({ terminal: { rows: 40 } }, theme, {}, () => {});
          rendered = component.render(100);
          component.dispose();
          return Promise.resolve(undefined);
        },
        notify: () => {},
      },
    };

    const notified: string[] = [];
    const panel = panelFor([], {
      inspect: (runId) => (runId === "wf-disk" ? onDisk : null),
      notify: (message) => notified.push(message),
    });

    await panel.open(ctx, "wf-disk");
    assert.equal(opened, 1, "a disk-backed run opens");
    assert.match(rendered.join("\n"), /review-changes/);

    await panel.open(ctx, "wf-missing");
    assert.equal(opened, 1, "a run that exists nowhere still does not");
    assert.match(notified.join("\n"), /No workflow run wf-missing/);
  });

  it("keeps the global manifest in sync with the documented primitives", () => {
    const names = WORKFLOW_GLOBALS.map((global) => global.name);
    for (const required of ["__wfBridgeAgent", "__wfBridgePhase", "__wfBridgeLog", "__wfBridgeWorkflow", "__wfBridgeBudget"]) {
      assert.ok(names.includes(required), `missing bridge global ${required}`);
    }
    // The script-visible names must not collide with the sandbox's reserved set.
    for (const reserved of ["tools", "console", "text", "exit", "store", "load", "ALL_TOOLS"]) {
      assert.ok(!names.includes(reserved), `reserved name ${reserved} must not be declared`);
    }
  });
});
