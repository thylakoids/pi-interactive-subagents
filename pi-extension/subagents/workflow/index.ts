/**
 * Workflow extension entry point.
 *
 * Registers the model-facing `workflow` tool, the `/workflow` command, the
 * shortcut and the main-window panel, and owns the manager instance for the
 * session. The heavy lifting lives in the sibling modules:
 *
 *   script.ts   source parsing + meta validation
 *   runner.ts   QuickJS sandbox and the script-visible primitives
 *   manager.ts  scheduling, journal, resume, limits
 *   ui.ts       widget + observability panel
 *   wiring.ts   the interactive-subagent service this runtime drives
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { join } from "node:path";
import { WorkflowManager } from "./manager.ts";
import { WorkflowPanel, formatElapsed, formatTokens } from "./ui.ts";
import { WorkflowScriptError, readScriptFile, resolveSavedScriptPath } from "./script.ts";
import { WORKFLOW_GLOBAL_DECLARATIONS } from "./runner.ts";
import { STRUCTURED_OUTPUT_EXTENSION } from "../wiring.ts";
import type { WorkflowRunView, WorkflowSubagentService } from "./types.ts";

export interface WorkflowExtensionOptions {
  service: WorkflowSubagentService;
  widget?: { bind(views: () => WorkflowRunView[], shortcut: string): void; refresh(): void };
  /** Shortcut id, shown in /hotkeys. */
  shortcut?: string;
}

const TOOL_DESCRIPTION = `Run a workflow: a JavaScript program that orchestrates subagents deterministically.

Each \`agent()\` call starts a real interactive subagent in its own terminal pane, so you can watch, message, or stop any of them while the workflow runs. The workflow executes in the background in a sandboxed QuickJS VM: this tool returns immediately with a run id, and you are woken with a notification when the run settles. Progress is visible in the main window (\`/workflow\`).

WHEN TO USE
- Work that decomposes into many independent sub-tasks (reviews across dimensions, per-file migrations, multi-source research).
- Work whose next step depends on what earlier subagents found, but the *shape* of that dependency is knowable in advance.
- Long fan-outs where the main context should not hold every intermediate result.

WHEN NOT TO USE
- A single subagent, or a handful whose results you will read yourself: use the \`subagent\` tool.
- Exploratory work where you cannot yet describe the control flow.
- Tasks where a scripted fan-out would burn far more tokens than doing the work inline — the user pays for every agent.

Only reach for this tool when the user has opted in: they asked for a workflow, orchestration or a
fan-out in their own words, a skill or slash command says to use it, or a workflow is already
running. Otherwise describe what a workflow would do and let the user decide. Each agent is a real
pi session the user pays for, so keep a script to roughly ten agents unless the task genuinely
needs more.

THE SCRIPT
Plain JavaScript (not TypeScript), executed as an async function body — \`await\` and \`return\` work. It must start with a pure literal:

  export const meta = { name: 'review-changes', description: 'Review changed files, verify findings', phases: ['Review', 'Verify'] }

The script sees exactly these globals:

${WORKFLOW_GLOBAL_DECLARATIONS}

There is no filesystem, network, timers, \`require\`, \`process\`, \`Date.now()\` or \`Math.random()\` — the run must be replayable, so time and randomness come from the run, not from the script. Use \`agent({ schema })\` for structured results (the subagent must return them through the structured_output tool) and \`args\` for everything the run needs to know.

DEFAULT TO pipeline
\`pipeline(items, stage1, stage2, ...)\` runs each item through all stages independently — no barrier between stages, so a fast item starts stage 2 while a slow one is still in stage 1. Reach for \`parallel\` only when the next step genuinely needs *all* previous results (dedup across the whole set, a cross-item comparison, an early exit on "nothing found").

Errors: a failed or throwing item in \`parallel\`/\`pipeline\` resolves to \`null\` for that item only, and the other items keep running. A direct \`await agent(...)\` rejects, so wrap it in \`try/catch\` or \`.catch()\` when a failure is tolerable.

RESUME
The run's calls are journaled by content, so re-running the same script with the same
args replays completed calls instead of redoing them: launch again with
\`workflow({ action: 'resume', runId })\`, or just start the same workflow again — a \`start\`
already reuses completed calls from the previous run of the same workflow *with the same
args*. Edit a call (its label, prompt, schema, agent, model or effort) and only that call
re-runs; identical calls are told apart, so three identical refuters are three samples.
Pass \`reuse: 'none'\` to force a run that shares nothing. Every run writes its script and
journal under \`<sessionDir>/artifacts/<sessionId>/workflows/<runId>/\`; the returned
\`scriptPath\` is a real file you can edit and run again with \`name: <that path>\`.

LIMITS
- Concurrent agents: min(16, CPUs − 2) per run, overridable with
  \`PI_WORKFLOW_MAX_CONCURRENT_AGENTS\`.
- One parallel/pipeline call: at most 4096 items. One run: at most 1000 agents.
- With \`PI_WORKFLOW_TOKEN_BUDGET\` set, the run stops once that many tokens are spent.

A failed or dead agent resolves to \`null\` for that call only — \`parallel\` and \`pipeline\`
already do this, and a bare \`await agent(...)\` behaves the same way, so a script that needs
to react to a failure tests the value rather than wrapping every call in try/catch. A
*malformed* call (unknown agent, bad option, unsatisfiable schema) still throws.

Nested workflows are not supported: \`workflow()\` is declared but always throws, so express
child steps inline instead.

Both inline scripts (\`script\`) and saved ones (\`name\`) are supported; a saved workflow is looked up in \`.pi/workflows/<name>.js\` and then \`$PI_CODING_AGENT_DIR/workflows/<name>.js\`.`;

