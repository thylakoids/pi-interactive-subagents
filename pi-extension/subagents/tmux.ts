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
import { dirname, join } from "node:path";

import { MAIN_PANE_WIDTH, choosePlacement, type WindowInfo } from "./layout.ts";

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
 * was in. Remembering the pairing keeps that repair possible.
 */
const surfaceWindows = new Map<string, { window: string; home: boolean }>();

/**
 * `display-message` and `list-panes` in one invocation, so placing a pane costs
 * one round trip. Every line carries a literal prefix because an unmarked
 * pane's `@pi_subagent` expands to the empty string, and without a prefix that
 * line would look like a pane that is not there at all.
 *
 * The free-text fields come last so a `|` inside a session or window name
 * cannot shift the fields that are read by position.
 */
const HEAD_FORMAT =
  "H|#{window_id}|#{window_width}|#{window_height}|#{@pi_subagent}|#{session_name}|#{window_name}";
const PANE_FORMAT =
  "P|#{window_id}|#{window_width}|#{window_height}|#{pane_id}|#{@pi_subagent}";

interface SessionState {
  /** The window holding the anchor pane. */
  window: WindowInfo;
  sessionName: string;
  windowName: string;
  /** The anchor's own tree mark; empty when this process is the tree's root. */
  anchorTree: string;
  /** Every window in the anchor's session. */
  windows: WindowInfo[];
}

function runTmux(args: string[], allowFailure = false): string {
  requireTmux();
  try {
    return execFileSync("tmux", args, { encoding: "utf8" });
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
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
  const head = lines.find((line) => line.startsWith("H|"));
  if (!head) throw new Error(`Cannot read the tmux window holding pane ${anchor}.`);

  const fields = head.split("|");
  const windows = groupWindows(lines);
  const window = windows.find((candidate) => candidate.id === fields[1]);
  if (!window) throw new Error(`tmux reported no panes for window ${fields[1]}.`);

  return {
    window,
    anchorTree: fields[4] ?? "",
    sessionName: fields[5] ?? "",
    windowName: fields.slice(6).join("|"),
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

/** The pane's window, or nothing when the pane is already gone. */
function readPaneWindow(
  pane: string,
): { window: string; panes: number; hasMain: boolean } | undefined {
  const raw = runTmux(
    [
      "display-message", "-p", "-t", pane, "W|#{window_id}",
      ";",
      "list-panes", "-t", pane, "-F", "P|#{@pi_subagent}",
    ],
    true,
  );
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const head = lines.find((line) => line.startsWith("W|"));
  if (!head) return undefined;
  const marks = lines.filter((line) => line.startsWith("P|")).map((line) => line.slice(2));
  if (marks.length === 0) return undefined;
  return {
    window: head.slice(2),
    panes: marks.length,
    // An unmarked pane means the window has a main pane, i.e. it is a home window.
    hasMain: marks.some((mark) => mark === ""),
  };
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

  const state = readSessionState(anchor);
  const tree = state.anchorTree || anchor;
  const placement = choosePlacement({
    home: state.window,
    anchor,
    tree,
    windows: state.windows,
  });

  let pane: string;
  let window: string;
  let home: boolean;
  if (placement.kind === "column") {
    home = true;
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
    home = false;
    window = placement.window;
    pane = runTmux([
      "split-window", "-d", "-v", "-t", placement.target, "-P", "-F", "#{pane_id}",
      ";",
      "select-layout", "-t", placement.window, "tiled",
    ]).trim();
  } else {
    home = false;
    // A new window's first pane is an ordinary shell, so it can be the
    // subagent's pane directly — no placeholder to create and clean up.
    [window, pane] = runTmux([
      "new-window", "-d", "-t", `${state.sessionName}:`,
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
  surfaceWindows.set(pane, { window, home });
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

  return pane;
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
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
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

  // A tmux command that fails aborts the rest of the command list, so the kill
  // and the re-layout are bundled only when the read above proved the pane is
  // still there to kill.
  const home = live ? live.hasMain : (remembered?.home ?? true);
  const layout = home ? "main-vertical" : "tiled";
  if (!live) {
    // The pane is gone; its window still needs its proportions evened out.
    runTmux(["select-layout", "-t", window, layout], true);
  } else if (live.panes === 1) {
    // The window closes with its last pane; a trailing layout call would just
    // return exit 1.
    runTmux(["kill-pane", "-t", surface], true);
  } else {
    runTmux(["kill-pane", "-t", surface, ";", "select-layout", "-t", window, layout], true);
  }
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
