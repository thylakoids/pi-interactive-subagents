/**
 * tmux surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the tmux calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). Where a subagent's pane
 * goes — the parent's column, or an overflow window — is decided in `layout.ts`
 * from a snapshot of tmux state; this file reads that snapshot and executes the
 * result. No split ever takes the keyboard focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { surfaceOwnerId } from "./surface-owner.ts";

import {
  MAIN_PANE_WIDTH,
  choosePlacement,
  classifyWindow,
  type PaneInfo,
  type WindowInfo,
} from "./layout.ts";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

/**
 * Panes this process placed, and where each went.
 *
 * Closing a pane has to re-even its window, and the close can arrive after the
 * pane is already gone — at which point tmux can no longer say which window it
 * was in. Remembering the pairing and the tree keeps that repair possible
 * without ever laying out a window this tree does not own.
 */
const surfaceWindows = new Map<string, { window: string; tree: string }>();

/**
 * `display-message` and `list-panes` in one invocation, so placing a pane costs
 * one round trip. Every line carries a literal prefix because an unmarked
 * pane's `@pi_subagent` expands to the empty string, and without a prefix that
 * line would look like a pane that is not there at all.
 *
 * Session names may contain `|`, so the overflow-window target is the session
 * *id* (`$N`), which cannot. Only the free-text window name is parsed from the
 * tail, where `|` is harmless.
 */
const HEAD_FORMAT =
  "H|#{window_id}|#{window_width}|#{window_height}|#{session_id}|#{window_name}";
const PANE_FORMAT =
  "P|#{window_id}|#{window_width}|#{window_height}|#{pane_id}|#{@pi_subagent}";

interface SessionState {
  /** The window holding the anchor pane. */
  window: WindowInfo;
  sessionId: string;
  windowName: string;
  /** Every window in the anchor's session. */
  windows: WindowInfo[];
}

/** Parse the `display-message` head line; the window name is free text. */
export function parseSessionHead(line: string): {
  windowId: string;
  width: number;
  height: number;
  sessionId: string;
  windowName: string;
} {
  const fields = line.split("|");
  return {
    windowId: fields[1] ?? "",
    width: Number(fields[2] ?? "0"),
    height: Number(fields[3] ?? "0"),
    sessionId: fields[4] ?? "",
    windowName: fields.slice(5).join("|"),
  };
}

/**
 * The tree this process belongs to. Subagents inherit it through the
 * environment; a root's tree is its own pane id. The pane mark is deliberately
 * not consulted: it can outlive the process that set it, and a new pi started
 * in a reused pane must not join the old tree.
 */
export function currentTree(): string | undefined {
  return process.env.PI_SUBAGENT_TREE || process.env.TMUX_PANE;
}

