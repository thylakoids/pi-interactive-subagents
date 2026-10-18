/**
 * Durable storage for workflow runs.
 *
 * Layout (per run):
 *   <runsDir>/<runId>/script.js      exact source, so a resume cannot miss the edit
 *   <runsDir>/<runId>/snapshot.json  run metadata + args + seed + final result
 *   <runsDir>/<runId>/journal.jsonl  one line per settled call, in settle order
 *   <runsDir>/<runId>/output.json    the script's returned value
 *   <runsDir>/<runId>/lock           held while a runner is live
 *
 * Resume reads the journal back into a callKey → entry map. Keys are content
 * hashes, never arrival order, so a different completion order after a crash
 * still replays the same results. Entries are appended only after the value is
 * known, so a truncated last line is always the one to discard.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { WorkflowJournalEntry, WorkflowMeta, WorkflowRunSnapshot } from "./types.ts";

export const RUNS_DIRNAME = "workflows";

export function ensureRunDir(baseDir: string, runId: string): string {
  const dir = join(baseDir, RUNS_DIRNAME, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function runsRoot(baseDir: string): string {
  return join(baseDir, RUNS_DIRNAME);
}

/** Random, filesystem-safe run id. Host-side randomness, so resume stays deterministic. */
export function newRunId(): string {
  return `wf-${randomBytes(6).toString("hex")}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Stable 32-bit seed for the script VM, persisted so resume replays randomness. */
export function newSeed(): number {
  return randomBytes(4).readUInt32BE(0);
}

/**
 * Key for one `agent()` call: identity plus content, never completion order.
 *
 * The model and effort are part of the basis because they are part of what the
 * call *is*: bumping a verify stage from the cheap model to the strong one has
 * to re-run it, not replay the cheap answer under the new label.
 *
 * Two identical calls in one script are not the same call — a three-refuter
 * adversarial check is three samples, not one replayed three times — so the
 * caller appends an occurrence ordinal to the returned key.
 */
export function callKey(parts: {
  kind: string;
  label: string;
  prompt: string;
  schema?: unknown;
  agent?: string;
  model?: string;
  effort?: string;
}): string {
  const basis = [
    parts.kind,
    parts.label,
    parts.agent ?? "",
    parts.model ?? "",
    parts.effort ?? "",
    parts.prompt,
    parts.schema === undefined ? "" : JSON.stringify(parts.schema),
  ].join("\u0000");
  return createHash("sha256").update(basis).digest("hex").slice(0, 24);
}

/** Second and later occurrences of an identical call: `abc123…-1`, `-2`, … */
export function occurrenceKey(base: string, occurrence: number): string {
  return occurrence === 0 ? base : `${base}-${occurrence}`;
}

/** Atomic JSON write: temp file in the same directory, then rename. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Append one journal line and flush, so a crash never loses a settled call. */
export function appendJournal(path: string, entry: WorkflowJournalEntry): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, JSON.stringify(entry) + "\n");
  } finally {
    closeSync(fd);
  }
}

export interface JournalLoad {
  entries: Map<string, WorkflowJournalEntry>;
  /** Entries physically present before a truncated/corrupt line, for reporting. */
  skippedLines: number;
}

/**
 * Read a journal back. Lines that fail to parse are counted and ignored: only
 * a partially written last line can be corrupt, and everything before it is
 * still valid.
 */
export function loadJournal(path: string): JournalLoad {
  const entries = new Map<string, WorkflowJournalEntry>();
  let skippedLines = 0;
  if (!existsSync(path)) return { entries, skippedLines };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { entries, skippedLines };
  }

  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as WorkflowJournalEntry;
      if (parsed?.type === "call" && typeof parsed.callKey === "string") {
        entries.set(parsed.callKey, parsed);
      }
    } catch {
      skippedLines++;
    }
  }
  return { entries, skippedLines };
}

/**
 * Exclusive run lock. `openSync(..., "wx")` fails when another process holds
 * the run, which is what stops a second resume from re-running a live script.
 * A lock whose owner pid is gone is treated as stale and reclaimed.
 */
export function acquireLock(runDir: string): { ok: true; path: string } | { ok: false; ownerPid: number } {
  const path = join(runDir, "lock");
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() });
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, payload);
    closeSync(fd);
    return { ok: true, path };
  } catch {
    const existing = readJson<{ pid?: number }>(path);
    const ownerPid = typeof existing?.pid === "number" ? existing.pid : 0;
    if (ownerPid > 0 && !isProcessAlive(ownerPid)) return reclaimLock(path, payload, ownerPid);
    // An unreadable lock is one whose owner died between creating the file and
    // writing its pid. It must not block the run forever — but the write is
    // immediate, so only an old one is treated as abandoned.
    if (ownerPid === 0 && isAbandonedLock(path)) return reclaimLock(path, payload, 0);
    return { ok: false, ownerPid };
  }
}

function reclaimLock(path: string, payload: string, ownerPid: number): { ok: true; path: string } | { ok: false; ownerPid: number } {
  try {
    writeFileSync(path, payload, "utf8");
    return { ok: true, path };
  } catch {
    return { ok: false, ownerPid };
  }
}

/** A lock with no readable owner is stale once it is older than the write. */
function isAbandonedLock(path: string, graceMs = 5_000): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > graceMs;
  } catch {
    return false;
  }
}

export function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

export function snapshotPath(runDir: string): string {
  return join(runDir, "snapshot.json");
}

export function journalPath(runDir: string): string {
  return join(runDir, "journal.jsonl");
}

export function scriptPath(runDir: string): string {
  return join(runDir, "script.js");
}

export function outputPath(runDir: string): string {
  return join(runDir, "output.json");
}

export function loadSnapshot(runDir: string): WorkflowRunSnapshot | null {
  return readJson<WorkflowRunSnapshot>(snapshotPath(runDir));
}

export function saveSnapshot(runDir: string, snapshot: WorkflowRunSnapshot): void {
  writeJsonAtomic(snapshotPath(runDir), snapshot);
}

export function listRunDirs(baseDir: string): string[] {
  const root = runsRoot(baseDir);
  if (!existsSync(root)) return [];
  try {
    return readdirSafe(root).filter((name) => !name.startsWith(".")).sort();
  } catch {
    return [];
  }
}

function readdirSafe(dir: string): string[] {
  return readdirSync(dir);
}

export function isValidMeta(meta: unknown): meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") return false;
  const m = meta as Record<string, unknown>;
  if (typeof m.name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(m.name)) return false;
  if (typeof m.description !== "string" || !m.description.trim()) return false;
  // `phases` is display-only, so it accepts both the bare-string form and the
  // `{ title, detail }` objects a script written for Claude Code carries.
  if (m.phases !== undefined) {
    if (!Array.isArray(m.phases) || !m.phases.every(isValidPhase)) return false;
  }
  if (m.whenToUse !== undefined && typeof m.whenToUse !== "string") return false;
  if (m.agent !== undefined && typeof m.agent !== "string") return false;
  return true;
}

function isValidPhase(phase: unknown): boolean {
  if (typeof phase === "string") return Boolean(phase.trim());
  if (!phase || typeof phase !== "object" || Array.isArray(phase)) return false;
  const p = phase as Record<string, unknown>;
  if (typeof p.title !== "string" || !p.title.trim()) return false;
  if (p.detail !== undefined && typeof p.detail !== "string") return false;
  if (p.model !== undefined && typeof p.model !== "string") return false;
  return true;
}
