/** Real manager, VM, journal and Pi/tmux; only model responses are scripted. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowManager } from "../../../pi-extension/subagents/workflow/manager.ts";
import { WorkflowPanel } from "../../../pi-extension/subagents/workflow/ui.ts";
import subagentsExtension, { __test__ } from "../../../pi-extension/subagents/index.ts";
import { registerName, seedSubagentSessionFile, readSubagentLoadout, writeSubagentLoadout } from "../../../pi-extension/subagents/session.ts";
import { createStatusState } from "../../../pi-extension/subagents/status.ts";
import type { WorkflowRunView } from "../../../pi-extension/subagents/workflow/types.ts";

export default function fixture(pi: any) {
  subagentsExtension(pi);
  const dir = process.env.PI_WORKFLOW_UI_FIXTURE_DIR!;
  const child = join(dir, "completed.jsonl");
  const event = (text: string) => appendFileSync(join(dir, "events"), text + "\n");
  const views: WorkflowRunView[] = [];
  let run: Awaited<ReturnType<WorkflowManager["start"]>>;
  const pending = new Map<string, (value: any) => void>();
  const manager = new WorkflowManager({
    cwd: dir, agentDir: dir, baseDir: join(dir, "workflows"),
    sessionFile: join(dir, "parent.jsonl"), sessionId: "ui-fixture",
    service: {
      isAvailable: () => ({ ok: true }),
      allowedAgents: () => ({ allowed: ["worker"], unknown: name => name !== "worker" }),
      agentKind: () => "pi", sessionDefaults: () => ({}), takenNames: () => new Set(),
      status: () => undefined, steer: async () => ({ ok: true }), focus: () => ({ ok: true }),
      stop: name => { pending.get(name)?.({ exitCode: 1, summary: "", elapsedMs: 0, error: "stopped" }); pending.delete(name); },
      async spawn(request) {
        event("spawn:" + request.task);
        const completion = request.task === "completed"
          ? Promise.resolve({ exitCode: 0, summary: "done", elapsedMs: 1000,
              usage: { totalTokens: 1234, cost: 0.12 } })
          : new Promise<any>(resolve => pending.set(request.name, resolve));
        return { id: request.name, name: request.name, sessionFile: child, completion };
      },
    },
  });
  const panel = new WorkflowPanel({
    views: () => { views[0] = run.view(); return views; }, isLive: id => views.some(v => v.runId === id && v.status === "running"), notify: text => event(text),
    callbacks: {
      focus: async (name, sessionFile) => {
        const result = await (globalThis as any).__pi_interactive_subagents.workflow.focus(name, sessionFile);
        event("focus:" + JSON.stringify(result)); return result;
      },
      skip: key => { if (run.skip(key)) event("skip:running"); },
      abort: () => { run.abort("UI confirmation"); writeFileSync(join(dir, "aborted-view.json"), JSON.stringify(run.view())); event("abort"); },
      resume: async () => { run = await manager.resume(run.runId); void run.execute(); event("resume"); },
    },
  });
  pi.on("session_start", async (_event: any, ctx: any) => {
    mkdirSync(dir, { recursive: true });
    seedSubagentSessionFile({ mode: "lineage-only", parentSessionFile: ctx.sessionManager.getSessionFile(), childSessionFile: child, childCwd: dir });
    const timestamp = new Date().toISOString();
    appendFileSync(child, JSON.stringify({ type: "message", id: "history", parentId: null, timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "ORIGINAL_AGENT_HISTORY" }], api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } }) + "\n");
    writeSubagentLoadout(child, { agent: "workflow-subagent", toolAllowlist: "read", model: null, thinking: null,
      identity: null, systemPromptMode: null, spawnable: null, autoExit: true, cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR! });
    const other = join(dir, "second.jsonl");
    seedSubagentSessionFile({ mode: "lineage-only", parentSessionFile: ctx.sessionManager.getSessionFile(), childSessionFile: other, childCwd: dir });
    appendFileSync(other, JSON.stringify({ type:"message", id:"second-history", parentId:null, timestamp,
      message:{role:"assistant",content:[{type:"text",text:"SECOND_AGENT_HISTORY"}],api:"anthropic-messages",provider:"anthropic",model:"claude-sonnet-4-5",
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()} })+"\n");
    writeSubagentLoadout(other, readSubagentLoadout(child)!);
    const registry = join(ctx.sessionManager.getSessionDir(), "artifacts", ctx.sessionManager.getSessionId());
    registerName(registry, "saved-original", { sessionFile:child });
    registerName(registry, "saved-second", { sessionFile:other });
    // A previous parent may have died before consuming this exit report.
    writeFileSync(child + '.exit', JSON.stringify({ type: 'error', errorMessage: 'STALE_PREVIOUS_EXIT' }));
    run = await manager.start({ source: `export const meta = { name: 'ui-fixture', description: 'UI test', phases: ['Probe', 'Verify'] }
      await agent('completed', { label: 'probe-completed', phase: 'Probe' });
      await parallel(['running', 'queued'].map(task => () => agent(task, { label: 'verify-' + task, phase: 'Verify' })));
    `, args: {} });
    void run.execute();
    const deadline = Date.now() + 10_000;
    while (run.view().calls.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (run.view().calls.length !== 3) throw new Error("Workflow did not reach the queued call");
    const agents = [{ id: "fixture", name: "verify-running", agent: "workflow-subagent", task: "", surface: "%0", startTime: Date.now(), sessionFile: "fixture", statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }) }];
    ctx.ui.setWidget("fixture-summary", () => ({ invalidate() {}, render: (width: number) => __test__.renderSubagentWidgetLines(agents as any, width, [run.view()]) }));
    writeFileSync(join(dir, "ready"), "ready");
  });
  pi.on("session_shutdown", () => manager.abortAll("fixture shutdown"));
  pi.registerCommand("tree-fixture", { description: "Open deterministic workflow tree", handler: async (_args: string, ctx: any) => { await panel.open(ctx); } });
  pi.registerShortcut("ctrl+alt+w", { description: "Toggle fixture tree", handler: async (ctx: any) => { await panel.toggle(ctx); } });
}
