/**
 * Nested workflow calls.
 *
 * A parent script calls a saved child workflow with `workflow(name, args)`; the
 * child runs in the same manager, shares the parent's scheduler, cancellation and
 * limits, and returns its script value to the parent. These tests drive the real
 * VM and manager with the scripted subagent boundary from test/helpers.
 *
 * Contract points covered:
 *  - a saved `<cwd>/.pi/workflows/<name>.js` runs and returns its value;
 *  - with `PI_WORKFLOW_MAX_CONCURRENT_AGENTS=1`, two nested workflows that each
 *    need an agent still finish: the nested call itself never holds an agent slot;
 *  - token budget is shared (the child sees the parent's spend before it and
 *    after its own call; the parent's final spend includes the child's usage);
 *  - aborting the parent stops the child agent it is waiting on;
 *  - a child may not start another workflow, and the grandchild never runs;
 *  - reload + resume neither repeats a completed child's side effect nor changes
 *    its value.
 *
 * Every wait is bounded: a regression must fail with a message, not hang the
 * suite. Assertions never live inside the scripted service; the fixture records
 * an assertion thrown there as a test failure instead of swallowing it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deferred, fixture, script } from "./helpers/workflow.ts";

const childSource = (body: string, meta: Record<string, unknown> = {}) =>
  'export const meta = ' + JSON.stringify({ name: "child", description: "saved child workflow", ...meta }) + "\n" + body;

/** Save a project workflow where the manager looks for it: <cwd>/.pi/workflows. */
function saveWorkflow(dir: string, name: string, source: string): void {
  mkdirSync(join(dir, ".pi", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".pi", "workflows", name + ".js"), source);
}

