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
import { closeSync, existsSync, fsyncSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { runLockTransaction, type RunLockResult } from "./run-lock.ts";
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

/** Atomic text write: temp file in the same directory, then rename. */
export function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/** Atomic JSON write with the same publication contract as text. */
export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2));
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

/** Logical ownership outlives the short, crash-released kernel transaction. */
const ownedLocks = new Map<string, string>();
const pendingReleases = new Map<string, string>();
const lockTransactions = new Map<string, Promise<void>>();

/** Keep token bookkeeping and all its helper transactions in one per-path turn. */
function serializeLock<T>(path: string, transaction: () => Promise<T>): Promise<T> {
  const result = (lockTransactions.get(path) ?? Promise.resolve()).then(transaction);
  const settled = result.then(() => {}, () => {});
  lockTransactions.set(path, settled);
  void settled.then(() => {
    if (lockTransactions.get(path) === settled) lockTransactions.delete(path);
  });
  return result;
}

export async function acquireLock(runDir: string, resourceOwner?: string): Promise<RunLockResult> {
  const path = join(runDir, "lock");
  return serializeLock(path, async () => {
    const pending = pendingReleases.get(path);
    if (pending) {
      if (!await releaseToken(path, pending)) return { ok: false, ownerPid: process.pid, reason: "previous owned release still cannot be persisted" };
      pendingReleases.delete(path);
      if (ownedLocks.get(path) === pending) ownedLocks.delete(path);
    }
    const token = randomBytes(16).toString("hex");
    let result;
    try {
      result = await runLockTransaction(runDir, "acquire", token, resourceOwner);
    } catch (error) {
      // A helper may die after publishing but before returning its acknowledgement.
      // Remove only this attempt's token, never an unrelated or legacy owner.
      if (!await releaseToken(path, token)) pendingReleases.set(path, token);
      throw error;
    }
    if (result.ok) ownedLocks.set(result.path, token);
    return result;
  });
}

async function releaseToken(path: string, token: string): Promise<boolean> {
  // Token-checked release is idempotent, even if the acknowledgement is lost.
  for (let attempt = 0; attempt < 2; attempt++) {
    try { if ((await runLockTransaction(dirname(path), "release", token)).ok) return true; } catch { /* Retry a killed helper once. */ }
  }
  return false;
}

export async function releaseLock(path: string): Promise<boolean> {
  return serializeLock(path, async () => {
    const token = ownedLocks.get(path);
    if (!token) return true;
    if (!await releaseToken(path, token)) {
      // A storage outage must not replace the workflow's result with a teardown
      // exception. Retain the token and retry on the next same-process acquisition.
      pendingReleases.set(path, token);
      return false;
    }
    ownedLocks.delete(path);
    pendingReleases.delete(path);
    return true;
  });
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
