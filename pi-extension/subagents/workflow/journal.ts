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
import { closeSync, existsSync, fsyncSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
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
export interface CallIdentity {
  kind: string;
  label: string;
  prompt: string;
  schema?: unknown;
  agent?: string;
  model?: string;
  effort?: string;
  readOnly?: boolean;
  isolation?: "worktree";
}

/** Display labels are deliberately absent; ordinal suffixes distinguish samples. */
export function callKey(parts: CallIdentity): string {
  const basis = [
    "v2", parts.kind, parts.agent ?? "", parts.model ?? "", parts.effort ?? "",
    parts.prompt, parts.schema === undefined ? "" : JSON.stringify(parts.schema),
    parts.readOnly ? "readOnly" : "", parts.isolation ?? "",
  ].join("\u0000");
  return createHash("sha256").update(basis).digest("hex").slice(0, 24);
}

/** Compatibility lookup only: old journals used the cosmetic label as identity. */
export function legacyCallKey(parts: CallIdentity): string {
  const basis = [
    parts.kind,
    parts.label,
    parts.agent ?? "",
    parts.model ?? "",
    parts.effort ?? "",
    parts.prompt,
    parts.schema === undefined ? "" : JSON.stringify(parts.schema),
    // Keep old writable keys stable while separating permission-restricted calls.
    ...(parts.readOnly ? ["readOnly"] : []),
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
  const fd = openSync(path, "a+");
  try {
    const size = fstatSync(fd).size;
    const tail = Buffer.alloc(1);
    // A killed append may leave a partial line. Never join the next result to it.
    const separator = size > 0 && readSync(fd, tail, 0, 1, size - 1) === 1 && tail[0] !== 10 ? "\n" : "";
    const bytes = Buffer.from(separator + JSON.stringify(entry) + "\n");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error("Workflow journal write made no progress.");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface JournalLoad {
  entries: Map<string, WorkflowJournalEntry>;
  records: WorkflowJournalEntry[];
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
  const records: WorkflowJournalEntry[] = [];
  let skippedLines = 0;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return { entries, records, skippedLines };
    // An unreadable existing journal is not an empty history: treating it as
    // one would execute already-settled side effects again during recovery.
    throw error;
  }

  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as WorkflowJournalEntry;
      if (parsed?.type === "call" && typeof parsed.callKey === "string") {
        entries.set(parsed.callKey, parsed);
        records.push(parsed);
      }
    } catch {
      skippedLines++;
    }
  }
  return { entries, records, skippedLines };
}

/**
 * Exclusive run lock. `openSync(..., "wx")` fails when another process holds
 * the run, which is what stops a second resume from re-running a live script.
 * A lock whose owner pid is gone is treated as stale and reclaimed.
 */
type LockResult = { ok: true; path: string } | { ok: false; ownerPid: number; reason?: string };
const ownedLocks = new Map<string, string>();

export function acquireLock(runDir: string): LockResult {
  const path = join(runDir, "lock");
  const token = randomBytes(16).toString("hex");
  const payload = JSON.stringify({ pid: process.pid, at: Date.now(), token });
  if (createLock(path, payload, token)) return { ok: true, path };

  // Serialize stale-owner inspection AND replacement. Overwriting a stale file
  // directly lets two rescuers both acquire it, even if each uses wx initially.
  const guard = `${path}.reclaim`;
  try {
    mkdirSync(guard);
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    return { ok: false, ownerPid: 0, reason: "another recovery owns lock.reclaim; an abandoned recovery guard requires manual inspection" };
  }
  try {
    // The previous owner may have released while we were acquiring the guard.
    if (createLock(path, payload, token)) return { ok: true, path };
    const existing = readJson<{ pid?: number }>(path);
    const ownerPid = Number.isSafeInteger(existing?.pid) && existing!.pid! > 0 ? existing!.pid! : 0;
    if (ownerPid === 0) {
      return { ok: false, ownerPid, reason: "lock owner is unreadable; manual inspection required" };
    }
    if (isProcessAlive(ownerPid)) {
      return { ok: false, ownerPid };
    }
    unlinkSync(path);
    // A fresh acquire can win after unlink; wx, never overwrite, decides ownership.
    return createLock(path, payload, token) ? { ok: true, path } : { ok: false, ownerPid: 0 };
  } finally {
    rmdirSync(guard);
  }
}

function createLock(path: string, payload: string, token: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error: any) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(fd, payload, "utf8");
    fsyncSync(fd);
    ownedLocks.set(path, token);
    return true;
  } catch (error) {
    unlinkSync(path);
    throw error;
  } finally {
    closeSync(fd);
  }
}

export function releaseLock(path: string): void {
  const token = ownedLocks.get(path);
  if (!token) return;
  ownedLocks.delete(path);
  try {
    if (readJson<{ token?: string }>(path)?.token === token) unlinkSync(path);
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