/** Race a promise against a timer so a stuck runtime fails instead of hanging. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, fail) => {
        timer = setTimeout(() => fail(new Error(what)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("nested workflows", () => {
  it('rejects child-local unawaited work before the parent can consume a premature result', { timeout: 5000 }, async t => {
    const gate = deferred<void>();
    t.after(() => gate.resolve());
    const f = fixture(t, async request => {
      if (request.task === 'orphan') await gate.promise;
      else gate.resolve();
      return { text: 'done' };
    });
    saveWorkflow(f.dir, 'child', childSource("agent('orphan'); return 'premature';"));
    const view = await (await f.manager.start({ source: script("const child=await workflow('child'); const follow=await agent('consumer'); return {child,follow};"), args: {} })).execute();
    assert.equal(view.status, 'failed');
    assert.match(view.error!, /child.*unawaited/i);
    assert.equal(f.calls.some(call => call.task === 'consumer'), false, 'the parent must not consume a premature child result');
    assert.ok(view.calls.every(call => call.status === 'aborted'));
  });
  it('rejects unawaited child work and cancels it', { timeout: 5000 }, async t => {
    const gate = deferred<void>();
    t.after(() => gate.resolve());
    const f = fixture(t, async () => { await gate.promise; return { text: 'late' }; });
    saveWorkflow(f.dir, 'child', childSource("return await agent('unawaited-child');"));
    const view = await (await f.manager.start({ source: script("workflow('child', {}); return 'not safely complete';"), args: {} })).execute();
    assert.equal(view.status, 'failed');
    assert.match(view.error!, /unawaited/);
    assert.equal(f.manager.running().length, 0);
    assert.ok(view.calls.every(call => call.status === 'aborted'));
  });
  it("runs a saved child workflow and returns its value to the parent", { timeout: 20_000 }, async (t) => {
    const f = fixture(t, () => ({ text: "child-ok", tokens: 1 }));
    saveWorkflow(f.dir, "child", childSource("return { answer: 21 * 2 };"));

    const manager = f.reload();
    const run = await manager.start({ source: script('return await workflow("child", {});'), args: {} });
    const view = await run.execute();

    assert.equal(view.status, "completed", view.error);
    assert.deepEqual(view.result, { answer: 42 });
  });

  it("finishes two parallel nested workflows under maxConcurrent=1 without deadlocking", { timeout: 20_000 }, async (t) => {
    const previous = process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS;
    process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS = "1";
    try {
      const f = fixture(t, (request) => ({ text: "ok:" + request.task }));
      saveWorkflow(f.dir, "child", childSource('return await agent("inside", { label: "inside" });'));

      const manager = f.reload();
      const run = await manager.start({
        source: script('return await parallel([() => workflow("child", {}), () => workflow("child", {})]);'),
        args: {},
      });
      // A nested call that took an agent slot would deadlock here: with one slot
      // the second nested script could never start its own agent.
      const view = await within(run.execute(), 5_000, "nested workflows deadlocked at maxConcurrent=1");

      assert.equal(view.status, "completed", view.error);
      assert.equal(
        f.calls.filter((call) => call.task.includes("inside")).length,
        2,
        "each nested workflow ran its own agent despite the single slot",
      );
      assert.equal((view.result as unknown[]).length, 2, "both nested workflows returned a value");
      assert.deepEqual(
        (view.result as string[]).map((value) => typeof value),
        ["string", "string"],
        "the parent received the child results, not placeholders",
      );
    } finally {
      if (previous === undefined) delete process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS;
      else process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS = previous;
    }
  });

  it("shares the parent's token budget with the child", { timeout: 20_000 }, async (t) => {
    const f = fixture(t, () => ({ text: "ok", tokens: 40 }), { budgetTotal: 200 });
    saveWorkflow(
      f.dir,
      "child",
      childSource(
        'const a = await agent("child-work", { label: "child-work" });\n' +
          "return { childSpent: budget.spent(), childTotal: budget.total };",
      ),
    );

    const manager = f.reload();
    const run = await manager.start({
      source: script(
        // Spend before the nested call: a child with its own fresh budget would
        // then report 40, while a shared one must report 80.
        'const before = await agent("pre-work", { label: "pre-work" });\n' +
          'const childResult = await workflow("child", {});\n' +
          'const after = await agent("parent-work", { label: "parent-work" });\n' +
          "return { before, childResult, parentSpent: budget.spent(), after };",
      ),
      args: {},
    });
    const view = await run.execute();

    assert.equal(view.status, "completed", view.error);
    const result = view.result as any;
    assert.equal(result.childResult.childSpent, 80, "the child sees the parent's 40 plus its own 40");
    assert.equal(result.childResult.childTotal, 200, "the child sees the parent's ceiling");
    assert.equal(result.parentSpent, 120, "the child's tokens count toward the parent budget");
  });

  it("stops the child agent when the parent is aborted", { timeout: 20_000 }, async (t) => {
    const gate = deferred<void>();
    const f = fixture(t, async (request) => {
      if (request.task.includes("hang")) await gate.promise;
      return { text: "ok" };
    });
    saveWorkflow(f.dir, "child", childSource('return await agent("hang", { label: "hang" });'));

    const manager = f.reload();
    const run = await manager.start({ source: script('return await workflow("child", {});'), args: {} });
    const executing = run.execute();
    const hangCall = await within(
      f.waitForCall((call) => call.task.includes("hang")),
      5_000,
      "the child agent never spawned",
    );
    run.abort("nested abort");
    const view = await within(executing, 10_000, "the aborted run never settled");

    assert.equal(view.status, "aborted");
    assert.ok(f.stopped.includes(hangCall.name), "the agent the child waited on must be stopped");
    assert.equal(view.result ?? null, null, "the script never receives a partial nested result");
  });

  it("refuses a child workflow that starts another workflow, without running it", { timeout: 20_000 }, async (t) => {
    const f = fixture(t, () => ({ text: "ok" }));
    // The grandchild has a side effect of its own: if the guard moved after
    // execution started, this agent would show up in f.calls.
    saveWorkflow(f.dir, "grandchild", childSource('return await agent("grand-work", { label: "grand-work" });'));
    saveWorkflow(f.dir, "child", childSource('return await workflow("grandchild", {});'));

    const manager = f.reload();
    const run = await manager.start({ source: script('return await workflow("child", {});'), args: {} });
    const view = await run.execute();

    const text = JSON.stringify(view.error ?? view.result ?? null);
    assert.match(text, /nested|depth|not supported/i, "a nested workflow must not start its own workflow");
    assert.equal(
      f.calls.filter((call) => call.task.includes("grand-work")).length,
      0,
      "the grandchild workflow must never execute",
    );
  });

  it("does not replay a completed child's side effects after reload and resume", { timeout: 20_000 }, async (t) => {
    const gate = deferred<void>();
    let hang = true;
    const f = fixture(t, async (request) => {
      if (hang && request.task.includes("parent-after")) await gate.promise;
      return { text: "ok" };
    });
    saveWorkflow(f.dir, "child", childSource('return await agent("child-work", { label: "child-work" });'));

    const manager = f.reload();
    const run = await manager.start({
      source: script(
        'const c = await workflow("child", {});\n' +
          'const d = await agent("parent-after", { label: "parent-after" });\n' +
          "return { c, d };",
      ),
      args: {},
    });
    const executing = run.execute();
    await within(f.waitForCall((call) => call.task.includes("parent-after")), 5_000, "the parent agent never spawned");
    run.abort("abort before resume");
    const aborted = await executing;
    assert.equal(aborted.status, "aborted");
    assert.equal(f.calls.filter((call) => call.task.includes("child-work")).length, 1);

    hang = false;
    const resumedView = await (await f.reload().resume(run.runId)).execute();
    assert.equal(resumedView.status, "completed", resumedView.error);
    assert.equal(
      f.calls.filter((call) => call.task.includes("child-work")).length,
      1,
      "the completed child workflow must not run its side effect again",
    );
    assert.deepEqual(
      resumedView.result,
      { c: "ok", d: "ok" },
      "the resumed run returns the child value and the retried parent value",
    );
  });

  it("applies the child's meta.agent to its agents", { timeout: 20_000 }, async (t) => {
    const previous = process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS;
    process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS = "1";
    try {
      const f = fixture(t, (request) => ({ text: "ok:" + request.task }));
      saveWorkflow(
        f.dir,
        "child",
        childSource('return await agent("inside", { label: "inside" });', { agent: "scout" }),
      );

      const manager = f.reload();
      const run = await manager.start({
        source: script(
          'const [a, b] = await parallel([() => agent("outer", { label: "outer" }), () => workflow("child", {})]);\n' +
            "return { a, b };",
        ),
        args: {},
      });
      const view = await run.execute();

      assert.equal(view.status, "completed", view.error);
      assert.deepEqual(view.result, { a: "ok:outer", b: "ok:inside" }, "both branches returned their values");
      const inside = f.calls.find((call) => call.task.includes("inside"));
      assert.equal(inside?.agentType, "scout", "the child workflow's meta.agent applies to its agents");
    } finally {
      if (previous === undefined) delete process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS;
      else process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS = previous;
    }
  });
});
