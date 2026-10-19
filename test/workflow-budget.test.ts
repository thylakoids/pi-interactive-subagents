/**
 * Budget accounting at the production boundaries.
 *
 * Three contracts the runtime depends on, all exercised through production code:
 *  1. `toCompletion` (wiring) charges only input + output tokens; cache reads
 *     are recorded separately and never consume the run budget.
 *  2. A fresh `start()` begins with no spend, even when an earlier run in the
 *     same manager spent tokens.
 *  3. `resume` seeds the journaled usage back into the live view, so a cached
 *     call is charged exactly once and keeps its recorded usage.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createWorkflowSubagentService } from "../pi-extension/subagents/wiring.ts";
import { deferred, fixture, script } from "./helpers/workflow.ts";

/** A production wiring service whose watch() returns scripted stats. */
function wiringUsage(stats: Record<string, number>) {
  const surface: any = {
    reservedNames: new Set<string>(),
    runningSubagents: new Map(),
    sessionSnapshot: () => ({ sessionFile: "/tmp/budget-parent.jsonl", sessionId: "budget", sessionDir: "/tmp" }),
    getArtifactDir: () => "/tmp/budget-artifacts",
    cwd: () => "/tmp",
    readNameRegistry: () => ({}),
    registerName() {},
    closeSurface() {},
    startWidgetRefresh() {},
    sessionDefaults: () => ({}),
    discoverAgents: () => ["worker"],
    isAgentAllowed: () => true,
    agentKind: () => "pi",
    focus: () => ({ ok: true }),
    resolveRunning: () => ({ error: "not running" }),
    steer: async () => ({ ok: true }),
    async launch(params: { name: string }) {
      return { id: params.name, name: params.name, sessionFile: "/tmp/budget-child.jsonl", surface: "owned-budget-surface" };
    },
    async watch() {
      return { exitCode: 0, summary: "ok", elapsed: 1, stats };
    },
  };
  return createWorkflowSubagentService(surface);
}

describe("workflow budget accounting", () => {
  it("charges only input and output tokens; cache reads stay out of the budget", async () => {
    const service = wiringUsage({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 900,
      cacheWriteTokens: 7,
      cost: 0.25,
      model: "provider/model",
    });
    const handle = await service.spawn({ agentType: "worker", name: "budget-cache", task: "task" });
    const completion = await handle.completion;

    assert.equal(completion.usage?.inputTokens, 100);
    assert.equal(completion.usage?.outputTokens, 20);
    assert.equal(completion.usage?.cacheReadTokens, 900, "cache reads are recorded, not discarded");
    assert.equal(completion.usage?.cacheWriteTokens, 7);
    assert.equal(completion.usage?.totalTokens, 120, "the budgeted total is input + output only");
  });

  it("starts a new run with no spend from an earlier run in the same manager", async (t) => {
    const f = fixture(t, () => ({ text: "ok", tokens: 800 }), { budgetTotal: 1000 });
    const first = await f.manager.start({ source: script('return await agent("a", { label: "a" });', "first-run"), args: {} });
    const firstView = await first.execute();
    assert.equal(firstView.status, "completed", firstView.error);
    assert.equal(first.budgetView().spent, 800);

    const second = await f.manager.start({
      source: script("return { spent: budget.spent(), total: budget.total };", "second-run"),
      args: {},
    });
    assert.equal(second.budgetView().spent, 0, "a fresh run must not inherit the previous spend");
    const secondView = await second.execute();
    assert.equal(secondView.status, "completed", secondView.error);
    assert.deepEqual(secondView.result, { spent: 0, total: 1000 }, "the budget ceiling is inherited, the spend is not");
  });

  it("charges a resumed run's cached call exactly once and keeps its recorded usage", async (t) => {
    const gate = deferred<void>();
    let hangSecond = true;
    const f = fixture(t, async (request) => {
      if (hangSecond && request.task.includes("second")) await gate.promise;
      return { text: "ok", tokens: request.task.includes("second") ? 100 : 300 };
    }, { budgetTotal: 1000 });

    const run = await f.manager.start({
      source: script(
        [
          'const a = await agent("first", { label: "first" });',
          'const b = await agent("second", { label: "second" });',
          "return { spent: budget.spent() };",
        ].join("\n"),
        "resume-budget",
      ),
      args: {},
    });
    const executing = run.execute();
    await f.waitForCall((call) => call.task.includes("second"));
    run.abort("budget test abort");
    const aborted = await executing;
    assert.equal(aborted.status, "aborted");
    const firstBefore = aborted.calls.find((call) => call.label === "first");
    assert.equal(firstBefore?.status, "completed");
    assert.equal(firstBefore?.usage?.totalTokens, 300, "the journal records the real usage");

    hangSecond = false;
    const resumedView = await (await f.reload().resume(run.runId)).execute();
    assert.equal(resumedView.status, "completed", resumedView.error);
    const cached = resumedView.calls.find((call) => call.label === "first");
    assert.equal(cached?.cached, true);
    assert.equal(cached?.usage?.totalTokens, 300, "the cached call keeps its usage");
    assert.deepEqual(resumedView.result, { spent: 400 }, "300 from the cached call plus 100 from the new one");
  });
});
