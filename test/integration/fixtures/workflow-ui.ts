/** Deterministic UI fixture: real Pi/tmux, no provider calls. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowPanel } from "../../../pi-extension/subagents/workflow/ui.ts";
import subagentsExtension, { __test__ } from "../../../pi-extension/subagents/index.ts";
import { seedSubagentSessionFile, writeSubagentLoadout } from "../../../pi-extension/subagents/session.ts";
import { createStatusState } from "../../../pi-extension/subagents/status.ts";
import type { WorkflowRunView } from "../../../pi-extension/subagents/workflow/types.ts";

export default function fixture(pi: any) {
  subagentsExtension(pi);
  const dir = process.env.PI_WORKFLOW_UI_FIXTURE_DIR!;
  const child = join(dir, "completed.jsonl");
  const event = (text: string) => appendFileSync(join(dir, "events"), text + "\n");
  const views: WorkflowRunView[] = [{
    runId: "wf-fixture", meta: { name: "ui-fixture", description: "UI test", phases: ["Probe", "Verify"] },
    status: "running", createdAt: Date.now(), updatedAt: Date.now(), startedAtWall: Date.now(),
    agentCount: 3, activeCount: 1, completedCount: 1, failedCount: 0, totalCount: 3, maxConcurrent: 2,
    progress: 1 / 3, usage: { totalTokens: 1234, cost: 0.12 }, scriptPath: "fixture.js", runDir: dir,
    sessionFile: join(dir, "parent.jsonl"), cwd: dir, logs: [], logsDropped: 0,
    calls: [
      { callKey: "completed", label: "probe-completed", phase: "Probe", status: "completed", agentType: "workflow-subagent", name: "fixture-completed", sessionFile: child, durationMs: 1000 },
      { callKey: "running", label: "verify-running", phase: "Verify", status: "running", agentType: "workflow-subagent", name: "fixture-running", sessionFile: child, live: { kind: "active", detail: "streaming 2s" } },
      { callKey: "queued", label: "verify-queued", phase: "Verify", status: "queued", agentType: "workflow-subagent" },
    ],
  }];
  const panel = new WorkflowPanel({
    views: () => views, isLive: id => views.some(v => v.runId === id && v.status === "running"), notify: text => event(text),
    callbacks: {
      focus: async (name, sessionFile) => {
        const result = await (globalThis as any).__pi_interactive_subagents.workflow.focus(name, sessionFile);
        event("focus:" + JSON.stringify(result)); return result;
      },
      skip: key => { views[0].calls.find(c => c.callKey === key)!.status = "skipped"; event("skip:" + key); },
      abort: () => { views[0].status = "aborted"; event("abort"); },
      resume: () => { views[0].status = "running"; event("resume"); },
    },
  });
  pi.on("session_start", (_event: any, ctx: any) => {
    mkdirSync(dir, { recursive: true });
    seedSubagentSessionFile({ mode: "lineage-only", parentSessionFile: ctx.sessionManager.getSessionFile(), childSessionFile: child, childCwd: dir });
    const timestamp = new Date().toISOString();
    appendFileSync(child, JSON.stringify({ type: "message", id: "history", parentId: null, timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "ORIGINAL_AGENT_HISTORY" }], api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } }) + "\n");
    writeSubagentLoadout(child, { agent: "workflow-subagent", toolAllowlist: "read", model: null, thinking: null,
      identity: null, systemPromptMode: null, spawnable: null, autoExit: true, cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR! });
    const agents = [{ id: "fixture", name: "verify-running", agent: "workflow-subagent", task: "", surface: "%0", startTime: Date.now(), sessionFile: "fixture", statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }) }];
    ctx.ui.setWidget("fixture-summary", () => ({ invalidate() {}, render: (width: number) => __test__.renderSubagentWidgetLines(agents as any, width, views) }));
    writeFileSync(join(dir, "ready"), "ready");
  });
  pi.registerCommand("tree-fixture", { description: "Open deterministic workflow tree", handler: async (_args: string, ctx: any) => { await panel.open(ctx); } });
  pi.registerShortcut("ctrl+alt+w", { description: "Toggle fixture tree", handler: async (ctx: any) => { await panel.toggle(ctx); } });
}