const WorkflowParams = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("resume"), Type.Literal("status")], {
    description:
      "start a new run (default), resume a previous run from its journal, or report run status without changing anything",
  }),
  script: Type.Optional(
    Type.String({
      description:
        "Inline workflow source for action=start. Plain JavaScript; must begin with a pure literal `export const meta = {...}`.",
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "Saved workflow name or path (alternative to `script` for action=start)." }),
  ),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Data the script reads as `args`. Must be JSON-serializable.",
    }),
  ),
  runId: Type.Optional(
    Type.String({ description: "Run id: required for action=resume, optional for action=status (omit for all runs)." }),
  ),
  reuse: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("none")], {
      description:
        "action=start only. 'auto' (default) replays completed calls from the previous run of the " +
        "same workflow with the same args; 'none' forces every call to run again.",
    }),
  ),
});

export function registerWorkflowExtension(pi: ExtensionAPI, options: WorkflowExtensionOptions): void {
  const { service } = options;
  let manager: WorkflowManager | null = null;
  let panel: WorkflowPanel | null = null;
  let latestCtx: ExtensionContext | null = null;
  /** Notification guard: the `pi` api throws once the session is gone. */
  let sessionLive = true;

  const ensure = (ctx: ExtensionContext): { manager: WorkflowManager; panel: WorkflowPanel } => {
    latestCtx = ctx;
    if (manager && panel) return { manager, panel };

    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionDir = ctx.sessionManager.getSessionDir();

    manager = new WorkflowManager({
      baseDir: join(sessionDir, "artifacts", sessionId),
      cwd: ctx.cwd,
      sessionFile: sessionFile ?? "",
      sessionId,
      agentDir: process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"),
      service,
      // A token budget for workflow runs, so a script can scale its own depth.
      // There is no per-turn directive in pi, so the opt-in is explicit:
      // PI_WORKFLOW_TOKEN_BUDGET=<tokens>. Unset means `budget.total === null`
      // and `remaining()` reports Infinity.
      budgetTotal: readTokenBudget(),
      structuredOutputExtension: STRUCTURED_OUTPUT_EXTENSION,
      // A run can settle after the session ended (aborted runs included), and
      // the notification is the one call that cannot be made defensively: the
      // api throws on a stale session rather than failing quietly.
      onSettled: (view) => {
        if (sessionLive) {
          options.widget?.refresh();
          publishRunSettled(pi, view);
        }
      },
    });

    panel = new WorkflowPanel({
      shortcut: options.shortcut,
      callbacks: {
        focus: (name, sessionFile) => service.focus(name, sessionFile),
        skip: (callKey, runId) => {
          if (!manager?.get(runId)?.skip(callKey)) throw new Error("That call already settled.");
        },
        abort: (runId) => {
          if (!manager?.abort(runId)) throw new Error("That workflow already settled.");
        },
        resume: async (runId) => { await startRun({ action: "resume", runId }, latestCtx ?? ctx); },
      },
      views: () => manager?.list() ?? [],
      // A run left by an earlier process is not in `list()`; the panel reads it
      // from disk so `/workflow <runId>` agrees with `action: 'status'`.
      inspect: (runId) => manager?.inspect(runId) ?? null,
      isLive: (runId) => {
        const run = manager?.get(runId);
        return Boolean(run && !run.isFinished());
      },
      notify: (message, type) => latestCtx?.ui.notify(message, type ?? "info"),
    });
    options.widget?.bind(() => manager?.list() ?? [], options.shortcut ?? "ctrl+alt+w");

    return { manager, panel };
  };

  const startRun = async (
    params: {
      action: string;
      script?: string;
      name?: string;
      args?: Record<string, unknown>;
      runId?: string;
      reuse?: "auto" | "none";
    },
    ctx: ExtensionContext,
  ): Promise<WorkflowRunView> => {
    const { manager: activeManager } = ensure(ctx);
    const availability = service.isAvailable();
    if (params.action === "start" && !availability.ok) {
      throw new WorkflowScriptError(`Cannot run a workflow: ${availability.reason}.`);
    }

    if (params.action === "status") {
      if (params.runId) {
        const view = activeManager.inspect(params.runId);
        if (!view) throw new WorkflowScriptError(`No workflow run ${params.runId}.`);
        return view;
      }
      const views = activeManager.list();
      if (views.length === 0) throw new WorkflowScriptError("No workflow runs in this session yet.");
      return views[views.length - 1];
    }

    let run;
    if (params.action === "resume") {
      if (!params.runId) throw new WorkflowScriptError("action=resume requires runId.");
      run = await activeManager.resume(params.runId, {
        ...(params.args === undefined ? {} : { args: params.args }),
        ...(params.script === undefined ? {} : { source: params.script }),
      });
    } else {
      run = await activeManager.start({
        source: resolveSource(params, ctx),
        args: params.args ?? {},
        ...(params.reuse ? { reuse: params.reuse } : {}),
      });
    }

    void run.execute();
    options.widget?.refresh();
    return run.view();
  };

  const resolveSource = (params: { script?: string; name?: string }, ctx: ExtensionContext): string => {
    if (params.script?.trim()) return params.script;
    if (!params.name?.trim()) {
      throw new WorkflowScriptError(
        "Provide `script` (inline source) or `name` (a saved workflow in .pi/workflows/<name>.js).",
      );
    }
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
    const path = resolveSavedScriptPath(params.name, { cwd: ctx.cwd, agentDir });
    if (!path) {
      throw new WorkflowScriptError(
        `No saved workflow "${params.name}" in ${join(ctx.cwd, ".pi", "workflows")} or ${join(agentDir, "workflows")}.`,
      );
    }
    return readScriptFile(path);
  };

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: TOOL_DESCRIPTION,
    promptSnippet:
      "Run a JavaScript workflow that orchestrates subagents in parallel/pipeline stages; returns immediately with a run id and notifies on completion.",
    promptGuidelines: [
      "Prefer pipeline() over parallel() unless the next stage genuinely needs every prior result.",
      "Give each agent() a short `label`; it is the panel's row title and part of the resume key.",
      "Use `schema` when you will branch on the result; free text cannot be parsed reliably.",
      "Keep per-agent prompts self-contained: subagents do not see this conversation.",
    ],
    parameters: WorkflowParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const view = await startRun(params, ctx);
        return {
          content: [{ type: "text" as const, text: formatStartMessage(params.action, view) }],
          details: {
            action: params.action,
            runId: view.runId,
            status: view.status,
            progress: view.progress,
            agents: view.totalCount,
            runDir: view.runDir,
            scriptPath: view.scriptPath,
          },
        };
      } catch (error: any) {
        const message = error?.message ?? String(error);
        return {
          content: [{ type: "text" as const, text: `Workflow error: ${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
    // The call line names the workflow, not its source: a workflow is a saved
    // or inline script, and dumping the script into the transcript buries the
    // conversation it belongs to.
    renderCall(args, theme) {
      return new Text(renderWorkflowCall(args, theme), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as WorkflowToolDetails | undefined;
      if (details?.error) {
        return new Text(`${INDENT}${theme.fg("dim", "⎿")}  ${theme.fg("error", String(details.error))}`, 0, 0);
      }
      const summary = `${details?.status ?? "started"} · ${details?.agents ?? 0} agents planned`;
      const head =
        `${INDENT}${theme.fg("dim", "⎿")}  ${theme.fg("dim", summary)}` +
        (expanded ? "" : theme.fg("muted", "  (ctrl+o to expand)"));
      if (!expanded) return new Text(head, 0, 0);
      const lines = [head];
      if (details?.runId) lines.push(`${INDENT}   ${theme.fg("dim", `run    ${details.runId}`)}`);
      if (details?.scriptPath) lines.push(`${INDENT}   ${theme.fg("dim", `script ${details.scriptPath}`)}`);
      if (details?.runDir) lines.push(`${INDENT}   ${theme.fg("dim", `dir    ${details.runDir}`)}`);
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // A settled run posts itself into the transcript; without a renderer that
  // entry is the raw notification text, which makes the end of a long run the
  // noisiest thing in the session.
  pi.registerMessageRenderer<WorkflowSettledDetails>("workflow_result", (message, { expanded }, theme) =>
    new Text(renderSettledMessage(message.details, expanded, theme), 0, 0),
  );

  pi.registerCommand("workflow", {
    description: "Watch workflow runs, or report them as text: /workflow [runId]",
    handler: async (args, ctx) => {
      const { panel: activePanel, manager: activeManager } = ensure(ctx as unknown as ExtensionContext);
      const runId = args.trim();
      const tui = isTui(ctx);
      const report = runId ? activeManager.inspect(runId) : null;
      if (tui) {
        // The overlay scopes itself to one run; without a run id it shows them all.
        await activePanel.open(ctx as any, runId || undefined);
        return;
      }
      if (runId && !report) {
        ctx.ui.notify(`No workflow run ${runId} in this session.`, "warning");
        return;
      }
      ctx.ui.notify(report ? summarise(report) : activePanel.textReport(), "info");
    },
  });

  // `ctrl+alt+w` is also pi-btw's default focus shortcut, and last
  // registration wins, so the two cannot coexist silently. btw exposes
  // `PI_BTW_FOCUS_KEYS` to re-bind itself; with `alt+/,super+/` set there
  // (see ~/.zshrc) this key is ours alone. Override per-install with `shortcut`.
  pi.registerShortcut((options.shortcut ?? "ctrl+alt+w") as Parameters<typeof pi.registerShortcut>[0], {
    description: "Toggle workflow panel",
    handler: async (ctx) => {
      const { panel: activePanel } = ensure(ctx as unknown as ExtensionContext);
      if (isTui(ctx)) {
        await activePanel.toggle(ctx as any);
        return;
      }
      ctx.ui.notify(activePanel.textReport(), "info");
    },
  });

  pi.on("session_shutdown", () => {
    // Anything still in flight settles after this point, when every handle
    // this extension holds is stale: drop the ctx, refuse to notify, and stop
    // the agents so no pane is left running with nobody listening.
    sessionLive = false;
    latestCtx = null;
    // The overlay's refresh timer dies with the session even if the TUI never
    // got to dispose the component.
    panel?.dispose();
    manager?.abortAll("session ended");
  });

  // A reload — or a second session in the same process — replaces the session
  // the way a shutdown does, and the extension instance survives it; without
  // this the next session would start with the ctx dropped and notifications
  // disabled.
  pi.on("session_start", (_event, ctx) => {
    sessionLive = true;
    latestCtx = ctx;
  });
}

/**
 * Whether terminal-only UI (the overlay) is available.
 *
 * Read structurally rather than from the type: the plugin compiles against an
 * older SDK revision whose `ExtensionContext` predates `mode`, while the
 * installed runtime provides it.
 */
/**
 * Optional per-run token budget, from `PI_WORKFLOW_TOKEN_BUDGET`.
 * Invalid or non-positive values are ignored rather than guessed at.
 */
function readTokenBudget(): number | null {
  const raw = process.env.PI_WORKFLOW_TOKEN_BUDGET;
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isTui(ctx: unknown): boolean {
  const candidate = ctx as { mode?: unknown; hasUI?: unknown };
  if (typeof candidate.mode === "string") return candidate.mode === "tui";
  return candidate.hasUI === true;
}

function formatStartMessage(action: string, view: WorkflowRunView): string {
  if (action === "status") {
    const lines = [
      `Workflow ${view.meta.name} — ${view.status} (${Math.round(view.progress * 100)}%)`,
      `agents: ${view.activeCount} running, ${view.completedCount} done, ${view.failedCount} failed of ${view.totalCount}`,
      `run:     ${view.runId}`,
      `journal: ${view.runDir}/journal.jsonl`,
    ];
    const unresolved = unresolvedLabels(view);
    if (unresolved.length > 0) {
      lines.push(`no value from ${unresolved.length} call(s):`);
      for (const label of unresolved) lines.push(`  · ${label}`);
    }
    return lines.join("\n");
  }
  const verb = action === "resume" ? "resumed" : "started";
  // Only claim a plan when there is one: a script whose first calls are still
  // being issued would otherwise be announced as "0 agents planned".
  const planned = view.totalCount > 0 ? `agents: ${view.totalCount} planned so far, up to ` : "agents: up to ";
  const reuse = view.resumedFrom
    ? `\nreusing: completed calls from run ${view.resumedFrom} — only new or edited calls run`
    : "";
  return (
    `Workflow "${view.meta.name}" ${verb} in the background.\n\n` +
    `run:    ${view.runId}\n` +
    `script: ${view.scriptPath}${reuse}\n` +
    `${planned}${view.maxConcurrent} running at once\n\n` +
    `Each agent runs in its own pane. Do NOT poll or fabricate results — you will be woken when the run settles. ` +
    `The user can open /workflow to watch it.`
  );
}

function summarise(view: WorkflowRunView): string {
  const lines = [`${view.meta.name} — ${view.status} (${Math.round(view.progress * 100)}%)`];
  for (const call of view.calls) {
    lines.push(`${call.status.padEnd(9)} ${call.label}${call.error ? ` — ${call.error}` : ""}`);
  }
  return lines.join("\n");
}

/** Indent of a tool row's own continuation lines, under the `●` call line. */
const INDENT = "  ";

/** First line of a possibly multi-line message, trimmed to something short. */
function firstLine(text: string, limit = 60): string {
  const line = (text.split("\n")[0] ?? "").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** Details carried by the `workflow` tool's result, for its renderers. */
interface WorkflowToolDetails {
  error?: string;
  action?: string;
  runId?: string;
  status?: string;
  progress?: number;
  agents?: number;
  runDir?: string;
  scriptPath?: string;
}

/** Details carried by the `workflow_result` message the run posts when it ends. */
export interface WorkflowSettledDetails {
  runId: string;
  name: string;
  status: string;
  elapsedMs: number;
  agentCount: number;
  completedCount: number;
  failedCount: number;
  /** Calls that settled with no value at all — a failed, skipped or dead agent. */
  emptyCount: number;
  /** Labels of the calls that did not return a value, for a concrete report. */
  unresolved: string[];
  scriptPath: string;
  runDir: string;
  usage: WorkflowRunView["usage"];
  result?: unknown;
  /** True when `result` was cut short for display. */
  resultTruncated?: boolean;
}

/**
 * The name of an inline script, read from its `meta` literal.
 *
 * `parseScript` would be stricter, but a renderer must not throw on a script
 * the tool is about to reject anyway; a name that cannot be read is not one.
 */
function inlineName(script: string | undefined): string | undefined {
  const match = script ? /name\s*:\s*['"`]([^'"`]+)['"`]/.exec(script) : null;
  return match?.[1];
}

/** `● Workflow(review-changes)` — what the tool call looks like as it starts. */
function renderWorkflowCall(args: { action?: string; script?: string; name?: string; runId?: string }, theme: any): string {
  const head = `${theme.fg("accent", "●")} ${theme.fg("toolTitle", theme.bold("Workflow"))}`;
  if (args.action === "resume") return `${head}${theme.fg("dim", `(${args.runId ?? "resume"})`)}`;
  if (args.action === "status") return `${head}${theme.fg("dim", "(status)")}`;
  return `${head}${theme.fg("dim", `(${args.name?.trim() || inlineName(args.script) || "inline"})`)}`;
}

/**
 * `● review-changes · completed in 2m04s` — the run's own transcript entry.
 *
 * Collapsed it is two lines; expanding it adds where the run lives and the
 * script's return value, which is the part a reader comes back for.
 */
function renderSettledMessage(details: WorkflowSettledDetails | undefined, expanded: boolean, theme: any): string {
  if (!details) return "";
  const settled = details.status === "completed";
  const head =
    `${theme.fg("accent", "●")} ${theme.bold(details.name)} ` +
    theme.fg(settled ? "dim" : "error", `· ${details.status} in ${formatElapsed(details.elapsedMs)}`);
  const counts = [`${details.agentCount} agents`, `${details.completedCount} done`];
  if (details.failedCount) counts.push(`${details.failedCount} failed`);
  if (details.usage?.totalTokens) counts.push(`${formatTokens(details.usage.totalTokens)} tokens`);
  if (details.usage?.cost) counts.push(`$${details.usage.cost.toFixed(2)}`);
  const lines = [head, `${INDENT}${theme.fg("dim", `⎿  ${counts.join(" · ")}`)}`];
  if (!expanded) {
    lines.push(`${INDENT}   ${theme.fg("muted", "(ctrl+o to expand result)")}`);
    return lines.join("\n");
  }
  lines.push(`${INDENT}   ${theme.fg("dim", `run    ${details.runId}`)}`);
  lines.push(`${INDENT}   ${theme.fg("dim", `script ${details.scriptPath}`)}`);
  if (details.result !== undefined) {
    const json = JSON.stringify(details.result, null, 2).slice(0, RESULT_DISPLAY_LIMIT);
    lines.push(`${INDENT}   ${theme.fg("dim", "result")}`, ...json.split("\n").map((line) => `${INDENT}   ${line}`));
    if (details.resultTruncated) {
      lines.push(`${INDENT}   ${theme.fg("muted", `… truncated — full result in ${details.runDir}/output.json`)}`);
    }
  }
  // A call that resolved to null is the difference between "eight results" and
  // "five results and three silences"; counts alone read as the former.
  const unresolved = details.unresolved ?? [];
  if (unresolved.length > 0) {
    lines.push(`${INDENT}   ${theme.fg("muted", `${unresolved.length} call(s) returned no value`)}`);
    for (const label of unresolved.slice(0, 8)) lines.push(`${INDENT}     ${theme.fg("dim", `· ${label}`)}`);
    if (unresolved.length > 8) {
      lines.push(`${INDENT}     ${theme.fg("dim", `· … ${unresolved.length - 8} more`)}`);
    }
  }
  return lines.join("\n");
}

/** How much of a run's return value the transcript shows before pointing at the file. */
const RESULT_DISPLAY_LIMIT = 4000;

/** Calls that settled without a usable value, by label. */
function unresolvedLabels(view: WorkflowRunView): string[] {
  return view.calls
    .filter((call) => call.status !== "completed" || call.error)
    .map((call) => `${call.label} (${call.status}${call.error ? `: ${firstLine(call.error)}` : ""})`);
}

function publishRunSettled(pi: ExtensionAPI, view: WorkflowRunView): void {
  const usage = view.usage.totalTokens ? ` · ${view.usage.totalTokens} tokens` : "";
  const unresolved = unresolvedLabels(view);
  const lines = [
    `Workflow "${view.meta.name}" ${view.status} — ${view.completedCount}/${view.totalCount} agents completed${usage}`,
  ];
  if (view.error) lines.push(`error: ${view.error}`);
  // A count of completed calls hides an agent that died: say which calls came
  // back empty, so "8/8" is never read as eight usable results.
  if (unresolved.length > 0) {
    lines.push(`no value from ${unresolved.length} call(s):`);
    for (const label of unresolved) lines.push(`  · ${label}`);
  }
  lines.push(`run:     ${view.runId}`);
  lines.push(`script:  ${view.scriptPath}`);
  // The journal is where the actual per-call values live, including ones that
  // are legitimately empty — a cached value may itself be null.
  lines.push(`journal: ${view.runDir}/journal.jsonl`);
  for (const call of view.calls) {
    if (call.sessionFile) lines.push(`agent:   ${call.label} → ${call.sessionFile}`);
  }
  lines.push(
    `Inspect with workflow({ action: "status", runId: "${view.runId}" }) or resume with ` +
      `workflow({ action: "resume", runId: "${view.runId}" })`,
  );
  let resultTruncated = false;
  if (view.status === "completed" && view.result !== undefined) {
    const json = JSON.stringify(view.result, null, 2);
    resultTruncated = json.length > RESULT_DISPLAY_LIMIT;
    lines.push(
      "",
      "Result:",
      resultTruncated
        ? `${json.slice(0, RESULT_DISPLAY_LIMIT)}\n… (truncated; full result in ${view.runDir}/output.json)`
        : json,
    );
  }

  pi.sendMessage(
    {
      customType: "workflow_result",
      display: true,
      content: lines.join("\n"),
      details: {
        runId: view.runId,
        name: view.meta.name,
        status: view.status,
        // Frozen here: the transcript is read hours later, and a live clock
        // would make the run look longer every time it is rendered.
        elapsedMs: Math.max(0, (view.finishedAt ?? Date.now()) - view.startedAtWall),
        agentCount: view.totalCount,
        completedCount: view.completedCount,
        failedCount: view.failedCount,
        emptyCount: unresolved.length,
        unresolved,
        scriptPath: view.scriptPath,
        runDir: view.runDir,
        usage: view.usage,
        result: view.result,
        ...(resultTruncated ? { resultTruncated: true } : {}),
      } satisfies WorkflowSettledDetails,
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}
