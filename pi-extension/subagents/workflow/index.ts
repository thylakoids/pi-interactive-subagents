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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { WorkflowManager } from "./manager.ts";
import { WorkflowPanel, formatElapsed, formatTokens } from "./ui.ts";
import { WorkflowScriptError, listSavedWorkflows, parseScript, readScriptFile, resolveSavedScriptPath } from "./script.ts";
import { buildWorkflowDescription, readAuthoringGuide, workflowSize } from "./authoring.ts";
import { validateScript } from "./runner.ts";
import { STRUCTURED_OUTPUT_EXTENSION } from "../wiring.ts";
import type { WorkflowRunView, WorkflowSubagentService } from "./types.ts";

export interface WorkflowExtensionOptions {
  service: WorkflowSubagentService;
  widget?: { bind(views: () => WorkflowRunView[], shortcut: string): void; refresh(): void };
  /** Shortcut id, shown in /hotkeys. */
  shortcut?: string;
}

const WorkflowParams = Type.Object({
  action: Type.Optional(
    Type.Union([
      Type.Literal("start"),
      Type.Literal("resume"),
      Type.Literal("status"),
      Type.Literal("list"),
      Type.Literal("guide"),
      Type.Literal("validate"),
    ], {
      description:
        "start a run (default), resume, report status, list/guide, or validate QuickJS syntax without executing code or agents",
    }),
  ),
  script: Type.Optional(
    Type.String({
      description:
        "Inline source for start/resume/validate. Plain JavaScript; must begin with a pure literal `export const meta = {...}`.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Saved workflow name or path for start/validate, or a full template for guide.",
    }),
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
        "action=start only. 'none' (default) starts fresh. Explicit 'auto' replays completed calls " +
        "from the previous run of the same workflow with the same args; resume continues a specific run.",
    }),
  ),
});

