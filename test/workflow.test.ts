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
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { WorkflowManager } from "../pi-extension/subagents/workflow/manager.ts";
import {
  BUNDLED_WORKFLOWS_DIR,
  listSavedWorkflows,
  parseScript,
  readScriptFile,
  WorkflowScriptError,
} from "../pi-extension/subagents/workflow/script.ts";
import {
  buildWorkflowDescription,
  readAuthoringGuide,
  sizeGuideline,
  workflowSize,
} from "../pi-extension/subagents/workflow/authoring.ts";
import { registerWorkflowExtension } from "../pi-extension/subagents/workflow/index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import {
  WorkflowPanel,
  createPanelRenderState,
  callActions,
  workflowSummary,
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
  /** prompt substring → this agent never exits (a wedged agent). */
  hangs = new Set<string>();
  /** prompt substring → this agent reports "waiting" (parked on a question). */
  waiting = new Set<string>();
  /** prompt substring → the completion promise rejects (a broken watcher). */
  rejects = new Set<string>();
  /** prompt substring → closing its pane makes the watcher reject. */
  rejectOnStop = new Set<string>();
  /** prompt substring → non-zero exit with no error text (the watcher's closed path). */
  silentFailures = new Set<string>();
  /** Agents that actually finished (a gate for "the late answer arrived"). */
  finished = 0;
  /** Status reads that reported waiting / active, so a test can gate on them. */
  waitingServed = 0;
  activeServed = 0;
  /** Watcher rejections triggered by a pane teardown. */
  rejectedOnStop = 0;
  /** name → the reject function of that agent's completion. */
  private completions = new Map<string, (error: Error) => void>();
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
    const hang = [...this.hangs].some((needle) => request.task.includes(needle));
    const reject = [...this.rejects].some((needle) => request.task.includes(needle));
    const completion = new Promise<WorkflowSubagentCompletion>((resolve, rejectPromise) => {
      this.completions.set(request.name, (error) => rejectPromise(error));
      // Reject on a later turn so the manager has attached its handler first,
      // exactly like a watcher that throws mid-run.
      if (reject) {
        setTimeout(() => {
          this.inFlight--;
          rejectPromise(new Error("watcher exploded"));
        }, 5);
        return;
      }
      // An agent whose process never exits: no timer, no resolution.
      if (hang) return;
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
        this.finished++;
        const silent = [...this.silentFailures].some((needle) => request.task.includes(needle));
        resolve({
          exitCode: failed || silent ? 1 : 0,
          summary: silent ? "half-finished work that looks fine" : failed ? "" : this.replyFor(request.task),
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
    // A real pane teardown can make the watcher throw; tests opt in per task.
    const targeted = this.spawns.some(
      (spawn) =>
        spawn.name === name &&
        [...this.rejectOnStop].some((needle) => spawn.task.includes(needle)),
    );
    if (targeted) {
      this.rejectedOnStop++;
      this.completions.get(name)?.(new Error("watcher rejected after stop"));
    }
  }

  focus(name: string) {
    return this.permitted(name) ? ({ ok: true as const }) : { error: `no agent ${name}` };
  }

  status(name: string) {
    if (!this.permitted(name)) return undefined;
    const parked = this.spawns.some(
      (spawn) =>
        spawn.name === name && [...this.waiting].some((needle) => spawn.task.includes(needle)),
    );
    if (parked) this.waitingServed++;
    else this.activeServed++;
    return parked
      ? { kind: "waiting" as const, elapsedMs: 10, label: null }
      : { kind: "active" as const, elapsedMs: 10, label: "read" };
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

/** A promise a test resolves by hand, so it never depends on timing luck. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Poll for a state the test needs, instead of sleeping and hoping. */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 2000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Let the microtask/tick queue drain so unhandled rejections would surface. */
async function drainTicks(turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
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
  it("accepts pure meta literals with supported quoting, trailing commas and phase forms", () => {
    const cases = [
      { source: SCRIPT, name: "test-flow", phases: ["Scan", "Verify"] },
      {
        source: `export const meta = { name: 'x', description: 'y', phases: ['a',], }\nreturn 1;`,
        name: "x", phases: ["a"],
      },
      {
        // Claude Code uses mixed phase objects and strings; the title remains required.
        source: "export const meta = { name: 'cc-shaped', description: 'x', " +
          "whenToUse: 'when you want a sweep', phases: [{ title: 'Scan', detail: 'find' }, 'Verify'] }\nreturn 1;",
        name: "cc-shaped", phases: [{ title: "Scan", detail: "find" }, "Verify"],
        whenToUse: "when you want a sweep",
      },
    ];
    for (const { source, name, phases, whenToUse } of cases) {
      const parsed = parseScript(source, "inline");
      assert.equal(parsed.meta.name, name, name);
      assert.deepEqual(parsed.meta.phases, phases, name);
      assert.equal(parsed.meta.whenToUse, whenToUse, name);
      assert.ok(parsed.body.includes("const meta = {"), name);
      assert.ok(!parsed.body.includes("export const meta"), name);
    }
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
      () => parseScript("export const meta = { name: 'x', description: 'y', phases: [{ detail: 'no title' }] }\nreturn 1;", "inline"),
      WorkflowScriptError,
    );
    assert.throws(
      () => parseScript(`export const meta = { name: \`t\${x}\`, description: 'y' }\nreturn 1;`, "inline"),
      WorkflowScriptError,
    );
  });
});

describe("workflow authoring discovery", () => {
  it("keeps a complete example and shape guidance in the compact tool description", () => {
    const description = buildWorkflowDescription("medium");
    assert.match(description, /COMPLETE EXAMPLE/);
    assert.match(description, /export const meta/);
    assert.match(description, /pipeline\(args\.items/);
    assert.match(description, /about 10 total agent calls/);
    assert.match(description, /Mere benefit from parallelism is not opt-in/);
    assert.match(description, /workflow\(\{ action: 'guide' \}\)/);
    assert.match(description, /returns null, including bare await agent\(\)/);
    assert.doesNotMatch(description, /direct `await agent\(\.\.\.\)` rejects/);
    assert.ok(description.length < 6_000, "the always-loaded surface must stay compact");
    assert.doesNotMatch(buildWorkflowDescription("unrestricted"), /SIZE GUIDELINE/);
    assert.equal(workflowSize("large"), "large");
    assert.equal(workflowSize("bogus"), "medium");
    assert.match(sizeGuideline("small"), /about 5/);
  });

  it("exposes the skill and reference as a read-only fallback guide", () => {
    const guide = readAuthoringGuide("large");
    assert.match(guide, /# Workflow authoring/);
    assert.doesNotMatch(guide, /^---/);
    assert.match(guide, /## Shapes and executable templates/);
    assert.match(guide, /## Runtime API/);
    assert.match(guide, /declare function pipeline/);
    assert.match(guide, /about 50 total agent calls/);
    assert.ok(guide.length > buildWorkflowDescription("medium").length * 2, "the detailed guide is on demand");
  });

  it("registers a valid package skill", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    assert.deepEqual(pkg.pi.skills, ["./skills/workflow-authoring"]);
    const loaded = loadSkillsFromDir({ dir: join(process.cwd(), "skills/workflow-authoring"), source: "package" });
    assert.equal(loaded.diagnostics.length, 0);
    assert.equal(loaded.skills.length, 1);
    assert.equal(loaded.skills[0].name, "workflow-authoring");
    assert.match(loaded.skills[0].description, /authoring a workflow/i);
  });

  it("lists every bundled runnable template and parses all of them", () => {
    const empty = mkdtempSync(join(tmpdir(), "wf-list-"));
    caseDirs.push(empty);
    const { workflows, errors } = listSavedWorkflows({ cwd: empty, agentDir: empty });
    assert.deepEqual(errors, []);
    assert.deepEqual(workflows.map((workflow) => workflow.name), [
      "compare-options",
      "deep-research",
      "iterative-refinement",
      "migrate-files",
      "review-changes",
      "verify-claims",
    ]);
    assert.ok(workflows.every((workflow) => workflow.source === "bundled"));
    assert.ok(workflows.every((workflow) => workflow.meta.description.length > 0));
    for (const workflow of workflows) parseScript(readScriptFile(workflow.path), workflow.path);

    mkdirSync(join(empty, ".pi", "workflows"), { recursive: true });
    writeFileSync(
      join(empty, ".pi", "workflows", "deep-research.js"),
      "export const meta = { name: 'deep-research', description: 'project override' }\nreturn 'local';",
    );
    const overridden = listSavedWorkflows({ cwd: empty, agentDir: empty });
    const local = overridden.workflows.find((workflow) => workflow.name === "deep-research")!;
    assert.equal(local.source, "project");
    assert.equal(local.meta.description, "project override");
    assert.equal(overridden.workflows.filter((workflow) => workflow.name === "deep-research").length, 1);
  });

  it("provides list and guide actions without tmux or a persistent session", async () => {
    service = new FakeSubagentService();
    let tool: any;
    const pi = {
      registerTool(value: any) { tool = value; },
      registerCommand() {},
      registerShortcut() {},
      registerMessageRenderer() {},
      on() {},
    };
    const dir = mkdtempSync(join(tmpdir(), "wf-guide-"));
    caseDirs.push(dir);
    const previous = process.env.PI_CODING_AGENT_DIR;
    const previousSize = process.env.PI_WORKFLOW_SIZE;
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_WORKFLOW_SIZE = "medium";
    registerWorkflowExtension(pi as any, { service });
    assert.match(tool.description, /workflow-authoring skill/);
    assert.match(tool.description, /about 10 total agent calls/);
    const ctx = { cwd: dir, ui: { notify() {} } };
    try {
      const list = await tool.execute("list", { action: "list" }, undefined, undefined, ctx);
      assert.equal(list.details.action, "list");
      assert.match(list.content[0].text, /deep-research \[bundled\]/);
      assert.match(list.content[0].text, /review-changes/);
      assert.doesNotMatch(list.content[0].text, /tokens/i);

      const guide = await tool.execute("guide", { action: "guide", name: "deep-research" }, undefined, undefined, ctx);
      assert.equal(guide.details.action, "guide");
      assert.match(guide.content[0].text, /Workflow template: deep-research/);
      assert.match(guide.content[0].text, /No agents were started/);
      assert.match(guide.content[0].text, /Scope/);
      assert.match(guide.content[0].text, /Synthesize/);

      const authoring = await tool.execute("authoring", { action: "guide" }, undefined, undefined, ctx);
      assert.match(authoring.content[0].text, /# Workflow authoring/);
      assert.match(authoring.content[0].text, /## Shapes and executable templates/);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      if (previousSize === undefined) delete process.env.PI_WORKFLOW_SIZE;
      else process.env.PI_WORKFLOW_SIZE = previousSize;
    }
    assert.equal(service.spawns.length, 0);
  });
});

describe("workflow run", () => {
  for (const items of [["slow", "fast"], ["fast", "slow"]]) {
    it(`advances fast pipeline items before slow Recon settles (${items.join(", ")})`, async () => {
      service = new FakeSubagentService();
      service.tokensPerAgent = 10;
      const manager = createManager({ budgetTotal: 100 });
      let releaseSlow!: () => void;
      const slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });
      let sawVerify!: () => void;
      const verifyStarted = new Promise<void>(resolve => { sawVerify = resolve; });
      let slowSettled = false;
      const spawn = service.spawn.bind(service);
      service.spawn = async request => {
        const handle = await spawn(request);
        if (request.task === "recon-slow") {
          return {
            ...handle,
            completion: handle.completion.then(async result => {
              await slowGate;
              slowSettled = true;
              return result;
            }),
          };
        }
        if (request.task === "verify-fast") {
          assert.equal(slowSettled, false, "Verify must start while the slow Recon is still pending");
          sawVerify();
        }
        return handle;
      };
      const source = `export const meta = { name: 'streaming-pipeline', description: 'x', agent: 'worker' }
return await pipeline(args.items,
  item => agent('recon-' + item, { label: 'recon-' + item }),
  async (recon, item) => {
    const spent = budget.spent();
    const verdict = await agent('verify-' + item, { label: 'verify-' + item });
    return { item, recon, verdict, spent };
  });
`;
      const run = await manager.start({ source, args: { items } });
      const execution = run.execute();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let view: WorkflowRunView;
      try {
        await Promise.race([
          verifyStarted,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Verify waited for an unrelated Recon")), 1500);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        releaseSlow();
        view = await execution;
      }
      assert.equal(view.status, "completed", view.error);
      const result = view.result as Array<{ item: string; recon: string; verdict: string; spent: number }>;
      assert.deepEqual(result.map(row => row.item), items, "result arrays retain input order");
      assert.equal(result.find(row => row.item === "fast")!.spent, 10, "the fast result refreshes its budget before Verify");
      assert.equal(view.usage.totalTokens, 40);
      const spawns = service.spawns.length;
      const resumed = await (await manager.resume(view.runId)).execute();
      assert.equal(resumed.status, "completed", resumed.error);
      assert.equal(service.spawns.length, spawns, "changed completion order must not defeat journal reuse");
      assert.deepEqual(
        (resumed.result as typeof result).map(({ item, recon, verdict }) => ({ item, recon, verdict })),
        result.map(({ item, recon, verdict }) => ({ item, recon, verdict })),
      );
    });
  }

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

    // Final arrays preserve input order even though stages advance independently.
    const result = view.result as { scanned: string[] };
    assert.deepEqual(result.scanned, [
      "echo:verify-1:echo:scan-1",
      "echo:verify-2:echo:scan-2",
      "echo:verify-3:echo:scan-3",
    ]);

    const stats = JSON.parse(readFileSync(join(view.runDir, "snapshot.json"), "utf8"));
    assert.equal(stats.status, "completed");
    assert.equal(stats.agentCount, 8);

    const spawns = service.spawns.length;
    const inspected = manager.inspect(view.runId);
    assert.equal(inspected?.meta.name, "test-flow");
    assert.equal(inspected?.status, "completed");
    assert.equal(inspected?.calls.length, 8);
    assert.equal(manager.inspect("wf-nonexistent"), null);
    assert.equal(service.spawns.length, spawns, "inspection must not execute calls");
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

    const sameArgs = await (await manager.start({ source: script, args: { target: "a" }, reuse: "auto" })).execute();
    assert.equal(service.spawns.length, afterFirst, "the same args still reuse completed calls");
    assert.equal(sameArgs.resumedFrom, first.runId);

    const newArgs = await (await manager.start({ source: script, args: { target: "b" }, reuse: "auto" })).execute();
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
    const second = await manager.start({ source: edited, args: {}, reuse: 'auto' });
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

  it("accepts valid structured output and rejects missing or nonzero-exit results", async () => {
    service = new FakeSubagentService();
    service.structured.set("analyse", { verdict: "real", confidence: 0.9 });
    service.structuredMissing.add("analyse missing");
    service.silentFailures.add("half-dead-schema");
    service.structured.set("half-dead-schema", { verdict: "looks valid" });
    const manager = createManager();
    const script = `export const meta = { name: 'schema-flow', description: 'x' }
const valid = await agent('analyse this', { label: 'analyse', schema: { type: 'object', properties: { verdict: { type: 'string' }, confidence: { type: 'number' } }, required: ['verdict'] } });
const missing = await agent('analyse missing', { label: 'missing', schema: { type: 'object', properties: {} } });
const dead = await agent('half-dead-schema', { label: 'sidecar', schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] } });
return { valid, missing: missing === null ? 'no-value' : missing, dead };
`;
    const view = await (await manager.start({ source: script, args: {} })).execute();
    assert.equal(view.status, "completed", view.error);
    assert.deepEqual(view.result, {
      valid: { verdict: "real", confidence: 0.9 },
      missing: "no-value", // A missing result resolves to null, with a recorded reason.
      dead: null, // Exit status wins over the valid-looking sidecar left behind.
    });
    assert.equal(view.failedCount, 2);
    const spawn = service.spawns.find((entry) => entry.task.startsWith("analyse this"));
    assert.ok(spawn?.schemaFile, "a schema file must be handed to the child");
    assert.ok(spawn?.resultFile, "a result sidecar must be handed to the child");
    assert.equal(view.calls.find((entry) => entry.label === "analyse")?.status, "completed");
    const missing = view.calls.find((entry) => entry.label === "missing")!;
    assert.equal(missing.status, "failed");
    assert.match(String(missing.error), /structured_output/);

    const dead = view.calls.find((entry) => entry.label === "sidecar")!;
    assert.equal(dead.status, "failed");
    assert.match(String(dead.error), /agent exited with code 1/);
    const sidecar = service.spawns.find((entry) => entry.task.startsWith("half-dead-schema"))!.resultFile!;
    assert.deepEqual(JSON.parse(readFileSync(sidecar, "utf8")), { ok: true, value: { verdict: "looks valid" } });
    const journal = readFileSync(join(view.runDir, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.callKey === dead.callKey);
    assert.deepEqual(journal.map((entry) => entry.status), ["failed"]);
  });

  it("fails a non-zero exit that carries no error text, and resume retries it", async () => {
    // The watcher's "closed" path reports exit code without an error message.
    // That is still a failure, and the agent's last text is not an answer.
    service = new FakeSubagentService();
    service.silentFailures.add("half-dead");
    const manager = createManager();
    const script = `export const meta = { name: 'silent-exit', description: 'x' }
return await agent('half-dead', { label: 'half-dead' });
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();
    assert.equal(view.status, "completed", view.error);
    assert.equal(view.result, null, "a non-zero exit must not return the agent's text");
    const call = view.calls.find((entry) => entry.label === "half-dead")!;
    assert.equal(call.status, "failed");
    assert.match(String(call.error), /agent exited with code 1/);
    const journal = readFileSync(join(view.runDir, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.callKey === call.callKey);
    assert.deepEqual(journal.map((entry) => entry.status), ["failed"]);

    // A failed line is never replayed as an answer: resume runs it again.
    const spawnedBefore = service.spawns.length;
    const resumed = await (await manager.resume(view.runId)).execute();
    assert.equal(resumed.status, "completed", resumed.error);
    assert.equal(resumed.result, null);
    assert.ok(service.spawns.length > spawnedBefore, "a failed call must be retried on resume");
    assert.equal(resumed.calls.find((entry) => entry.label === "half-dead")?.status, "failed");
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

  it("does not launch a call that was skipped while it was still queued", async () => {
    // Two slots, three slow calls: the third is still queued when the user
    // skips it. When a slot frees up afterwards nothing may start — the call
    // used to launch anyway and journal a second, "completed" line, which
    // resume then replayed as a real answer.
    const previous = process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS;
    process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS = "2";
    try {
      service = new FakeSubagentService();
      service.delays.set("work-", 250);
      const manager = createManager();
      const script = `export const meta = { name: 'skip-queued', description: 'x' }
return await parallel([1, 2, 3].map((n) => async () => agent('work-' + n, { label: 'work-' + n })));
`;
      const run = await manager.start({ source: script, args: {} });
      const execution = run.execute();

      let queued = run.view().calls.find((call) => call.status === "queued");
      for (let attempt = 0; attempt < 200 && !queued; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        queued = run.view().calls.find((call) => call.status === "queued");
      }
      assert.ok(queued, "a call must be queued behind the two slots");
      const skipped = queued!;
      assert.equal(run.skip(skipped.callKey), true);

      const view = await execution;
      assert.equal(view.status, "completed", view.error);
      const journal = readFileSync(join(view.runDir, "journal.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.callKey === skipped.callKey);
      assert.deepEqual(journal.map((entry) => entry.status), ["skipped"], "one settled line per call");
      assert.ok(
        !service.spawns.some((spawn) => spawn.task === skipped.label),
        "the skipped call must not start an agent when its slot frees up",
      );
      assert.equal(view.calls.find((call) => call.callKey === skipped.callKey)!.status, "skipped");

      // A skip is a decision for this run only: resume retries the call.
      const resumed = await (await manager.resume(view.runId)).execute();
      assert.equal(resumed.status, "completed", resumed.error);
      assert.equal(resumed.calls.find((call) => call.label === skipped.label)!.status, "completed");
      assert.ok(
        service.spawns.some((spawn) => spawn.task === skipped.label),
        "resume must really run the skipped call",
      );
    } finally {
      if (previous === undefined) delete process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS;
      else process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS = previous;
    }
  });

  it("keeps a run alive while an agent is still working past the inactivity budget", async () => {
    // The budget measures progress, not wall clock: one agent that outlasts it
    // is working normally, so the run must not be killed.
    service = new FakeSubagentService();
    service.delays.set("patient", 900);
    const manager = createManager();
    const script = `export const meta = { name: 'long-agent', description: 'x' }
return await agent('patient', { label: 'p' });
`;
    const run = await manager.start({ source: script, args: {} });
    run.setScriptTimeout(400);
    const view = await run.execute();
    assert.equal(view.status, "completed", view.error);
    assert.equal(view.result, "echo:patient");
  });

  it("fails one wedged call instead of hanging the run forever", async () => {
    // The script watchdog stays quiet while the host owes the script an answer,
    // so an agent that never exits is bounded by the per-call ceiling: its call
    // fails, the script continues with null, and the run still completes.
    service = new FakeSubagentService();
    service.hangs.add("wedged");
    const manager = createManager();
    const script = `export const meta = { name: 'wedged-agent', description: 'x' }
const first = await agent('wedged', { label: 'wedged' });
const second = await agent('healthy', { label: 'healthy' });
return { first, second };
`;
    const run = await manager.start({ source: script, args: {} });
    run.setCallTimeout(150);
    const view = await run.execute();
    assert.equal(view.status, "completed", view.error);
    assert.deepEqual(view.result, { first: null, second: "echo:healthy" });
    const wedged = view.calls.find((call) => call.label === "wedged");
    assert.equal(wedged?.status, "failed");
    assert.match(String(wedged?.error), /without finishing/);
    // The agent is stopped, not left running in a pane that nobody waits for.
    assert.deepEqual(service.stopped, [wedged?.name]);
  });

  it("keeps an intentional wait alive past the per-call ceiling", async () => {
    // A step parked on ask_question reports "waiting": that is the run working
    // as designed, not a dead agent, so the ceiling must never fire on it. Only
    // work time counts.
    service = new FakeSubagentService();
    service.hangs.add("asking");
    service.waiting.add("asking");
    const manager = createManager();
    const script = `export const meta = { name: 'waiting-step', description: 'x' }
return await agent('asking', { label: 'asking' });
`;
    const run = await manager.start({ source: script, args: {} });
    run.setCallTimeout(100);
    const executing = run.execute();
    await new Promise((resolve) => setTimeout(resolve, 400));
    run.abort();
    const view = await executing;
    assert.equal(view.status, "aborted");
    assert.equal(view.calls.find((call) => call.label === "asking")?.status, "aborted");
    assert.equal(view.failedCount, 0, "a wait must not be reported as a failed call");
  });

  it("fails the call when the agent watcher rejects instead of hanging", async () => {
    // The completion interface says it never rejects, but the wiring awaits a
    // watcher that can throw. A missing rejection handler would leave the call
    // pending forever and surface as an unhandled rejection.
    service = new FakeSubagentService();
    service.rejects.add("explode");
    const manager = createManager();
    const script = `export const meta = { name: 'reject', description: 'x' }
return await agent('explode', { label: 'explode' });
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();
    assert.equal(view.status, "completed", view.error);
    assert.equal(view.result, null);
    const call = view.calls.find((entry) => entry.label === "explode");
    assert.equal(call?.status, "failed");
    assert.match(String(call?.error), /watcher exploded/);
  });

  it("stops exempting a wait once the allowance is spent", async () => {
    // "waiting" is only a snapshot phase: a process alive but wedged there, or a
    // watcher that stopped reporting, keeps claiming it forever. An explicitly
    // configured allowance is the bound for exactly that case.
    service = new FakeSubagentService();
    service.hangs.add("parked");
    service.waiting.add("parked");
    const manager = createManager();
    const script = `export const meta = { name: 'dead-wait', description: 'x' }
return await agent('parked', { label: 'parked' });
`;
    const run = await manager.start({ source: script, args: {} });
    run.setCallTimeout(100);
    run.setWaitAllowance(100);
    const view = await run.execute();
    assert.ok(service.waitingServed > 0, "the ceiling must have observed the wait");
    assert.equal(view.status, "completed", view.error);
    assert.equal(view.result, null);
    const call = view.calls.find((entry) => entry.label === "parked");
    assert.equal(call?.status, "failed");
    assert.match(String(call?.error), /waiting on an answer is exempt/);
  });

  it("starts counting work again when a wait ends", async () => {
    // First prove the point of the test: the call outlives its ceiling while it
    // waits, so surviving is the exemption working, not a ceiling that never
    // fired. Only then answer, and require the failure to come after the flip.
    service = new FakeSubagentService();
    service.hangs.add("flip");
    service.waiting.add("flip");
    const manager = createManager();
    const script = `export const meta = { name: 'wait-flip', description: 'x' }
return await agent('flip', { label: 'flip' });
`;
    const run = await manager.start({ source: script, args: {} });
    run.setCallTimeout(100);
    const executing = run.execute();
    // Start the clock only once the agent has launched: VM start-up time must
    // not be counted as the call outliving its ceiling.
    await waitFor(() => service.spawns.length === 1, "the agent to launch");
    const startedAt = Date.now();
    // Wall clock measured by the test: 3x the ceiling, not a counter the test's
    // own view() polls could satisfy.
    await waitFor(() => Date.now() - startedAt >= 350, "the call to outlive its ceiling while waiting");
    assert.equal(
      run.view().calls.find((entry) => entry.label === "flip")?.status,
      "running",
      "a waiting call must outlive its ceiling",
    );
    service.waiting.delete("flip");
    const view = await executing;
    assert.equal(view.status, "completed", view.error);
    assert.equal(view.calls.find((entry) => entry.label === "flip")?.status, "failed");
  });

  it("frees a skipped call's slot instead of waiting for the ceiling", async (t) => {
    // The skipped call's pane is closed, but its launch task used to keep the
    // scheduling slot until the ceiling fired — forever when the ceiling is off.
    // The ceiling here is far past the assertion window, so only the skip can
    // free the slot in time.
    const previous = process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS;
    process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS = "1";
    try {
      service = new FakeSubagentService();
      service.hangs.add("first");
      service.hangs.add("second");
      const manager = createManager();
      const script = `export const meta = { name: 'skip-slot', description: 'x' }
return await parallel([
  () => agent('first', { label: 'first' }),
  () => agent('second', { label: 'second' }),
]);
`;
      const run = await manager.start({ source: script, args: {} });
      // A failed assertion must still release the hung agents and the 60s
      // ceiling timer, or the process outlives the test.
      t.after(() => run.abort());
      run.setCallTimeout(60_000);
      const executing = run.execute();
      await waitFor(() => service.spawns.length === 1, "the first call to start");
      const first = run.view().calls.find((entry) => entry.label === "first")!;
      assert.equal(run.skip(first.callKey), true);

      // Bounded observation, then a plain assertion: a regression must fail the
      // test with ERR_ASSERTION, not with an opaque timeout error.
      await waitFor(
        () => service.spawns.length === 2,
        "the freed slot to start the second call",
        800,
      ).catch(() => undefined);
      assert.equal(
        service.spawns.length,
        2,
        "the freed slot must start the second call without waiting for the ceiling",
      );
      await waitFor(() => service.stopped.length === 1, "the skipped pane to be closed");
      assert.equal(
        run.view().calls.find((entry) => entry.label === "first")?.status,
        "skipped",
      );
      run.abort();
      const view = await executing;
      assert.equal(view.status, "aborted");
    } finally {
      if (previous === undefined) delete process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS;
      else process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS = previous;
    }
  });

  it("writes a fatal run failure to disk even when nothing is in flight", async () => {
    // failRun() flips the snapshot's status, which makes execute() skip its only
    // forced persist; every other write is throttled. The terminal state used to
    // stay "running" on disk.
    service = new FakeSubagentService();
    service.tokensPerAgent = 40;
    const manager = createManager({ budgetTotal: 30 });
    const script = `export const meta = { name: 'budget-persist', description: 'x', agent: 'worker' }
await agent('a', { label: 'a' });
await agent('b', { label: 'b' });
return 'done';
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();
    assert.equal(view.status, "failed");
    assert.match(String(view.error), /budget exhausted/);
    const onDisk = JSON.parse(readFileSync(join(view.runDir, "snapshot.json"), "utf8"));
    assert.equal(onDisk.status, "failed", "the terminal state must reach disk");
    assert.match(String(onDisk.error), /budget exhausted/);
    assert.ok(onDisk.finishedAt, "a finished run records when it finished");
  });

  it("keeps a timed-out call failed when its agent finishes later", async () => {
    // Gate on the agent actually finishing instead of sleeping past it.
    service = new FakeSubagentService();
    service.delays.set("slow-finish", 120);
    const manager = createManager();
    const script = `export const meta = { name: 'late-finish', description: 'x' }
return await agent('slow-finish', { label: 'slow-finish' });
`;
    const run = await manager.start({ source: script, args: {} });
    run.setCallTimeout(40);
    const view = await run.execute();
    assert.equal(view.status, "completed", view.error);
    assert.equal(view.result, null);
    const call = view.calls.find((entry) => entry.label === "slow-finish")!;
    assert.equal(call.status, "failed");
    await waitFor(() => service.finished >= 1, "the late answer to arrive");
    await drainTicks();
    const journal = readFileSync(join(view.runDir, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.callKey === call.callKey);
    assert.deepEqual(journal.map((entry) => entry.status), ["failed"]);
    assert.equal(run.view().calls.find((entry) => entry.label === "slow-finish")?.status, "failed");
  });

  it("lets abort win when it lands before the ceiling", async () => {
    service = new FakeSubagentService();
    service.hangs.add("parked");
    const manager = createManager();
    const script = `export const meta = { name: 'abort-first', description: 'x' }
return await agent('parked', { label: 'parked' });
`;
    const run = await manager.start({ source: script, args: {} });
    run.setCallTimeout(5000);
    const executing = run.execute();
    await waitFor(
      () => service.activeServed > 0 && run.view().calls.some((call) => call.status === "running"),
      "the call to be live before aborting",
    );
    run.abort();
    const view = await executing;
    assert.equal(view.status, "aborted");
    assert.equal(view.calls.find((entry) => entry.label === "parked")?.status, "aborted");
    assert.equal(view.failedCount, 0);
  });

  it("keeps the timeout failure when abort lands after it", async () => {
    // Gate on both halves of the state this race needs: the first call has
    // failed, and the second one is already in flight. Aborting after the first
    // failure alone can land before the second call exists, which asserts on a
    // call that was never created.
    service = new FakeSubagentService();
    service.hangs.add("wedged");
    service.hangs.add("answering");
    service.waiting.add("answering");
    const manager = createManager();
    const script = `export const meta = { name: 'abort-second', description: 'x' }
const first = await agent('wedged', { label: 'first' });
const second = await agent('answering', { label: 'second' });
return [first, second];
`;
    const run = await manager.start({ source: script, args: {} });
    run.setCallTimeout(50);
    const executing = run.execute();
    await waitFor(
      () => {
        const calls = run.view().calls;
        return (
          calls.find((entry) => entry.label === "first")?.status === "failed" &&
          calls.find((entry) => entry.label === "second")?.status === "running"
        );
      },
      "the first call to fail and the second to be in flight",
    );
    run.abort();
    const view = await executing;
    assert.equal(view.status, "aborted");
    const first = view.calls.find((entry) => entry.label === "first")!;
    assert.equal(first.status, "failed");
    assert.equal(view.calls.find((entry) => entry.label === "second")?.status, "aborted");
    const journal = readFileSync(join(view.runDir, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.callKey === first.callKey);
    assert.deepEqual(journal.map((entry) => entry.status), ["failed"]);
  });

  it("closes a pane that a skip raced with its spawn", async () => {
    // The launch gate holds spawn open, so the skip lands in the exact window:
    // the call is live, the pane exists, and the handle has not returned yet.
    service = new FakeSubagentService();
    const spawn = service.spawn.bind(service);
    const launch = deferred();
    const entered = deferred();
    service.spawn = async (request) => {
      entered.resolve();
      await launch.promise;
      return spawn(request);
    };
    const manager = createManager();
    const script = `export const meta = { name: 'skip-race', description: 'x' }
return await agent('slow-start', { label: 'slow-start' });
`;
    const run = await manager.start({ source: script, args: {} });
    const executing = run.execute();
    await entered.promise;
    const live = run.view().calls.find((call) => call.status === "running");
    assert.ok(live, "the call must be live while its pane is still launching");
    assert.equal(run.skip(live!.callKey), true);
    launch.resolve();

    const view = await executing;
    assert.equal(view.status, "completed", view.error);
    assert.equal(view.result, null);
    assert.equal(view.calls.find((call) => call.callKey === live!.callKey)?.status, "skipped");
    await waitFor(() => service.stopped.length === 1, "the late handle to be closed");
    assert.equal(service.spawns.length, 1, "the pane had launched by the time the skip landed");
    const journal = readFileSync(join(view.runDir, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.callKey === live!.callKey);
    assert.deepEqual(journal.map((entry) => entry.status), ["skipped"]);
  });

  it("handles a watcher that throws when a skipped pane is closed", async () => {
    // The handle arrives after the skip, is stopped, and that teardown makes
    // the watcher throw. The rejection belongs to a call that already settled:
    // it must be consumed, not leak.
    const leaked: unknown[] = [];
    const onRejection = (reason: unknown) => leaked.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      service = new FakeSubagentService();
      const spawn = service.spawn.bind(service);
      const launch = deferred();
      const entered = deferred();
      service.spawn = async (request) => {
        entered.resolve();
        await launch.promise;
        return spawn(request);
      };
      service.rejectOnStop.add("slow-start");
      const manager = createManager();
      const script = `export const meta = { name: 'skip-reject', description: 'x' }
return await agent('slow-start', { label: 'slow-start' });
`;
      const run = await manager.start({ source: script, args: {} });
      const executing = run.execute();
      await entered.promise;
      const live = run.view().calls.find((call) => call.status === "running");
      assert.ok(live, "the call must be live while its pane is still launching");
      assert.equal(run.skip(live!.callKey), true);
      launch.resolve();

      const view = await executing;
      await waitFor(() => service.rejectedOnStop === 1, "the watcher to reject after the stop");
      await drainTicks();
      assert.equal(view.status, "completed", view.error);
      assert.equal(view.calls.find((call) => call.callKey === live!.callKey)?.status, "skipped");
      assert.equal(service.stopped.length, 1, "the late handle must be closed exactly once");
      assert.deepEqual(leaked, [], "a watcher rejection must not leak");
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("handles a watcher that throws when an aborted run closes its pane", async () => {
    const leaked: unknown[] = [];
    const onRejection = (reason: unknown) => leaked.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      service = new FakeSubagentService();
      const spawn = service.spawn.bind(service);
      const launch = deferred();
      const entered = deferred();
      service.spawn = async (request) => {
        entered.resolve();
        await launch.promise;
        return spawn(request);
      };
      service.rejectOnStop.add("slow-start");
      const manager = createManager();
      const script = `export const meta = { name: 'abort-reject', description: 'x' }
return await agent('slow-start', { label: 'slow-start' });
`;
      const run = await manager.start({ source: script, args: {} });
      const executing = run.execute();
      await entered.promise;
      assert.ok(
        run.view().calls.find((call) => call.status === "running"),
        "the call must be live while its pane is still launching",
      );
      run.abort();
      launch.resolve();

      const view = await executing;
      await waitFor(() => service.rejectedOnStop === 1, "the watcher to reject after the stop");
      await drainTicks();
      assert.equal(view.status, "aborted", view.error);
      assert.equal(service.spawns.length, 1);
      assert.equal(service.stopped.length, 1, "the late handle must be closed exactly once");
      assert.deepEqual(leaked, [], "a watcher rejection must not leak");
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("still fails a script that waits on a promise nobody answers", async () => {
    // The per-call ceiling must not swallow the script-level net: with nothing
    // outstanding, a script that never makes progress is still a broken script,
    // and the run has to fail instead of waiting forever.
    service = new FakeSubagentService();
    const manager = createManager();
    const script = `export const meta = { name: 'stuck-script', description: 'x' }
await new Promise(() => {});
return 'unreachable';
`;
    const run = await manager.start({ source: script, args: {} });
    run.setScriptTimeout(250);
    const view = await run.execute();
    assert.equal(view.status, "failed");
    // Either net is acceptable: the VM reports the unanswerable promise, and
    // the host watchdog reports the same stall as "no progress".
    assert.match(String(view.error), /never settle|no progress/);
  });

  it("gives concurrent same-label calls distinct agent names", async () => {
    // The real service only learns a name once the pane launch resolves, so a
    // same-label fan-out reads the same taken-set for every call. The runtime
    // must reserve what it hands out, or stop/focus/message answer with
    // "Ambiguous subagent name".
    service = new FakeSubagentService();
    const spawn = service.spawn.bind(service);
    const registered: string[] = [];
    service.spawn = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      registered.push(request.name);
      return spawn(request);
    };
    service.takenNames = () => new Set(registered);
    const manager = createManager();
    const script = `export const meta = { name: 'names-flow', description: 'x', agent: 'worker' }
return await parallel([1, 2, 3].map((n) => async () => agent('check-' + n, { label: 'check' })));
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();
    assert.equal(view.status, "completed", view.error);
    const names = view.calls.map((call) => call.name);
    assert.equal(new Set(names).size, 3, `names must be unique, got ${names.join(", ")}`);
  });

  it("fails the run on an author error inside parallel()", async () => {
    // A dead agent is null; a typo is the author's mistake. parallel() swallows
    // a thunk's own throw, so the runtime has to mark author errors as fatal or
    // the run completes with a null and nobody learns about the typo.
    service = new FakeSubagentService();
    const manager = createManager();
    const script = `export const meta = { name: 'typo-flow', description: 'x' }
const results = await parallel([async () => agent('looks fine', { label: 'a' }), async () => agent('typo', { label: 'b', schemas: {} })]);
return results.length;
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();
    assert.equal(view.status, "failed");
    assert.match(String(view.error), /unknown option/);
  });

  it("reports remaining() as Infinity when no token budget is set", async () => {
    // Infinity does not survive the JSON bridge; the prelude has to read a null
    // remaining back as Infinity, or `remaining() < 1000` compares null to 0.
    service = new FakeSubagentService();
    service.tokensPerAgent = 7;
    const manager = createManager();
    const script = `export const meta = { name: 'unbounded-flow', description: 'x', agent: 'worker' }
const before = budget.remaining();
await agent('scan', { label: 'a' });
return {
  total: budget.total,
  beforeInfinite: before === Infinity,
  afterInfinite: budget.remaining() === Infinity,
  huge: budget.remaining() > 1e9,
};
`;
    const run = await manager.start({ source: script, args: {} });
    const view = await run.execute();
    assert.equal(view.status, "completed", view.error);
    assert.deepEqual(view.result, { total: null, beforeInfinite: true, afterInfinite: true, huge: true });
  });

  it("reuses the newest matching run, not whichever id sorts last", async () => {
    // Run ids are random, so directory order says nothing about age. Renaming
    // the two runs to invert their sort order makes the difference visible.
    service = new FakeSubagentService();
    const manager = createManager();
    const script = `export const meta = { name: 'newest-flow', description: 'x', agent: 'worker' }
return await agent('scan', { label: 'scan' });
`;
    service.replies.set("scan", "old-answer");
    const first = await (await manager.start({ source: script, args: {} })).execute();
    service.replies.set("scan", "new-answer");
    await new Promise((resolve) => setTimeout(resolve, 5));
    // `reuse: 'none'` makes the second run write its own journaled answer
    // instead of replaying the first one's.
    const second = await (await manager.start({ source: script, args: {}, reuse: "none" })).execute();
    assert.ok(second.createdAt > first.createdAt, "the two runs must be distinguishable by age");

    // The oldest run gets the id that sorts last, so directory order is the
    // reverse of age.
    const rename = (view: WorkflowRunView, runId: string) =>
      renameSync(view.runDir, join(dirname(view.runDir), runId));
    rename(first, "wf-zzzzzz000001");
    rename(second, "wf-aaaaaa000002");

    const third = await (await manager.start({ source: script, args: {}, reuse: "auto" })).execute();
    assert.equal(third.status, "completed", third.error);
    assert.equal(third.resumedFrom, "wf-aaaaaa000002", "the newest run is the one to replay");
    assert.equal(third.result, "new-answer");
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

  it("rejects invalid agent options before scheduling with specific diagnostics", async () => {
    service = new FakeSubagentService();
    service.allowed = ["worker", "scout", "claude-cli"];
    service.kinds.set("claude-cli", "cli");
    const manager = createManager();
    const cases = [
      { name: "unknown-agent", opts: { label: "x", agent: "nope" }, error: /unknown agent "nope"/, caught: true },
      { name: "bad-effort", opts: { effort: "very-high" }, error: /expected one of off, minimal, low, medium, high, xhigh, max/ },
      { name: "unknown-option", opts: { label: "one", schemas: { type: "object" } }, error: /unknown option `schemas`/ },
      { name: "bad-isolation", opts: { label: "one", isolation: "unknown" }, error: /isolation.*worktree/ },
      {
        name: "missing-schema-property",
        opts: { label: "one", schema: { type: "object", properties: { a: { type: "string" } }, required: ["b"] } },
        error: /requires `b`.*not in `properties`/,
      },
      { name: "non-object-schema", opts: { label: "one", schema: { type: "string" } }, error: /type: 'object'/ },
      {
        name: "cli-schema", opts: { label: "one", agent: "claude-cli", schema: { type: "object", properties: {} } },
        error: /external CLI/,
      },
    ];
    for (const { name, opts, error, caught } of cases) {
      const call = `await agent('one', ${JSON.stringify(opts)});`;
      // Unknown-agent errors must also reach a script's catch block unchanged.
      const body = caught ? `try { ${call} return 'no-error'; } catch (error) { return 'error:' + error.message; }`
        : `${call} return 'unreachable';`;
      const source = `export const meta = { name: '${name}', description: 'x', agent: 'worker' }\n${body}`;
      const view = await (await manager.start({ source, args: {}, reuse: "none" })).execute();
      assert.equal(view.status, caught ? "completed" : "failed", name);
      assert.match(String(caught ? view.result : view.error), error, name);
      assert.equal(service.spawns.length, 0, `${name}: invalid options must not reach the scheduler`);
    }
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

  it("exposes args and refreshes spent/remaining tokens after an agent settles", async () => {
    service = new FakeSubagentService();
    service.tokensPerAgent = 60;
    const manager = createManager({ budgetTotal: 10_000 });
    const script = `export const meta = { name: 'budget-flow', description: 'x' }
const before = await budget.spent();
await agent('scan-1', { label: 'a' });
return { args, before, after: budget.spent(), remaining: budget.remaining(), total: budget.total };
`;
    const run = await manager.start({ source: script, args: { task: "t" } });
    const view = await run.execute();
    assert.equal(view.status, "completed", view.error);
    const result = view.result as { args: { task: string }; before: number; after: number; remaining: number; total: number };
    assert.equal(result.args.task, "t");
    assert.equal(result.before, 0);
    assert.equal(result.after, 60);
    assert.equal(result.remaining, 9_940);
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
    assert.ok(service.spawns.length === 1000, `the cap must stop the loop, saw ${service.spawns.length} spawns`);
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

  it("enforces the token ceiling and lets a budget-aware script stop on its own", async () => {
    service = new FakeSubagentService();
    service.tokensPerAgent = 40;
    const manager = createManager({ budgetTotal: 100 });
    const cases = [
      {
        name: "budgeted", status: "failed",
        // The crossing call runs, but the next call is refused fatally even
        // when the script ignores remaining() and keeps requesting work.
        body: "for (let i = 0; i < 5; i++) { await agent('spin', { label: 'spin' + i }) }\nreturn 'finished';",
      },
      {
        name: "budget-aware", status: "completed",
        body: `let runs = 0;
while (budget.total && budget.remaining() > 0) {
  await agent('spin', { label: 'spin' + runs });
  runs++;
  if (runs > 10) break;
}
return runs;`,
      },
    ];
    for (const { name, status, body } of cases) {
      const before = service.spawns.length;
      const source = `export const meta = { name: '${name}', description: 'x', agent: 'worker' }\n${body}`;
      const view = await (await manager.start({ source, args: {}, reuse: "none" })).execute();
      assert.equal(view.status, status, `${name}: ${view.error}`);
      const spawns = service.spawns.length - before;
      if (status === "failed") {
        assert.match(String(view.error), /budget exhausted/, name);
        assert.ok(spawns < 5, `${name}: the ceiling must stop the loop, saw ${spawns}`);
      } else {
        assert.equal(spawns, 3, `${name}: it stops when the budget says to, not when the run dies`);
      }
    }
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
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const call = (overrides: Partial<WorkflowAgentResultMeta> = {}): WorkflowAgentResultMeta => ({
    callKey: "key-1", label: "review:panel-ui", status: "running", agentType: "workflow-subagent",
    name: "review-agent", sessionFile: "/tmp/agent.jsonl", durationMs: 60_000, phase: "Scan", ...overrides,
  });
  const run = (overrides: Partial<WorkflowRunView> = {}): WorkflowRunView => ({
    runId: "wf-1", meta: { name: "review-changes", description: "x", phases: ["Scan", "Verify"] },
    status: "running", createdAt: 0, updatedAt: 60_000, startedAtWall: 0, finishedAt: undefined,
    agentCount: 1, activeCount: 1, completedCount: 0, failedCount: 0, totalCount: 1, maxConcurrent: 4,
    progress: 0, usage: { totalTokens: 1234, cost: 0.12 }, scriptPath: "/tmp/script.js", runDir: "/tmp/run",
    sessionFile: "/tmp/session.jsonl", cwd: "/tmp", calls: [call()], logs: [], logsDropped: 0, ...overrides,
  });
  const panelFor = (views: WorkflowRunView[], overrides: Partial<WorkflowPanelOptions> = {}) => new WorkflowPanel({
    callbacks: { focus: () => ({ ok: true as const }), skip() {}, abort() {}, resume() {} },
    views: () => views, isLive: id => views.some(v => v.runId === id && v.status === "running"), notify() {}, ...overrides,
  });
  it("renders a bordered tree without usage, progress or footer hints", () => {
    const panel = panelFor([run()]);
    const lines = panel.renderPanel(theme, 100, createPanelRenderState(), 25);
    const body = lines.join("\n");
    assert.match(body, /╭─ Workflows/);
    assert.match(body, /review-changes/);
    assert.match(body, /Scan/);
    assert.match(body, /review:panel-ui/);
    assert.doesNotMatch(body, /tokens|settled|select|collapse\/expand|switch run|enter actions/);
    assert.equal(lines.length, 25);
    assert.ok(lines.every(line => visibleWidth(line) === 100));
  });
  it("merges interleaved phases and keeps declared phase order", () => {
    const panel = panelFor([run({ calls: [call({ callKey: "a" }), call({ callKey: "b", phase: "Verify" }), call({ callKey: "c" })] })]);
    const nodes = panel.nodes(createPanelRenderState());
    assert.deepEqual(nodes.filter(n => n.kind === "phase").map(n => n.label), ["Scan", "Verify"]);
    assert.deepEqual(nodes.filter(n => n.kind === "call").map(n => n.call!.callKey), ["a", "c", "b"]);
  });
  it("uses run-qualified node identity even for matching cached call keys", () => {
    const panel = panelFor([run(), run({ runId: "wf-2", createdAt: 1 })]);
    const state = createPanelRenderState();
    state.expanded.add("run:wf-1"); state.expanded.add("run:wf-2");
    const nodes = panel.nodes(state);
    assert.equal(new Set(nodes.map(n => n.id)).size, nodes.length);
    assert.equal(nodes.filter(n => n.kind === "run").length, 2);
  });
  it("supports Vim and arrow navigation, Enter toggles, and Focus closes", async () => {
    const focused: string[] = [];
    let closed = 0;
    const panel = panelFor([run()], { callbacks: { focus: (name, file) => { focused.push(`${name}:${file}`); return { ok: true }; }, skip() {}, abort() {}, resume() {} } });
    const state = createPanelRenderState(); panel.nodes(state);
    assert.equal(state.selected, "run:wf-1:call:key-1");
    await panel.handleInput("l", () => closed++, state);
    assert.ok(state.expanded.has(state.selected!));
    await panel.handleInput("\u001b[C", () => closed++, state);
    assert.match(state.selected!, /:focus$/);
    await panel.handleInput("j", () => closed++, state);
    assert.match(state.selected!, /:skip$/);
    await panel.handleInput("\u001b[A", () => closed++, state);
    assert.match(state.selected!, /:focus$/);
    await panel.handleInput("\r", () => closed++, state);
    assert.deepEqual(focused, ["review-agent:/tmp/agent.jsonl"]);
    assert.equal(closed, 1);
    state.selected = "run:wf-1:call:key-1";
    await panel.handleInput("h", () => {}, state);
    assert.ok(!state.expanded.has(state.selected));
    await panel.handleInput("h", () => {}, state);
    assert.equal(state.selected, "run:wf-1:phase:Scan");
    await panel.handleInput("\r", () => {}, state);
    assert.ok(!state.expanded.has(state.selected));
  });
  it("offers Focus for completed sessions, Skip for queued calls, and no message/stop", () => {
    assert.deepEqual(callActions(call()), ["focus", "skip"]);
    assert.deepEqual(callActions(call({ status: "completed" })), ["focus"]);
    assert.deepEqual(callActions(call({ status: "queued", name: undefined, sessionFile: undefined })), ["skip"]);
    assert.deepEqual(callActions(call({ status: "completed", sessionFile: undefined })), []);
  });
  it("requires confirmation for Skip and refuses stale actions", async () => {
    const view = run(); let skips = 0;
    const panel = panelFor([view], { callbacks: { focus: () => ({ ok: true }), skip(key, id) { assert.equal(id, "wf-1"); skips++; }, abort() {}, resume() {} } });
    const state = createPanelRenderState(); panel.nodes(state);
    state.expanded.add("run:wf-1:call:key-1"); state.selected = "run:wf-1:call:key-1:skip";
    await panel.handleInput("\r", () => {}, state);
    assert.equal(skips, 0);
    assert.match(panel.renderPanel(theme, 80, state, 20).join("\n"), /return null/);
    await panel.handleInput("\r", () => {}, state);
    assert.equal(skips, 0, "Cancel is selected by default");
    await panel.handleInput("\r", () => {}, state);
    await panel.handleInput("j", () => {}, state);
    view.calls[0].status = "completed";
    await panel.handleInput("\r", () => {}, state);
    assert.equal(skips, 0);
    assert.match(state.error!, /no longer available/);
    view.calls[0].status = "running"; state.selected = "run:wf-1:call:key-1:skip";
    await panel.handleInput("\r", () => {}, state); await panel.handleInput("j", () => {}, state); await panel.handleInput("\r", () => {}, state);
    assert.equal(skips, 1);
  });
  it("provides Abort only live and Resume only for recoverable runs", async () => {
    for (const status of ["running", "completed", "failed", "aborted", "interrupted"] as const) {
      const state = createPanelRenderState();
      const panel = panelFor([run({ status })]);
      const actions = panel.nodes(state).filter(n => n.kind === "action").map(n => n.action);
      assert.deepEqual(actions, status === "running" ? ["abort"] : status === "completed" ? [] : ["resume"]);
    }
  });
  it("shows errors inline and preserves selection when tasks appear", async () => {
    const view = run();
    const panel = panelFor([view], { callbacks: { focus: async () => ({ error: "Session unavailable" }), skip() {}, abort() {}, resume() {} } });
    const state = createPanelRenderState(); panel.nodes(state); state.expanded.add(state.selected!);
    await panel.handleInput("l", () => {}, state);
    await panel.handleInput("\r", () => { throw new Error("must not close"); }, state);
    assert.match(panel.renderPanel(theme, 70, state, 20).join("\n"), /Session unavailable/);
    const selection = state.selected;
    view.calls.unshift(call({ callKey: "new" })); panel.nodes(state);
    assert.equal(state.selected, selection);
  });
  it("fits narrow, short and long CJK frames and keeps the selected row visible", () => {
    const calls = Array.from({ length: 80 }, (_, i) => call({ callKey: String(i), label: `验证非常长的路径-${i}`, error: i === 79 ? "error ".repeat(100) : undefined }));
    const panel = panelFor([run({ calls })]);
    for (const width of [30, 40, 60, 100]) for (const height of [8, 12, 30]) {
      const state = createPanelRenderState(); panel.nodes(state); state.selected = "run:wf-1:call:79";
      const lines = panel.renderPanel(theme, width, state, height);
      assert.equal(lines.length, height);
      assert.ok(lines.every(line => visibleWidth(line) === width));
      assert.match(lines.join("\n"), /❯/);
      assert.match(lines.at(-1)!, /╯$/);
    }
  });
  it("shows complete wrapped failure text when expanded", () => {
    const panel = panelFor([run({ calls: [call({ status: "failed", error: "the agent finished without calling structured_output" })] })]);
    const state = createPanelRenderState(); panel.nodes(state); state.expanded.add("run:wf-1:call:key-1");
    assert.match(panel.renderPanel(theme, 80, state, 25).join("\n"), /structured_output/);
  });
  it("puts progress and usage in the first-layer summary", () => {
    const summary = workflowSummary(run({ calls: [call({ status: "completed" })], progress: 1, activeCount: 0, completedCount: 1 }), 100).join("\n");
    assert.match(summary, /1\/1 settled/); assert.match(summary, /1.2k tokens/); assert.match(summary, /\$0.12/);
  });
  it("freezes settled durations and retains Focus on a restored completed call", () => {
    const panel = panelFor([run({
      status: "completed", startedAtWall: 0, finishedAt: 120_000,
      calls: [call({ status: "completed", cached: true })],
    })]);
    const state = createPanelRenderState();
    panel.nodes(state);
    state.expanded.add("run:wf-1:call:key-1");
    const before = panel.renderPanel(theme, 80, state, 20).join("\n");
    const original = Date.now;
    try {
      Date.now = () => original() + 24 * 60 * 60_000;
      assert.equal(panel.renderPanel(theme, 80, state, 20).join("\n"), before);
      assert.match(before, /completed · 2m00s/);
      assert.match(before, /cached/);
      assert.match(before, /Focus/);
    } finally { Date.now = original; }
  });
  it("opens scoped disk runs and preserves tree state across reopening", async () => {
    let component: any; let options: any; let closes: (() => void)[] = [];
    const ctx = { ui: { notify() {}, custom(factory: Function, config: any) {
      options = config;
      return new Promise(resolve => {
        component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, resolve);
        closes.push(() => component.handleInput("\u001b"));
      });
    } } };
    const panel = panelFor([], { inspect: id => id === "disk" ? run({ runId: "disk" }) : null });
    const opened = panel.open(ctx, "disk");
    assert.equal(options.overlayOptions().anchor, "center");
    component.render(80);
    component.handleInput("l"); await new Promise(resolve => setImmediate(resolve));
    assert.match(component.render(80).join("\n"), /Focus/);
    closes.at(-1)!(); await opened;
    const reopened = panel.open(ctx, "disk");
    assert.match(component.render(80).join("\n"), /Focus/);
    closes.at(-1)!(); await reopened;
  });
  it("toggles with the configured shortcut and removes its raw input listener", async () => {
    let component: any;
    let listener: ((data: string) => unknown) | undefined;
    let removed = 0;
    const ctx = { ui: {
      notify() {},
      onTerminalInput(handler: (data: string) => unknown) {
        listener = handler;
        return () => { listener = undefined; removed++; };
      },
      custom(factory: Function) {
        return new Promise(resolve => {
          component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, resolve);
        });
      },
    } };
    const panel = panelFor([run()], { shortcut: "alt+w" });
    let opened = panel.toggle(ctx);
    component.render(80);
    component.handleInput("l");
    await new Promise(resolve => setImmediate(resolve));
    assert.match(component.render(80).join("\n"), /Focus/);
    assert.deepEqual(listener!("\u001bw"), { consume: true });
    await opened;
    assert.equal(removed, 1);
    opened = panel.toggle(ctx);
    assert.match(component.render(80).join("\n"), /Focus/);
    await panel.toggle(ctx);
    await opened;
    assert.equal(removed, 2);
  });
  it("keeps the global manifest in sync with documented primitives", () => {
    const names = WORKFLOW_GLOBALS.map(g => g.name);
    for (const name of ["__wfBridgeAgent", "__wfBridgePhase", "__wfBridgeLog", "__wfBridgeWorkflow", "__wfBridgeBudget"]) assert.ok(names.includes(name));
  });
});
