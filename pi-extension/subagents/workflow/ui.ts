/** Centered workflow tree. Navigation follows Pi lists and Vim tree conventions. */
import { isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { WorkflowAgentResultMeta, WorkflowRunView } from "./types.ts";

export interface WorkflowPanelCallbacks {
  focus(name: string, sessionFile?: string): { ok: true } | { error: string } | Promise<{ ok: true } | { error: string }>;
  skip(callKey: string, runId: string): void | Promise<void>;
  abort(runId: string): void | Promise<void>;
  resume(runId: string): void | Promise<void>;
}
export interface WorkflowPanelOptions {
  shortcut?: string;
  callbacks: WorkflowPanelCallbacks;
  views(): WorkflowRunView[];
  isLive(runId: string): boolean;
  inspect?(runId: string): WorkflowRunView | null;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}
export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`;
}
export function orderViews(views: WorkflowRunView[], isLive: (id: string) => boolean): WorkflowRunView[] {
  return [...views].sort((a, b) => Number(isLive(b.runId)) - Number(isLive(a.runId)) || b.createdAt - a.createdAt || a.runId.localeCompare(b.runId));
}

const STATUS: Record<string, { glyph: string; color: string }> = {
  queued: { glyph: "○", color: "dim" },
  running: { glyph: "⟳", color: "accent" },
  completed: { glyph: "✓", color: "success" },
  failed: { glyph: "✗", color: "error" },
  skipped: { glyph: "⊘", color: "dim" },
  aborted: { glyph: "⊘", color: "error" },
  interrupted: { glyph: "⊘", color: "warning" },
};
type Action = "focus" | "skip" | "abort" | "resume";
export interface TreeNode {
  id: string;
  parent?: string;
  kind: "run" | "phase" | "call" | "action";
  label: string;
  depth: number;
  branch: boolean;
  view: WorkflowRunView;
  call?: WorkflowAgentResultMeta;
  action?: Action;
}
interface Confirmation { node: TreeNode; confirm: boolean }
export interface WorkflowPanelRenderState {
  selected: string | null;
  expanded: Set<string>;
  initialized: Set<string>;
  windowStart: number;
  confirmation: Confirmation | null;
  error: string | null;
  busy: boolean;
}
export function createPanelRenderState(): WorkflowPanelRenderState {
  return { selected: null, expanded: new Set(), initialized: new Set(), windowStart: 0, confirmation: null, error: null, busy: false };
}

export function callActions(call: WorkflowAgentResultMeta): Action[] {
  const actions: Action[] = [];
  if (call.name && (call.status === "running" || call.sessionFile)) actions.push("focus");
  if (call.status === "queued" || call.status === "running") actions.push("skip");
  return actions;
}
const ACTION_LABEL: Record<Action, string> = { focus: "Focus", skip: "Skip", abort: "Abort workflow", resume: "Resume workflow" };
const runDate = new Intl.DateTimeFormat("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

/** Progress describes issued calls, never a prediction of future script work. */
export function workflowSummary(view: WorkflowRunView, width: number): string[] {
  const settled = Math.round(view.progress * view.totalCount);
  const size = Math.max(4, Math.min(14, Math.floor(width / 6)));
  const filled = view.totalCount ? Math.round(size * settled / view.totalCount) : 0;
  const bar = "▰".repeat(Math.min(size, filled)) + "▱".repeat(Math.max(0, size - filled));
  const usage = [`${view.activeCount} running`, `${formatTokens(view.usage.totalTokens ?? 0)} tokens`];
  if (view.usage.cost !== undefined) usage.push(`$${view.usage.cost.toFixed(2)}`);
  return [
    `Workflow · ${view.meta.name}`,
    ...wrapTextWithAnsi(`${bar} ${settled}/${view.totalCount} settled · ${usage.join(" · ")}`, Math.max(1, width)),
  ];
}

export class WorkflowPanel {
  readonly options: WorkflowPanelOptions;
  private overlayOpen = false;
  private closeOverlay: (() => void) | null = null;
  private scopedRunId?: string;
  private stopRefresh: (() => void) | null = null;
  private state = createPanelRenderState();
  constructor(options: WorkflowPanelOptions) { this.options = options; }
  private views(): WorkflowRunView[] {
    const all = this.options.views();
    if (!this.scopedRunId) return orderViews(all, this.options.isLive);
    const view = all.find(v => v.runId === this.scopedRunId) ?? this.options.inspect?.(this.scopedRunId);
    return view ? [view] : [];
  }
  dispose(): void { this.stopRefresh?.(); this.stopRefresh = null; }

  nodes(state = this.state): TreeNode[] {
    const views = this.views();
    if (state.initialized.size === 0 && views.length) state.expanded.add(`run:${views[0].runId}`);
    const nodes: TreeNode[] = [];
    const names = new Map<string, number>();
    for (const view of views) names.set(view.meta.name, (names.get(view.meta.name) ?? 0) + 1);
    for (const view of views) {
      const root = `run:${view.runId}`;
      const stamp = names.get(view.meta.name)! > 1 ? ` · ${runDate.format(view.createdAt)}` : "";
      nodes.push({ id: root, kind: "run", label: view.meta.name + stamp, depth: 0, branch: true, view });
      if (!state.expanded.has(root)) continue;
      const phases = new Map<string, WorkflowAgentResultMeta[]>();
      for (const p of view.meta.phases ?? []) phases.set(typeof p === "string" ? p : p.title, []);
      for (const call of view.calls) {
        const phase = call.phase?.trim() || "Tasks";
        if (!phases.has(phase)) phases.set(phase, []);
        phases.get(phase)!.push(call);
      }
      if (!state.initialized.has(root)) {
        state.initialized.add(root);
        for (const phase of phases.keys()) state.expanded.add(`${root}:phase:${phase}`);
      }
      for (const [phase, calls] of phases) {
        const parent = `${root}:phase:${phase}`;
        nodes.push({ id: parent, parent: root, kind: "phase", label: phase, depth: 1, branch: calls.length > 0, view });
        if (!state.expanded.has(parent)) continue;
        for (const call of calls) {
          const id = `${root}:call:${call.callKey}`;
          const actions = callActions(call);
          nodes.push({ id, parent, kind: "call", label: call.label, depth: 2, branch: actions.length > 0 || Boolean(call.error), view, call });
          if (state.expanded.has(id)) for (const action of actions) {
            nodes.push({ id: `${id}:${action}`, parent: id, kind: "action", label: ACTION_LABEL[action], depth: 3, branch: false, action, view, call });
          }
        }
      }
      const action = this.options.isLive(view.runId) ? "abort" : ["failed", "aborted", "interrupted"].includes(view.status) ? "resume" : null;
      if (action) nodes.push({ id: `${root}:${action}`, parent: root, kind: "action", label: ACTION_LABEL[action], depth: 1, branch: false, action, view });
    }
    if (!nodes.some(n => n.id === state.selected)) {
      // Collapse back to the nearest visible ancestor when a live action disappears.
      const previous = state.selected;
      state.selected = nodes.filter(n => previous?.startsWith(n.id + ":")).at(-1)?.id
        ?? nodes.find(n => n.kind === "call" && n.call?.status === "running")?.id ?? nodes[0]?.id ?? null;
    }
    return nodes;
  }

  async handleInput(data: string, close: () => void, state = this.state): Promise<void> {
    if (state.busy) return;
    const key = (name: string) => matchesKey(data, name as Parameters<typeof matchesKey>[1]);
    if (state.confirmation) {
      if (key("escape")) { state.confirmation = null; return; }
      if (data === "j" || key("down")) state.confirmation.confirm = true;
      else if (data === "k" || key("up")) state.confirmation.confirm = false;
      else if (key("return") || data === "\r" || data === "\n") {
        const confirmation = state.confirmation;
        state.confirmation = null;
        if (confirmation.confirm) await this.execute(confirmation.node, close, state);
      }
      return;
    }
    if (key("escape") || data === "q") { close(); return; }
    const nodes = this.nodes(state);
    const index = nodes.findIndex(n => n.id === state.selected);
    const node = nodes[index];
    if (!node) return;
    state.error = null;
    if (data === "j" || key("down")) state.selected = nodes[Math.min(nodes.length - 1, index + 1)].id;
    else if (data === "k" || key("up")) state.selected = nodes[Math.max(0, index - 1)].id;
    else if (data === "h" || key("left")) {
      if (node.branch && state.expanded.has(node.id)) state.expanded.delete(node.id);
      else if (node.parent) state.selected = node.parent;
    } else if (data === "l" || key("right")) {
      if (node.branch && !state.expanded.has(node.id)) state.expanded.add(node.id);
      else if (nodes[index + 1]?.parent === node.id) state.selected = nodes[index + 1].id;
    } else if (key("return") || data === "\r" || data === "\n") {
      if (node.action === "focus") await this.execute(node, close, state);
      else if (node.action) state.confirmation = { node, confirm: false };
      else if (node.branch) {
        if (state.expanded.has(node.id)) state.expanded.delete(node.id);
        else state.expanded.add(node.id);
      }
    }
  }

  private async execute(node: TreeNode, close: () => void, state: WorkflowPanelRenderState): Promise<void> {
    state.busy = true;
    try {
      // The tree may have changed while a confirmation was open.
      const fresh = this.nodes(state).find(n => n.id === node.id);
      if (!fresh) throw new Error("This action is no longer available.");
      if (fresh.action === "focus" && fresh.call?.name) {
        const result = await this.options.callbacks.focus(fresh.call.name, fresh.call.sessionFile);
        if ("error" in result) throw new Error(result.error);
        close();
      } else if (fresh.action === "skip" && fresh.call) {
        await this.options.callbacks.skip(fresh.call.callKey, fresh.view.runId);
        state.selected = fresh.parent!;
      } else if (fresh.action === "abort") {
        await this.options.callbacks.abort(fresh.view.runId);
        state.selected = `run:${fresh.view.runId}:resume`;
      } else if (fresh.action === "resume") {
        await this.options.callbacks.resume(fresh.view.runId);
        state.selected = `run:${fresh.view.runId}:abort`;
      }
    } catch (error) { state.error = error instanceof Error ? error.message : String(error); }
    finally { state.busy = false; }
  }

  renderPanel(theme: any, width: number, state = this.state, height = 30): string[] {
    const cap = Number.isFinite(height) ? Math.max(3, Math.floor(height)) : 40;
    const inner = Math.max(1, width - 4);
    const nodes = this.nodes(state);
    const title = state.confirmation ? ACTION_LABEL[state.confirmation.node.action!] : "Workflows";
    const border = (s: string) => theme.fg("accent", s);
    const top = border("╭" + truncateToWidth(`─ ${title} `, Math.max(0, width - 2)).padEnd(Math.max(0, width - 2), "─") + "╮");
    const bottom = border("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    let body: string[] = [];
    if (state.confirmation) {
      const { node, confirm } = state.confirmation;
      const text = node.action === "skip" ? "Stop this call and return null to the workflow script? Other calls will continue."
        : node.action === "abort" ? `Stop this workflow and its ${node.view.activeCount} running agents? Completed results will be kept for resume.`
        : "Replay the script using completed results. Failed, skipped and unfinished calls will run again.";
      body = [theme.bold(node.call?.label ?? node.view.meta.name), "", ...wrapTextWithAnsi(text, inner), "",
        `${!confirm ? theme.fg("accent", "❯") : " "} Cancel`,
        `${confirm ? theme.fg("accent", "❯") : " "} ${node.action === "skip" ? "Skip call" : ACTION_LABEL[node.action!]}`];
    } else {
      const rows = new Map<number, string[]>();
      const row = (index: number): string[] => {
        if (rows.has(index)) return rows.get(index)!;
        const node = nodes[index];
        const indent = "  ".repeat(node.depth);
        const pointer = state.selected === node.id ? theme.fg("accent", "❯") : " ";
        const chevron = node.branch ? (state.expanded.has(node.id) ? "▾" : "▸") : " ";
        const status = node.call?.status ?? (node.kind === "run" ? node.view.status : undefined);
        const icon = node.kind === "call" && status ? theme.fg(STATUS[status].color, STATUS[status].glyph) + " " : "";
        const color = state.selected === node.id ? "accent" : status === "failed" ? "error" : status === "completed" ? "dim" : node.kind === "phase" ? "muted" : "text";
        const left = `${pointer} ${indent}${theme.fg("dim", chevron)} ${icon}${theme.fg(color, node.label)}`;
        let right = "";
        if (node.kind === "run") right = `${node.view.status} · ${formatElapsed((node.view.status === "running" ? Date.now() : node.view.finishedAt ?? node.view.updatedAt) - node.view.startedAtWall)}`;
        else if (node.kind === "call") {
          const call = node.call!;
          right = call.cached ? "cached" : call.status === "running" ? (call.live?.detail || "running").replace(/^[·•]\s*/, "")
            : call.status === "completed" || call.status === "failed" ? formatElapsed(call.durationMs ?? 0) : call.status;
        }
        const rightWidth = Math.min(visibleWidth(right), Math.max(0, Math.floor(inner * 0.42)));
        const clippedRight = truncateToWidth(right, rightWidth);
        const clippedLeft = truncateToWidth(left, Math.max(1, inner - rightWidth - (right ? 2 : 0)));
        const line = right ? clippedLeft + " ".repeat(Math.max(2, inner - visibleWidth(clippedLeft) - rightWidth)) + theme.fg(status === "failed" ? "error" : "dim", clippedRight) : clippedLeft;
        const lines = [line];
        const error = node.kind === "call" ? node.call?.error : node.kind === "run" ? node.view.error : undefined;
        if (error && state.expanded.has(node.id)) lines.push(...wrapTextWithAnsi(error, Math.max(1, inner - indent.length - 4)).map(s => `${indent}    ${theme.fg("error", s)}`));
        rows.set(index, lines);
        return lines;
      };
      const selected = Math.max(0, nodes.findIndex(n => n.id === state.selected));
      const extra = state.error ? wrapTextWithAnsi(state.error, inner).slice(0, 3) : state.busy ? ["Opening…"] : [];
      const budget = Math.max(1, cap - 4 - extra.length);
      let start = Math.max(0, Math.min(state.windowStart, selected));
      let throughSelection = 0;
      for (let i = selected; i < nodes.length && i >= start; i--) {
        throughSelection += row(i).length;
        if (throughSelection > budget) { start = Math.min(selected, i + 1); break; }
      }
      state.windowStart = start;
      let used = 0;
      for (let i = start; i < nodes.length && used < budget; i++) {
        const lines = row(i).slice(0, budget - used);
        body.push(...lines); used += lines.length;
      }
      if (!nodes.length) body = [theme.fg("dim", "No workflow runs in this session.")];
      body.push(...extra.map(s => theme.fg(state.error ? "error" : "dim", s)));
    }
    // Fixed height keeps the centered frame still as calls appear and settle.
    const available = Math.max(1, cap - 4);
    body = body.slice(0, available);
    while (body.length < available) body.push("");
    const framed = [top, border("│") + " ".repeat(Math.max(0, width - 2)) + border("│"),
      ...body.map(line => border("│") + " " + truncateToWidth(line, inner, "", true) + " " + border("│")),
      border("│") + " ".repeat(Math.max(0, width - 2)) + border("│"), bottom];
    return framed.slice(0, cap).map(line => truncateToWidth(line, width, "", true));
  }

  async toggle(ctx: { ui: { custom: Function; notify: Function; onTerminalInput?: Function } }): Promise<void> {
    if (this.closeOverlay) this.closeOverlay();
    else await this.open(ctx);
  }

  async open(ctx: { ui: { custom: Function; notify: Function; onTerminalInput?: Function } }, runId?: string): Promise<void> {
    if (this.overlayOpen) return;
    if (runId && !this.options.views().some(v => v.runId === runId) && !this.options.inspect?.(runId)) {
      this.options.notify(`No workflow run ${runId} in this session.`, "warning"); return;
    }
    this.overlayOpen = true;
    this.scopedRunId = runId;
    if (runId) this.state.expanded.add(`run:${runId}`);
    let removeInputListener: (() => void) | undefined;
    try {
      await ctx.ui.custom((tui: any, theme: any, _bindings: any, done: Function) => {
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          this.state.confirmation = null;
          done(undefined);
        };
        this.closeOverlay = close;
        const toggleKey = (data: string) => {
          if (!matchesKey(data, (this.options.shortcut ?? "ctrl+alt+w") as Parameters<typeof matchesKey>[1])) return false;
          if (!isKeyRepeat(data) && !isKeyRelease(data)) close();
          return true;
        };
        // Extension shortcuts normally belong to the editor; overlays own input.
        removeInputListener = ctx.ui.onTerminalInput?.((data: string) =>
          toggleKey(data) ? { consume: true } : undefined);
        let width = 80;
        let painted = "";
        const height = () => Math.max(5, Math.min(36, Math.floor((tui.terminal?.rows ?? 40) * 0.85)));
        const timer = setInterval(() => {
          // Check the final frame too: the last live run may just have settled.
          const next = this.renderPanel(theme, width, this.state, height()).join("\n");
          if (next !== painted) tui.requestRender();
        }, 1000);
        this.stopRefresh = () => clearInterval(timer);
        return {
          invalidate() {},
          render: (columns: number) => { width = columns; const lines = this.renderPanel(theme, width, this.state, height()); painted = lines.join("\n"); return lines; },
          handleInput: (data: string) => {
            if (toggleKey(data)) return;
            const pending = this.handleInput(data, close);
            tui.requestRender();
            void pending.finally(() => tui.requestRender());
          },
          dispose: () => this.dispose(),
        };
      }, { overlay: true, overlayOptions: () => ({
        anchor: "center", width: Math.max(1, Math.min(112, Math.floor((process.stdout.columns ?? 100) * 0.92))),
        maxHeight: "85%", margin: 1,
      }) });
    } finally {
      removeInputListener?.();
      this.closeOverlay = null;
      this.dispose();
      this.overlayOpen = false;
      this.scopedRunId = undefined;
    }
  }

  textReport(): string {
    return this.views().map(view => [
      `${view.meta.name} — ${view.status}`, `  run: ${view.runId}`, `  script: ${view.scriptPath}`,
      ...view.calls.map(c => `  ${c.status.padEnd(9)} ${c.label}${c.error ? ` — ${c.error}` : ""}`),
      ...view.logs.map(s => `  · ${s}`),
    ].join("\n")).join("\n\n") || "No workflow runs in this session.";
  }
}
