/**
 * Observability for workflow runs.
 *
 * A workflow's agents are real pi sessions in tmux panes, so the panel can show
 * what every agent is doing right now and drive it. One surface: an overlay
 * opened with the shortcut or `/workflow [runId]`.
 *
 * The visual language is Claude Code's: no borders, brightness instead of
 * boxes, a `❯` cursor on the selected row, keys dimmed at the bottom. One run is
 * on screen at a time — `[` and `]` move between runs — and a row's available
 * actions are shown as keys you can press, not as a command you have to type.
 *
 * Nothing here renders on a clock of its own: the panel repaints while a run is
 * live and only when the frame actually changed. This is deliberately not a
 * widget above the editor. An earlier revision put live status there on a
 * one-second timer, which made the editor flicker and let a finished run report
 * hours of elapsed time; the TUI is built for components that render on state
 * change, not for a dashboard that ticks outside the overlay.
 */
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { WorkflowAgentResultMeta, WorkflowRunView, WorkflowSubagentLiveStatus } from "./types.ts";

export interface WorkflowPanelCallbacks {
  steer(name: string, message: string): void;
  focus(name: string): { ok: true } | { error: string };
  stop(name: string): void;
  skip(callKey: string): void;
  abort(runId: string): void;
  resume(runId: string): void;
}