export function registerWorkflowExtension(pi: ExtensionAPI, options: WorkflowExtensionOptions): void {
  const { service } = options;
  const size = workflowSize(process.env.PI_WORKFLOW_SIZE);
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
    options.widget?.bind(() => manager?.running().map(run => run.view()) ?? [], options.shortcut ?? "ctrl+alt+w");

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
    if (params.action === "start" && availability.ok === false) {
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
        source: resolveSource(params, ctx).source,
        args: params.args ?? {},
        ...(params.reuse ? { reuse: params.reuse } : {}),
      });
    }

    void run.execute();
    options.widget?.refresh();
    return run.view();
  };

  const resolveSource = (params: { script?: string; name?: string }, ctx: ExtensionContext): { source: string; filename: string } => {
    if (params.script?.trim()) return { source: params.script, filename: "inline-workflow.js" };
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
    return { source: readScriptFile(path), filename: path };
  };

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: buildWorkflowDescription(size),
    promptSnippet:
      "Run or author JavaScript workflows that orchestrate subagents; use list/guide to discover composable shapes and runnable templates without executing them.",
    promptGuidelines: [
      "Prefer pipeline() over parallel() unless the next stage genuinely needs every prior result.",
      "Use workflow({ action: 'list' }) and workflow({ action: 'guide' }) to discover templates and authoring guidance; those actions do not authorize starting agents.",
      "Give each agent() a short `label`; it is the panel's row title and part of the resume key.",
      "Use `schema` when you will branch on the result; free text cannot be parsed reliably.",
      "Keep per-agent prompts self-contained: subagents do not see this conversation.",
      "Before starting an authored/edited script, use action=validate: the real QuickJS compiler checks syntax without executing code or calling agents. Node --check is not sandbox validation.",
    ],
    parameters: WorkflowParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const action = params.action ?? "start";
        if (action === "list") {
          return readonlyResult("list", formatWorkflowList(ctx));
        }
        if (action === "guide") {
          return readonlyResult("guide", formatWorkflowGuide(params.name, ctx, size));
        }
        if (action === "validate") {
          const { source, filename } = resolveSource(params, ctx);
          const checked = await validateScript(parseScript(source, filename).body, filename, _signal);
          return {
            content: [{ type: "text" as const, text: checked.ok ? `QuickJS syntax OK: ${filename}. No code or agents executed; runtime behavior is not validated.` : checked.error!.message }],
            details: { action, valid: checked.ok, filename, ...(checked.ok ? {} : { error: checked.error!.message }) },
            ...(checked.ok ? {} : { isError: true }),
          };
        }
        const view = await startRun({ ...params, action }, ctx);
        return {
          content: [{ type: "text" as const, text: formatStartMessage(action, view) }],
          details: {
            action,
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
      if (details?.action === "list" || details?.action === "guide" || details?.action === "validate") {
        const text = result.content
          .filter((item): item is { type: "text"; text: string } => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        if (expanded) return new Text(text, 0, 0);
        const first = text.split("\n").find((line) => line.trim()) ?? "No guidance available.";
        return new Text(
          `${INDENT}${theme.fg("dim", "⎿")}  ${theme.fg("dim", firstLine(first, 90))}` +
            theme.fg("muted", "  (ctrl+o to expand)"),
          0,
          0,
        );
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

  pi.on("session_shutdown", async () => {
    // Anything still in flight settles after this point, when every handle
    // this extension holds is stale: drop the ctx, refuse to notify, and stop
    // the agents so no pane is left running with nobody listening.
    sessionLive = false;
    latestCtx = null;
    // The overlay's refresh timer dies with the session even if the TUI never
    // got to dispose the component.
    panel?.dispose();
    const running = manager?.running() ?? [];
    manager?.abortAll("session ended");
    await Promise.all(running.map(run => run.execute()));
    manager = null;
    panel = null;
  });

  // The same extension instance can serve a subsequent session.
  pi.on("session_start", (_event, ctx) => {
    sessionLive = true;
    latestCtx = ctx;
  });
}

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

function isTui(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui";
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
    if (view.error) lines.push(`error: ${view.error}`);
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

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
}

function formatWorkflowList(ctx: ExtensionContext): string {
  const { workflows, errors } = listSavedWorkflows({ cwd: ctx.cwd, agentDir: agentDir() });
  const lines = [`Available workflows (${workflows.length})`];
  for (const workflow of workflows) {
    lines.push(
      "",
      `${workflow.name} [${workflow.source}]`,
      `  ${workflow.meta.description}`,
    );
    if (workflow.meta.whenToUse) lines.push(`  when: ${workflow.meta.whenToUse}`);
    if (workflow.meta.phases?.length) {
      lines.push(`  phases: ${workflow.meta.phases.map((phase) => typeof phase === "string" ? phase : phase.title).join(" -> ")}`);
    }
    lines.push(`  path: ${workflow.path}`);
  }
  if (workflows.length === 0) lines.push("", "No saved or bundled workflows found.");
  if (errors.length > 0) {
    lines.push("", `Ignored ${errors.length} invalid workflow file(s):`);
    for (const error of errors) lines.push(`  ${error.path}: ${error.error}`);
  }
  lines.push(
    "",
    "Read one without executing it: workflow({ action: 'guide', name: '<name>' }).",
    "Read the general authoring guide: workflow({ action: 'guide' }).",
  );
  return lines.join("\n");
}

function formatWorkflowGuide(name: string | undefined, ctx: ExtensionContext, size: ReturnType<typeof workflowSize>): string {
  if (!name?.trim()) return readAuthoringGuide(size);
  const path = resolveSavedScriptPath(name, { cwd: ctx.cwd, agentDir: agentDir() });
  if (!path) {
    throw new WorkflowScriptError(`No workflow template "${name}". Use workflow({ action: 'list' }) to see available names.`);
  }
  const source = readScriptFile(path);
  const { meta } = parseScript(source, path);
  return [
    `Workflow template: ${meta.name}`,
    `path: ${path}`,
    `description: ${meta.description}`,
    ...(meta.whenToUse ? [`when to use: ${meta.whenToUse}`] : []),
    "",
    "This is a complete runnable script. No agents were started.",
    "",
    "```js",
    source.trimEnd(),
    "```",
  ].join("\n");
}

function readonlyResult(action: string, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { action },
  };
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
  name?: string;
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
  error?: string;
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
  if (args.action === "list") return `${head}${theme.fg("dim", "(list)")}`;
  if (args.action === "guide" || args.action === "validate") return `${head}${theme.fg("dim", `(${args.action}${args.name ? `: ${args.name}` : ""})`)}`;
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
  if (details.error) {
    const error = expanded ? details.error.split("\n") : [firstLine(details.error, 140)];
    lines.push(...error.map(line => `${INDENT}   ${theme.fg("error", line)}`));
  }
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
        ...(view.error ? { error: view.error } : {}),
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