function runTmux(args: string[], allowFailure = false): string {
  requireTmux();
  try {
    // Capture stderr instead of inheriting it: best-effort calls commonly probe
    // panes that are already gone, and those tmux errors must not land in the
    // pi TUI. A real failure still carries stderr on the thrown error.
    return execFileSync("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

/** True when tmux lost the pane/window a placement read its snapshot from. */
function isStaleTargetError(error: unknown): boolean {
  const e = error as { stderr?: string | Buffer; message?: string };
  const text = `${e?.stderr ?? ""}\n${e?.message ?? ""}`;
  return /can't find (pane|window)|no space for new pane/.test(text);
}

/** Group `list-panes -s` output into windows, keeping tmux's own pane order. */
function groupWindows(lines: string[]): WindowInfo[] {
  const windows = new Map<string, WindowInfo>();
  for (const line of lines) {
    if (!line.startsWith("P|")) continue;
    const fields = line.split("|");
    if (fields.length < 6) continue;
    const [, id, width, height, pane, tree] = fields;
    let window = windows.get(id);
    if (!window) {
      window = { id, width: Number(width), height: Number(height), panes: [] };
      windows.set(id, window);
    }
    window.panes.push({ id: pane, tree: tree ?? "" });
  }
  return [...windows.values()];
}

function readSessionState(anchor: string): SessionState {
  const raw = runTmux([
    "display-message", "-p", "-t", anchor, HEAD_FORMAT,
    ";",
    "list-panes", "-s", "-t", anchor, "-F", PANE_FORMAT,
  ]);
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const headLine = lines.find((line) => line.startsWith("H|"));
  if (!headLine) throw new Error(`Cannot read the tmux window holding pane ${anchor}.`);

  const head = parseSessionHead(headLine);
  const windows = groupWindows(lines);
  const window = windows.find((candidate) => candidate.id === head.windowId);
  if (!window) throw new Error(`tmux reported no panes for window ${head.windowId}.`);

  return {
    window,
    sessionId: head.sessionId,
    windowName: head.windowName,
    windows,
  };
}

/**
 * A name for an overflow window that says whose subagents are inside it.
 * Cosmetic only: windows are found by their panes' marks, never by name, so a
 * rename cannot break discovery.
 */
function overflowWindowName(homeName: string, windows: WindowInfo[], tree: string): string {
  const base = (homeName || "sub").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 10) || "sub";
  const existing = windows.filter(
    (window) => window.panes.length > 0 && window.panes.every((pane) => pane.tree === tree),
  ).length;
  return `${base}+${existing + 1}`;
}

/** Parse `P|#{pane_id}|#{@pi_subagent}` lines, keeping tmux's pane order. */
function parsePaneMarks(lines: string[]): PaneInfo[] {
  const panes: PaneInfo[] = [];
  for (const line of lines) {
    if (!line.startsWith("P|")) continue;
    const fields = line.split("|");
    if (fields.length < 3) continue;
    panes.push({ id: fields[1], tree: fields[2] ?? "" });
  }
  return panes;
}

/** The pane's window and its panes, or nothing when the pane is gone. */
function readPaneWindow(pane: string): { window: string; panes: PaneInfo[] } | undefined {
  const raw = runTmux(
    [
      "display-message", "-p", "-t", pane, "W|#{window_id}",
      ";",
      "list-panes", "-t", pane, "-F", "P|#{pane_id}|#{@pi_subagent}",
    ],
    true,
  );
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const head = lines.find((line) => line.startsWith("W|"));
  if (!head) return undefined;
  const panes = parsePaneMarks(lines);
  if (panes.length === 0) return undefined;
  return { window: head.slice(2), panes };
}

/** A window's panes by window id, or nothing when the window is gone. */
function readWindowPanes(window: string): PaneInfo[] | undefined {
  const raw = runTmux(
    ["list-panes", "-t", window, "-F", "P|#{pane_id}|#{@pi_subagent}"],
    true,
  );
  const panes = parsePaneMarks(raw.split("\n"));
  return panes.length > 0 ? panes : undefined;
}

/**
 * The layout this tree may apply to a window after closing one of its panes,
 * or nothing when the window is not this tree's to rearrange.
 */
function ownedLayout(
  panes: PaneInfo[],
  tree: string,
): "main-vertical" | "tiled" | undefined {
  const kind = classifyWindow({ id: "", width: 0, height: 0, panes }, tree);
  if (kind === "home") return "main-vertical";
  if (kind === "overflow") return "tiled";
  return undefined;
}

// ── Surface primitives ──

/**
 * Create a pane for a subagent: the parent window's column when it has room, an
 * overflow window otherwise. Placement is decided in `layout.ts`.
 *
 * The split and the layout go out as ONE tmux invocation, because a client
 * renders one frame per invocation — that is what stops the pane appearing in a
 * half-arranged window first. It is also why every placement ends in a
 * `select-layout` even when the split looks like it lands correctly on its own:
 * two processes placing panes at once can both act on the same stale read, and
 * the layout call is what guarantees the window is still `[parent | column]`
 * afterwards.
 *
 * Read-decide-act must stay synchronous — no `await`, no timer between the read
 * and the invocation that acts on it — or two spawns from this process could
 * interleave and reintroduce that race.
 *
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurface(name: string): string {
  void name; // tmux panes are not named; the pi process inside shows its own title.
  const anchor = process.env.TMUX_PANE;
  if (!anchor) {
    throw new Error(`Subagent panes need the parent's tmux pane. ${muxSetupHint()}`);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return createSurfaceFor(anchor);
    } catch (error) {
      lastError = error;
      // The pane chosen as the split target can finish and be closed by its
      // owner between the snapshot and the split. Re-read and place again.
      if (!isStaleTargetError(error)) throw error;
    }
  }
  throw lastError;
}

function createSurfaceFor(anchor: string): string {
  const state = readSessionState(anchor);
  // The tree is inherited, not inferred from a pane mark: a mark can outlive
  // the subagent and be inherited by a new pi started in the same pane.
  const tree = process.env.PI_SUBAGENT_TREE || anchor;
  const placement = choosePlacement({
    home: state.window,
    anchor,
    tree,
    windows: state.windows,
  });

  let pane: string;
  let window: string;
  if (placement.kind === "column") {
    window = placement.window;
    pane = runTmux([
      "set-option", "-w", "-t", placement.window, "main-pane-width", MAIN_PANE_WIDTH,
      ";",
      "split-window", "-d", placement.direction === "h" ? "-h" : "-v",
      "-t", placement.target, "-P", "-F", "#{pane_id}",
      ";",
      "select-layout", "-t", placement.window, "main-vertical",
    ]).trim();
  } else if (placement.kind === "overflow-add") {
    window = placement.window;
    pane = runTmux([
      "split-window", "-d", "-v", "-t", placement.target, "-P", "-F", "#{pane_id}",
      ";",
      "select-layout", "-t", placement.window, "tiled",
    ]).trim();
  } else {
    // A new window's first pane is an ordinary shell, so it can be the
    // subagent's pane directly — no placeholder to create and clean up.
    [window, pane] = runTmux([
      "new-window", "-d", "-t", `${state.sessionId}:`,
      "-n", overflowWindowName(state.windowName, state.windows, tree),
      "-P", "-F", "#{window_id} #{pane_id}",
    ]).trim().split(/\s+/);
    // Otherwise tmux renames the window after whatever runs in it.
    runTmux(["set-option", "-w", "-t", window, "automatic-rename", "off"], true);
  }

  if (!pane?.startsWith("%") || !window?.startsWith("@")) {
    throw new Error(
      `Unexpected tmux output while creating a subagent pane: window=${window} pane=${pane}`,
    );
  }
  // Layout-neutral, so it renders no frame; see the mark's role in layout.ts.
  runTmux(["set-option", "-p", "-t", pane, "@pi_subagent", tree], true);
  runTmux(["set-option", "-p", "-t", pane, "@pi_subagent_parent", anchor], true);
  runTmux(["set-option", "-p", "-t", pane, "@pi_subagent_owner", surfaceOwnerId()]);
  surfaceWindows.set(pane, { window, tree });
  return pane;
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireTmux();

  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  runTmux(["set-option", "-p", "-t", pane, "@pi_subagent_owner", surfaceOwnerId()]);

  return pane;
}

/** Only resources bearing this exact process incarnation's token may be reaped. */
export function reapSurfaceOwner(directory: string): void {
  const owner = basename(directory);
  const rows = runTmux(["list-panes", "-a", "-F", "#{pane_id}|#{@pi_subagent_owner}"], true);
  for (const row of rows.trim().split("\n")) {
    const [pane, token] = row.split("|");
    if (token !== owner) continue;
    closeSurfaceTree(pane);
  }
  rmSync(directory, { recursive: true, force: true });
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/** Select a pane and its window without submitting input to the child. */
export function focusSurface(surface: string): void {
  requireTmux();
  runTmux(["select-window", "-t", surface, ";", "select-pane", "-t", surface]);
}

export function surfaceExists(surface: string): boolean {
  try {
    return runTmux(["display-message", "-p", "-t", surface, "#{pane_id}"]).trim() === surface;
  } catch {
    return false;
  }
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  // The leading space is deliberate: zsh's HIST_IGNORE_SPACE (set by
  // oh-my-zsh and most zsh setups) keeps space-prefixed lines out of the
  // user's history file. Without it every spawn wrote a dead
  // `bash /path/to/subagent-scripts/<id>.sh` entry to ~/.zsh_history,
  // which piles up in history search and autosuggestions. The shell ignores
  // the space itself, so nothing else changes.
  sendCommand(surface, ` bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/** Close only this pane and its delegated descendants, including overflow windows. */
export function closeSurfaceTree(root: string): void {
  requireTmux();
  const rows = runTmux(["list-panes", "-a", "-F", "#{pane_id}|#{@pi_subagent_parent}"], true)
    .trim().split("\n").map(line => line.split("|"));
  const owned = new Set([root]);
  const order = [root];
  for (let i = 0; i < order.length; i++) {
    for (const [pane, parent] of rows) {
      if (parent === order[i] && pane && !owned.has(pane)) { owned.add(pane); order.push(pane); }
    }
  }
  // Detached bash tools (and timeout's separate process group) do not receive
  // the pane's SIGHUP. Stop their actual descendants before losing the ancestry.
  const roots = runTmux(["list-panes", "-a", "-F", "#{pane_id}|#{pane_pid}|#{pane_dead}"], true)
    .trim().split("\n").map(line => line.split("|"))
    .filter(([pane, , dead]) => owned.has(pane) && dead !== "1")
    .map(([, pid]) => Number(pid)).filter(pid => pid > 0);
  const processes = execFileSync("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8" })
    .trim().split("\n").map(line => {
      const [, pid, parent, command] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)!;
      return { pid: Number(pid), parent: Number(parent), command };
    });
  const descendants = [...roots];
  const found = new Set(roots);
  for (let i = 0; i < descendants.length; i++) {
    for (const child of processes) {
      if (child.parent === descendants[i] && !found.has(child.pid)) {
        found.add(child.pid); descendants.push(child.pid);
      }
    }
  }
  const guardian = fileURLToPath(new URL("./surface-guardian.ts", import.meta.url));
  for (const pid of descendants.slice(roots.length).reverse()) {
    // Guardians must survive to consume EOF and remove their own scratch.
    if (processes.find(child => child.pid === pid)!.command.startsWith(`${process.execPath} ${guardian} `)) continue;
    try { process.kill(pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  for (const pane of order.reverse()) closeSurface(pane);
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireTmux();
  const remembered = surfaceWindows.get(surface);
  surfaceWindows.delete(surface);

  const live = readPaneWindow(surface);
  const window = live?.window ?? remembered?.window;
  if (!window) {
    runTmux(["kill-pane", "-t", surface], true);
    return;
  }

  // Never lay out a window we do not own. The pane's mark is this tree's id;
  // if the pane is gone, the tree recorded when we placed it is still valid.
  const tree = live?.panes.find((pane) => pane.id === surface)?.tree || remembered?.tree;
  const panes = live?.panes ?? readWindowPanes(window);
  const layout = tree && panes ? ownedLayout(panes, tree) : undefined;

  if (!live) {
    // The pane is gone; re-even its window only if it is still ours.
    if (layout) runTmux(["select-layout", "-t", window, layout], true);
    return;
  }
  // A tmux command that fails aborts the rest of the command list, so the kill
  // and the re-layout are bundled only when the read above proved the pane is
  // still there to kill.
  if (live.panes.length === 1 || !layout) {
    // The window closes with its last pane; a foreign window is left alone.
    runTmux(["kill-pane", "-t", surface], true);
    return;
  }
  runTmux(["kill-pane", "-t", surface, ";", "select-layout", "-t", window, layout], true);
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error" | "closed";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

function readExitSidecar(sessionFile: string): PollResult | null {
  try {
    const exitFile = `${sessionFile}.exit`;
    if (!existsSync(exitFile)) return null;
    const data = JSON.parse(readFileSync(exitFile, "utf-8"));
    rmSync(exitFile, { force: true });
    return interpretExitSidecar(data);
  } catch { return null; }
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    cli?: boolean;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      const exit = readExitSidecar(options.sessionFile);
      if (exit) return exit;
    }

    // Check the native CLI hook result (or shell-exit result).
    if (options.sentinelFile && existsSync(options.sentinelFile)) {
      return { reason: "sentinel", exitCode: 0 };
    }

    if (options.cli && options.sentinelFile) {
      const diagnostic = `${options.sentinelFile}.hook-error`;
      if (existsSync(diagnostic)) {
        try {
          const data = JSON.parse(readFileSync(diagnostic, "utf8"));
          return { reason: "error", exitCode: 1, errorMessage: data.errorMessage };
        } catch (error: any) {
          return { reason: "error", exitCode: 1, errorMessage: `Cannot read CLI hook diagnostic: ${error.message}` };
        }
      }
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match && !options.cli) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Native pane exits are definitive: no surrounding shell survives it.
      if (options.cli) {
        if (options.sentinelFile && existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
        return { reason: "error", exitCode: 1, errorMessage: "Native CLI pane closed before reporting completion." };
      }
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        const exit = readExitSidecar(options.sessionFile);
        if (exit) return exit;
      }
      return { reason: "closed", exitCode: 1, errorMessage: "Pi subagent pane unavailable before reporting completion." };
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Launch a native CLI as the pane process, with no shell left behind. */
export function startSurfaceProcess(surface: string, scriptPath: string): void {
  requireTmux();
  execFileSync("tmux", ["respawn-pane", "-k", "-t", surface,
    `exec bash ${shellEscape(scriptPath)}`], { encoding: "utf8" });
}

/** Bracketed paste preserves multiline text as one TUI submission. */
export function pasteMessage(surface: string, message: string): void {
  requireTmux();
  const buffer = `pi-message-${process.pid}-${Math.random().toString(16).slice(2)}`;
  execFileSync("tmux", ["load-buffer", "-b", buffer, "-"], { input: message, encoding: "utf8" });
  try {
    execFileSync("tmux", ["paste-buffer", "-p", "-r", "-d", "-b", buffer, "-t", surface]);
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"]);
  } finally {
    try { execFileSync("tmux", ["delete-buffer", "-b", buffer], { stdio: "ignore" }); } catch {}
  }
}