export interface WorkflowPanelOptions {
  callbacks: WorkflowPanelCallbacks;
  /** Every run this session knows about, in any order. */
  views(): WorkflowRunView[];
  /** True while a run's agents are still executing. */
  isLive(runId: string): boolean;
  /**
   * Read a run that is not in memory — one left by an earlier process. Only
   * used when the panel is scoped to a run id that `views()` does not have.
   */
  inspect?(runId: string): WorkflowRunView | null;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** Prompt for a message; returns undefined when cancelled. */
  prompt(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
}

/**
 * Narrow glyphs only. Emoji and wide CJK are measured wrongly by some
 * terminals, which drifts every line after them.
 */
const CALL_GLYPH: Record<string, { glyph: string; color: string }> = {
  queued: { glyph: "○", color: "dim" },
  running: { glyph: "✻", color: "accent" },
  completed: { glyph: "✓", color: "success" },
  failed: { glyph: "✗", color: "error" },
  skipped: { glyph: "⊘", color: "dim" },
  aborted: { glyph: "⊘", color: "error" },
};

const RUN_GLYPH: Record<string, { glyph: string; color: string }> = {
  running: { glyph: "✻", color: "accent" },
  completed: { glyph: "✓", color: "success" },
  failed: { glyph: "✗", color: "error" },
  aborted: { glyph: "⊘", color: "error" },
  interrupted: { glyph: "⊘", color: "warning" },
};

/** The cursor, in pi's own list idiom (a pointer, never reverse video). */
const CURSOR = "❯ ";
const BLANK = "  ";

/**
 * How often the panel repaints while a run is live.
 *
 * Only the panel's own overlay is redrawn, and only while something is moving:
 * elapsed times and the agents' activity snapshots are not push-based, so a
 * repaint needs a tick. A tick that finds the same frame repaints nothing.
 */
const LIVE_REFRESH_MS = 1000;

/** Lines the panel needs beyond the rows themselves: two blanks and a footer. */
const MIN_FRAME_LINES = 5;

/** How many of the run's most recent notes the panel shows above the rows. */
const RECENT_LOG_LINES = 3;

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${(seconds % 60).toString().padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

/**
 * Wall-clock age of a run, as shown next to its status.
 *
 * A live run is measured against the clock. A settled one is measured to its
 * finish — reading `Date.now()` there would make a run that ended in seconds
 * report hours in a pane left open overnight. `updatedAt` is the fallback for a
 * run recovered from a snapshot that predates `finishedAt`.
 */
function runElapsedMs(view: WorkflowRunView): number {
  const end = view.status === "running" ? Date.now() : view.finishedAt ?? view.updatedAt;
  return Math.max(0, end - view.startedAtWall);
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function progressBar(fraction: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return "▰".repeat(filled) + "▱".repeat(Math.max(0, width - filled));
}

function firstLine(text: string, limit = 80): string {
  const line = (text.split("\n")[0] ?? "").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** What the cursor points at. Identity, not a row index. */
export type WorkflowPanelSelection =
  | { kind: "run"; runId: string }
  | { kind: "call"; callKey: string };

export interface PanelAction {
  id: "focus" | "steer" | "stop" | "skip" | "abort" | "resume";
  label: string;
  /** The key that runs it without opening the menu. */
  key: string;
  hint: string;
}

export interface WorkflowPanelMenu {
  selection: WorkflowPanelSelection;
  actions: PanelAction[];
  index: number;
}

/** Everything the panel remembers while it is open — and what a test sets up. */
export interface WorkflowPanelRenderState {
  /** The run on screen; null means "the newest live one, else the newest". */
  runId: string | null;
  selection: WorkflowPanelSelection | null;
  /** Inline action menu, when one is open. */
  menu: WorkflowPanelMenu | null;
  /** First visible row, carried between renders so the list does not jump. */
  windowStart: number;
}

export function createPanelRenderState(): WorkflowPanelRenderState {
  return { runId: null, selection: null, menu: null, windowStart: 0 };
}

export function sameSelection(left: WorkflowPanelSelection | null, right: WorkflowPanelSelection | null): boolean {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind) return false;
  return left.kind === "run" ? left.runId === (right as { runId: string }).runId : left.callKey === (right as { callKey: string }).callKey;
}

/** Live runs first, then most recently started first. */
export function orderViews(views: WorkflowRunView[], isLive: (runId: string) => boolean): WorkflowRunView[] {
  const rank = (view: WorkflowRunView) => (isLive(view.runId) ? 0 : 1);
  return [...views].sort(
    (left, right) => rank(left) - rank(right) || right.createdAt - left.createdAt || left.runId.localeCompare(right.runId),
  );
}

/** The run and call a selection points at, when they still exist. */
export function resolveSelection(
  selection: WorkflowPanelSelection | null,
  views: WorkflowRunView[],
): { view?: WorkflowRunView; call?: WorkflowAgentResultMeta } {
  if (!selection) return {};
  if (selection.kind === "run") return { view: views.find((view) => view.runId === selection.runId) };
  for (const view of views) {
    const call = view.calls.find((candidate) => candidate.callKey === selection.callKey);
    if (call) return { view, call };
  }
  return {};
}

/**
 * Actions offered for a row. Only what is actually possible: a queued call has
 * no pane yet, a settled call cannot be stopped, a live run cannot be resumed.
 */
export function panelActions(
  selection: WorkflowPanelSelection | null,
  views: WorkflowRunView[],
  isLive: (runId: string) => boolean,
): PanelAction[] {
  const { view, call } = resolveSelection(selection, views);
  const actions: PanelAction[] = [];
  if (call) {
    if (call.name) {
      actions.push({ id: "focus", label: "focus", key: "f", hint: "jump to its tmux pane" });
      actions.push({
        id: "steer",
        label: "message",
        key: "m",
        hint: call.status === "running" ? "send it a message" : "resume it with a message",
      });
    }
    if (call.name && call.status === "running") {
      actions.push({ id: "stop", label: "stop", key: "x", hint: "close the pane; the call fails" });
    }
    if (call.status === "queued" || call.status === "running") {
      actions.push({ id: "skip", label: "skip", key: "s", hint: "resolve the call as null now" });
    }
    return actions;
  }
  if (view) {
    actions.push(
      isLive(view.runId)
        ? { id: "abort", label: "abort", key: "a", hint: "stop the run and its agents" }
        : { id: "resume", label: "resume", key: "r", hint: "replay its journal and continue" },
    );
  }
  return actions;
}

/**
 * Visible row range for a line budget, keeping the focused row in view.
 *
 * `preferredStart` is the previous window. As long as the cursor stays inside
 * it the window does not move; when the cursor leaves it the window ends at the
 * cursor, so a single step adds one row instead of jumping the whole screen.
 */
export function fitWindow(
  heights: number[],
  budget: number,
  focus: number,
  preferredStart: number,
): { start: number; end: number } {
  const total = heights.length;
  const reach = (start: number) => {
    let end = start;
    let used = 0;
    while (end < total && used + heights[end] <= budget) {
      used += heights[end];
      end++;
    }
    return Math.max(end, Math.min(total, start + 1));
  };

  const previousStart = Math.max(0, Math.min(preferredStart, Math.max(0, total - 1)));
  const previousEnd = reach(previousStart);
  if (focus >= previousStart && focus < previousEnd) return { start: previousStart, end: previousEnd };

  // The cursor left the window: fill the budget upwards from it, then spend
  // whatever is left on the rows below.
  let from = Math.max(0, Math.min(focus, total - 1));
  let used = heights[from] ?? 0;
  while (from > 0 && used + heights[from - 1] <= budget) {
    from--;
    used += heights[from];
  }
  let to = Math.max(from + 1, Math.min(total, focus + 1));
  while (to < total && used + heights[to] <= budget) {
    used += heights[to];
    to++;
  }
  return { start: from, end: to };
}

/** The right column of an agent row: what it is doing, or how long it took. */
function activityFor(theme: any, call: WorkflowAgentResultMeta, now: number): string {
  switch (call.status) {
    case "queued":
      return theme.fg("dim", "queued");
    case "running": {
      // The live status already carries what the agent is doing and, for a tool
      // call, how long that tool has been running — repeating the call's own
      // elapsed time next to it would read as two different numbers.
      const detail = call.live ? liveText(call.live) : "";
      if (detail) return theme.fg("dim", detail);
      const since = call.startedAt ? ` ${formatElapsed(now - call.startedAt)}` : "";
      return theme.fg("dim", `running${since}`);
    }
    case "failed":
      return theme.fg("error", call.error ? firstLine(call.error) : "failed");
    case "skipped":
      return theme.fg("dim", "skipped");
    case "aborted":
      return theme.fg("error", "aborted");
    default: {
      const parts = [formatElapsed(call.durationMs ?? 0)];
      if (call.cached) parts.push("cached");
      return theme.fg("dim", parts.join(" · "));
    }
  }
}

/**
 * The live status line, phrased exactly like the subagent widget's label —
 * without the separator the widget puts in front of it.
 */
function liveText(live: WorkflowSubagentLiveStatus): string {
  const detail = (live.detail ?? "").trim().replace(/^[·•]\s*/, "");
  const text = detail || live.kind;
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/**
 * Header: the run's name and status, what it has spent, and how far it is.
 *
 * The run id never appears — it is an implementation detail the user did not
 * choose and cannot use; the name and the position in the run list do the job.
 */
export function renderHeader(
  theme: any,
  width: number,
  view: WorkflowRunView,
  position: { index: number; total: number } | null,
): string[] {
  const glyph = RUN_GLYPH[view.status] ?? RUN_GLYPH.running;
  const left = `${theme.fg(glyph.color, glyph.glyph)} ${theme.bold(view.meta.name)}`;
  const right =
    theme.fg("dim", `${view.status} · ${formatElapsed(runElapsedMs(view))}`) +
    (position && position.total > 1 ? theme.fg("muted", ` · ${position.index + 1}/${position.total}`) : "");
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));

  // Settled, not "completed": a skipped call is over too, and counting it out
  // would leave the number disagreeing with the progress bar right above it.
  const settled = view.calls.filter((call) => call.status !== "queued" && call.status !== "running").length;
  const meta: string[] = [];
  meta.push(`${settled}/${view.totalCount} agents`);
  const tokens = view.usage.totalTokens ?? 0;
  if (tokens) {
    meta.push(view.budgetTotal ? `${formatTokens(tokens)} / ${formatTokens(view.budgetTotal)} tokens` : `${formatTokens(tokens)} tokens`);
  }
  if (view.usage.cost) meta.push(`$${view.usage.cost.toFixed(2)}`);
  const metaLine =
    BLANK + theme.fg("dim", meta.join(" · ")) + (view.failedCount ? theme.fg("error", ` · ${view.failedCount} failed`) : "");

  return [truncateToWidth(left + " ".repeat(gap) + right, width), truncateToWidth(metaLine, width)];
}

/** Progress as a thin bar with the percentage bright next to it. */
export function renderProgress(theme: any, width: number, view: WorkflowRunView): string {
  const barWidth = Math.max(8, Math.min(24, Math.floor(width / 3) - 2));
  const bar = theme.fg("dim", progressBar(view.progress, barWidth));
  return truncateToWidth(`${BLANK}${bar} ${theme.fg("text", `${Math.round(view.progress * 100)}%`)}`, width);
}

/**
 * One agent row. Completed rows are dimmed and the running ones are brightest,
 * the same rule Claude Code's task list uses: what is still moving is what you
 * are meant to read.
 */
export function renderAgentRow(
  theme: any,
  width: number,
  call: WorkflowAgentResultMeta,
  labelWidth: number,
  selected: boolean,
  now: number,
): string {
  const glyph = CALL_GLYPH[call.status] ?? CALL_GLYPH.running;
  const label = truncateToWidth(call.label, labelWidth).padEnd(labelWidth);
  const settled = call.status === "completed" || call.status === "skipped";
  const labelText = selected ? theme.fg("accent", label) : theme.fg(settled ? "dim" : "text", label);
  const pointer = selected ? theme.fg("accent", CURSOR) : BLANK;
  const activity = activityFor(theme, call, now);
  return truncateToWidth(`${pointer}${theme.fg(glyph.color, glyph.glyph)} ${labelText} ${activity}`, width);
}

/** Key hints, dim and wrapped: only what the current row can actually do. */
export function renderFooter(theme: any, width: number, groups: string[][]): string[] {
  const lines: string[] = [];
  for (const group of groups) {
    let line = "";
    for (const item of group) {
      const candidate = line ? `${line} · ${item}` : item;
      if (line && visibleWidth(BLANK + candidate) > width) {
        lines.push(theme.fg("muted", BLANK + line));
        line = item;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(theme.fg("muted", BLANK + line));
  }
  return lines;
}

export class WorkflowPanel {
  readonly options: WorkflowPanelOptions;
  private overlayOpen = false;
  /** Set while the panel is open for `/workflow <runId>`. */
  private scopedRunId: string | undefined;
  /** The open overlay's live-refresh timer, so dispose can stop it. */
  private stopRefresh: (() => void) | null = null;

  constructor(options: WorkflowPanelOptions) {
    this.options = options;
  }

  /** Runs this panel instance shows, scoped when opened for one run. */
  private scopedViews(): WorkflowRunView[] {
    const views = this.options.views();
    if (!this.scopedRunId) return views;
    const scoped = views.filter((view) => view.runId === this.scopedRunId);
    if (scoped.length > 0) return scoped;
    // Not in memory: a run from an earlier process. Read it off disk so
    // `/workflow <runId>` shows the same thing `action: 'status'` reports.
    const restored = this.options.inspect?.(this.scopedRunId);
    return restored ? [restored] : [];
  }

  /** Stop the panel's refresh timer, if one is running. Idempotent. */
  dispose(): void {
    this.stopRefresh?.();
    this.stopRefresh = null;
  }

  /**
   * Full-screen panel. Interactive (TUI) mode only — RPC sessions get
   * `/workflow` output as text instead, since `ui.custom` is unavailable there.
   *
   * `runId` opens the panel scoped to one run, which is what `/workflow <runId>`
   * promises.
   */
  async open(ctx: { ui: { custom: Function; notify: Function } }, runId?: string): Promise<void> {
    if (this.overlayOpen) return;
    if (runId && !this.options.views().some((view) => view.runId === runId) && !this.options.inspect?.(runId)) {
      this.options.notify(`No workflow run ${runId} in this session.`, "warning");
      return;
    }
    this.overlayOpen = true;
    this.scopedRunId = runId;
    try {
      await ctx.ui.custom(
        (tui: any, theme: any, _keybindings: any, done: (result: string | undefined) => void) => {
          const state = createPanelRenderState();
          const panel = this;
          let busy = false;
          let timer: ReturnType<typeof setInterval> | null = null;
          /** The frame as last handed to the TUI, to skip no-op repaints. */
          let painted: string | null = null;
          let paintedWidth = 0;

          const height = () => Math.max(MIN_FRAME_LINES, (tui.terminal?.rows ?? 40) - 2);
          const hasLive = () => panel.scopedViews().some((view) => panel.options.isLive(view.runId));
          const repaint = () => tui.requestRender?.();

          const stopTimer = () => {
            if (timer) clearInterval(timer);
            timer = null;
            panel.stopRefresh = null;
          };

          /** Repaint while there is something moving to show, and nothing longer. */
          const startTimer = () => {
            if (timer || !hasLive()) return;
            timer = setInterval(() => {
              if (!hasLive()) {
                stopTimer();
                return;
              }
              if (!paintedWidth) return;
              // A tick costs a render either way; comparing the frame first
              // keeps an unchanged one from becoming a full-screen repaint.
              const next = panel.renderPanel(theme, paintedWidth, state, height()).join("\n");
              if (next !== painted) repaint();
            }, LIVE_REFRESH_MS);
            panel.stopRefresh = stopTimer;
          };

          const current = (): WorkflowRunView | undefined => {
            const ordered = orderViews(panel.scopedViews(), panel.options.isLive);
            return ordered.find((view) => view.runId === state.runId) ?? ordered[0];
          };

          const cycleRun = (delta: number) => {
            const ordered = orderViews(panel.scopedViews(), panel.options.isLive);
            if (ordered.length < 2) return;
            const index = ordered.findIndex((view) => view.runId === state.runId);
            const next = ordered[((index < 0 ? 0 : index) + delta + ordered.length) % ordered.length];
            state.runId = next.runId;
            state.selection = null;
            state.menu = null;
            state.windowStart = 0;
          };

          const move = (delta: number) => {
            const calls = current()?.calls ?? [];
            if (calls.length === 0) return;
            const index = calls.findIndex((call) => sameSelection(state.selection, { kind: "call", callKey: call.callKey }));
            const next = Math.min(calls.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta));
            state.selection = { kind: "call", callKey: calls[next].callKey };
            state.menu = null;
          };

          const selectAt = (index: number) => {
            const calls = current()?.calls ?? [];
            if (calls.length === 0) return;
            const next = Math.min(calls.length - 1, Math.max(0, index));
            state.selection = { kind: "call", callKey: calls[next].callKey };
            state.menu = null;
          };

          const runAction = async (action: PanelAction, selection: WorkflowPanelSelection) => {
            const { view, call } = resolveSelection(selection, panel.scopedViews());
            switch (action.id) {
              case "focus": {
                if (!call?.name) return;
                const result = panel.options.callbacks.focus(call.name);
                if ("error" in result) panel.options.notify(result.error, "error");
                return;
              }
              case "steer": {
                if (!call?.name) return;
                const message = await panel.options.prompt(`Message to ${call.label}`);
                if (!message?.trim()) return;
                panel.options.callbacks.steer(call.name, message);
                panel.options.notify(`Message sent to ${call.name}.`, "info");
                return;
              }
              case "stop": {
                if (!call?.name) return;
                panel.options.callbacks.stop(call.name);
                panel.options.notify(`Stopping ${call.name}.`, "warning");
                return;
              }
              case "skip": {
                if (!call) return;
                panel.options.callbacks.skip(call.callKey);
                panel.options.notify(`Skipped ${call.label}; the script continues with null.`, "warning");
                return;
              }
              case "abort": {
                const target = view ?? current();
                if (!target) return;
                const ok = await panel.options.confirm(
                  "Abort workflow",
                  `Abort ${target.meta.name} and stop its running agents?`,
                );
                if (ok) panel.options.callbacks.abort(target.runId);
                return;
              }
              case "resume": {
                const target = view ?? current();
                if (target) panel.options.callbacks.resume(target.runId);
                return;
              }
            }
          };

          /** Run the row action bound to `key`, if the current row offers it. */
          const pressRowKey = (key: string) => {
            const action = panelActions(state.selection, panel.scopedViews(), panel.options.isLive).find(
              (candidate) => candidate.key === key,
            );
            if (!action || !state.selection) return false;
            busy = true;
            void runAction(action, state.selection)
              .catch(() => {})
              .finally(() => {
                busy = false;
                repaint();
              });
            return true;
          };

          const openMenu = () => {
            if (!state.selection) return;
            const actions = panelActions(state.selection, panel.scopedViews(), panel.options.isLive);
            if (actions.length === 0) {
              panel.options.notify("Nothing to do there yet: that call has no agent session.", "warning");
              return;
            }
            state.menu = { selection: state.selection, actions, index: 0 };
          };

          /** The actions of the run itself, for `a` and `r`. */
          const pressRunKey = (key: string) => {
            const view = current();
            if (!view) return;
            const action = panelActions({ kind: "run", runId: view.runId }, panel.scopedViews(), panel.options.isLive).find(
              (candidate) => candidate.key === key,
            );
            if (!action) return;
            busy = true;
            void runAction(action, { kind: "run", runId: view.runId })
              .catch(() => {})
              .finally(() => {
                busy = false;
                repaint();
              });
          };

          startTimer();

          return {
            invalidate() {},
            render(width: number): string[] {
              startTimer();
              const lines = panel.renderPanel(theme, width, state, height());
              painted = lines.join("\n");
              paintedWidth = width;
              return lines;
            },
            handleInput(data: string): void {
              if (busy) return;

              // An open action menu owns the cursor keys until it is dismissed.
              if (state.menu) {
                const menu = state.menu;
                if (data === "q" || matchesKey(data, "escape")) state.menu = null;
                else if (data === "j" || matchesKey(data, "down")) menu.index = Math.min(menu.actions.length - 1, menu.index + 1);
                else if (data === "k" || matchesKey(data, "up")) menu.index = Math.max(0, menu.index - 1);
                else if (data === "\r" || data === "\n" || matchesKey(data, "return")) {
                  const action = menu.actions[menu.index];
                  state.menu = null;
                  if (action) {
                    busy = true;
                    void runAction(action, menu.selection)
                      .catch(() => {})
                      .finally(() => {
                        busy = false;
                        repaint();
                      });
                  }
                }
                repaint();
                return;
              }

              if (data === "q" || matchesKey(data, "escape")) {
                done(undefined);
                return;
              }

              const page = Math.max(1, Math.floor((tui.terminal?.rows ?? 24) / 2) - 1);
              if (data === "j" || matchesKey(data, "down")) move(1);
              else if (data === "k" || matchesKey(data, "up")) move(-1);
              else if (data === "g") selectAt(0);
              else if (data === "G") selectAt(Number.MAX_SAFE_INTEGER);
              else if (data === "\u0004" || matchesKey(data, "pageDown")) move(page);
              else if (data === "\u0015" || matchesKey(data, "pageUp")) move(-page);
              else if (data === "[") cycleRun(-1);
              else if (data === "]") cycleRun(1);
              else if (data === "\r" || data === "\n" || matchesKey(data, "return")) openMenu();
              else if (data === "f" || data === "m" || data === "x" || data === "s") pressRowKey(data);
              else if (data === "a" || data === "r") pressRunKey(data);
              else return;
              repaint();
            },
            dispose(): void {
              stopTimer();
            },
          };
        },
        {
          overlay: true,
          // Full width and pinned to the top: an overlay is drawn over whatever
          // is behind it, and a centered box would leave the transcript showing
          // through on both sides. The lines are padded to the same width for
          // the same reason — the panel reads as one block, not as text with
          // the session's old output next to it.
          overlayOptions: () => ({
            width: "100%",
            anchor: "top-center",
            maxHeight: Math.max(MIN_FRAME_LINES, (process.stdout.rows ?? 40) - 1),
          }),
        },
      );
    } finally {
      this.dispose();
      this.overlayOpen = false;
      this.scopedRunId = undefined;
    }
  }

  renderPanel(
    theme: any,
    width: number,
    state: WorkflowPanelRenderState,
    height: number = Number.POSITIVE_INFINITY,
  ): string[] {
    const views = this.scopedViews();
    const ordered = orderViews(views, this.options.isLive);
    const view = ordered.find((candidate) => candidate.runId === state.runId) ?? ordered[0];
    state.runId = view?.runId ?? null;
    if (!view) return this.emptyPanel(theme, width);

    // The cursor follows identity: a repaint that adds or settles calls must
    // not move it onto a different agent.
    const calls = view.calls;
    const selected = calls.some((call) => sameSelection(state.selection, { kind: "call", callKey: call.callKey }));
    if (!selected) state.selection = calls.length ? { kind: "call", callKey: calls[0].callKey } : null;

    const now = Date.now();
    const header = renderHeader(theme, width, view, {
      index: Math.max(0, ordered.findIndex((candidate) => candidate.runId === view.runId)),
      total: ordered.length,
    });
    header.push(renderProgress(theme, width, view));
    if (view.error) header.push(truncateToWidth(`${BLANK}${theme.fg("error", `✗ ${firstLine(view.error)}`)}`, width));
    // The script's `log()` lines and the runtime's own notes (`reusing N
    // completed calls`, `ignored N incomplete journal lines`) — without these a
    // resumed run looks like it did everything live.
    for (const line of view.logs.slice(-RECENT_LOG_LINES)) {
      header.push(truncateToWidth(`${BLANK}${theme.fg("dim", `· ${line}`)}`, width));
    }
    if (view.logsDropped > 0) {
      header.push(truncateToWidth(`${BLANK}${theme.fg("muted", `· … ${view.logsDropped} earlier notes dropped`)}`, width));
    }

    // One label column for the whole list, so the activity column lines up.
    const labelWidth = Math.max(
      8,
      Math.min(calls.reduce((widest, call) => Math.max(widest, visibleWidth(call.label)), 0) + 2, Math.max(8, Math.floor(width * 0.4))),
    );

    // Calls grouped by phase, in first-appearance order. Identical phase strings
    // merge into one group — that is what `opts.phase` exists for in an
    // interleaved pipeline, where calls from one phase settle out of order.
    const groups: Array<{ target: WorkflowPanelSelection | null; lines: string[] }> = [];
    let lastPhase: string | undefined;
    for (const call of calls) {
      const isSelected = sameSelection(state.selection, { kind: "call", callKey: call.callKey });
      const lines: string[] = [];
      const phase = call.phase?.trim();
      if (phase && phase !== lastPhase) {
        lines.push(truncateToWidth(`${BLANK}${theme.fg("muted", phase)}`, width));
      }
      lastPhase = phase;
      lines.push(renderAgentRow(theme, width, call, labelWidth, isSelected, now));
      const menu = state.menu && sameSelection(state.menu.selection, { kind: "call", callKey: call.callKey }) ? state.menu : null;
      if (menu) {
        for (let index = 0; index < menu.actions.length; index++) {
          const action = menu.actions[index];
          const active = menu.index === index;
          const pointer = active ? theme.fg("accent", CURSOR) : BLANK;
          const label = theme.fg(active ? "accent" : "text", action.label.padEnd(9));
          lines.push(
            truncateToWidth(`${BLANK}  ${pointer}${label}${theme.fg("dim", action.hint)}`, width),
          );
        }
      }
      groups.push({ target: { kind: "call", callKey: call.callKey }, lines });
    }

    const runActions = panelActions({ kind: "run", runId: view.runId }, views, this.options.isLive);
    const footer = state.menu
      ? // While the menu is open it owns the keys, so the footer describes it
        // instead of the row.
        renderFooter(theme, width, [["↑/↓ choose", "enter run", "esc cancel"]])
      : renderFooter(theme, width, [
          [
            !state.selection ? null : "enter actions",
            ...panelActions(state.selection, views, this.options.isLive).map((action) => `${action.key} ${action.label}`),
          ].filter((item): item is string => Boolean(item)),
          [
            ...runActions.map((action) => `${action.key} ${action.label}`),
            ...(ordered.length > 1 ? ["[ ] switch run"] : []),
            "q close",
          ],
        ]);

    // Window the rows to what the terminal can hold; the cursor is never
    // scrolled off, so a run with more agents than lines stays reachable.
    const total = groups.reduce((sum, group) => sum + group.lines.length, 0);
    let budget = Number.isFinite(height) ? Math.max(1, Math.floor(height) - header.length - footer.length - 2) : Number.POSITIVE_INFINITY;
    let windowed = false;
    if (total > budget) {
      windowed = true;
      budget = Math.max(1, budget - 1); // the position line takes one of its own
    }

    const focus = groups.findIndex((group) => sameSelection(group.target, state.selection));
    let visible = groups;
    let focusLine = 0;
    if (windowed) {
      const heights = groups.map((group) => group.lines.length);
      const window = fitWindow(heights, budget, focus < 0 ? 0 : focus, state.windowStart);
      state.windowStart = window.start;
      visible = groups.slice(window.start, window.end);
      for (let index = 0; index < Math.max(window.start, focus); index++) focusLine += heights[index];
    }

    const lines = [...header, "", ...visible.flatMap((group) => group.lines), ""];
    if (windowed) lines.push(theme.fg("muted", `  (${Math.min(focusLine + 1, total)}/${total})`));
    lines.push(...footer);
    // Pad to the overlay's width so the block is opaque: an overlay does not
    // clear what is behind it, and the previous session's output would show
    // through every line that is shorter than the screen.
    return lines.map((line) => truncateToWidth(line, width, "", true));
  }

  private emptyPanel(theme: any, width: number): string[] {
    return [theme.fg("dim", `${BLANK}No workflow runs in this session.`), "", ...renderFooter(theme, width, [["q close"]])].map(
      (line) => truncateToWidth(line, width, "", true),
    );
  }

  /** Plain-text rendering for `/workflow` in non-TUI sessions. */
  textReport(): string {
    const views = this.scopedViews();
    if (views.length === 0) return "No workflow runs in this session.";
    const lines: string[] = [];
    for (const view of views) {
      lines.push(`${view.meta.name} — ${view.status} (${Math.round(view.progress * 100)}%)`);
      lines.push(
        `  agents: ${view.activeCount} running, ${view.completedCount} done, ${view.failedCount} failed of ${view.totalCount}`,
      );
      lines.push(`  run:    ${view.runId}`);
      lines.push(`  script: ${view.scriptPath}`);
      lines.push(`  journal: ${view.runDir}/journal.jsonl`);
      let lastPhase: string | undefined;
      for (const call of view.calls) {
        const phase = call.phase?.trim();
        if (phase && phase !== lastPhase) lines.push(`  [${phase}]`);
        lastPhase = phase;
        const model = call.model ? ` [${call.model}]` : "";
        const suffix =
          call.status === "running"
            ? call.live
              ? ` [${liveText(call.live)}]`
              : ""
            : call.error
              ? ` — ${call.error}`
              : "";
        lines.push(`  ${call.status.padEnd(9)} ${call.label}${model}${suffix}`);
      }
      for (const note of view.logs) lines.push(`  · ${note}`);
      lines.push("");
    }
    return lines.join("\n");
  }
}
