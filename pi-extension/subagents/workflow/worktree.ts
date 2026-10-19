/**
 * Git worktree isolation for a single workflow call.
 *
 * A call that runs with `isolation: 'worktree'` gets its own detached worktree,
 * created from the repository HEAD at the moment the call starts, so parallel
 * calls cannot see or overwrite each other's files. The worktree lives inside the
 * run's own artifact directory - `<runDir>/worktrees/<callKey>` - and is never
 * moved, reset, cleaned or force-removed by this module.
 *
 * Three properties matter more than convenience:
 *
 *  - **One creator per call.** A cross-process lock (`worktrees/.<callKey>.lock`)
 *    is held from the existence check through `git worktree add` and the metadata
 *    write. A second creator either waits for the caller's signal or refuses with
 *    the lock owner spelled out; an unknown owner's lock is never removed
 *    automatically, because a stale lock is a human decision, not a guess.
 *  - **A completed worktree is always reusable.** Once `git worktree add` has
 *    succeeded, the metadata finalization runs without the caller's signal. An
 *    abort that lands in that window still raises `WorktreeAbortError`, but the
 *    worktree and its metadata are kept, so a retry reuses them instead of
 *    finding an unowned directory.
 *  - **Cancellation never races git.** An abort kills the git process group and
 *    only then rejects, so cleanup can never run while git is still writing.
 *
 * Re-entry validates that the path is *this* call's worktree of *this* repository
 * and reuses it verbatim; anything the agent wrote or committed inside stays.
 * Errors are explicit: a non-git directory, a foreign path, a missing or
 * mismatched metadata file, or an unsafe call key are all refused without
 * touching what is already there.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface WorkflowWorktreeOptions {
  /** Working directory of the workflow run; must be inside a git repository. */
  cwd: string;
  /** The run's artifact directory. The worktree lives under `<runDir>/worktrees`. */
  runDir: string;
  /** Content key of the call. The worktree name is derived from it. */
  callKey: string;
  signal?: AbortSignal;
}

export interface WorkflowWorktree {
  /** Absolute path of the worktree, to be used as the agent's working directory. */
  cwd: string;
  /** Repository root the worktree belongs to. */
  repoRoot: string;
  /** Commit the worktree was created from; unchanged when a worktree is reused. */
  baseCommit: string;
  /** The call key this worktree belongs to. */
  callKey: string;
  /** False when an existing worktree of this call was reused as-is. */
  created: boolean;
}

/** A worktree could not be prepared; the message is safe to show to a user. */
export class WorktreeIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeIsolationError";
  }
}

/** The caller cancelled worktree preparation. */
export class WorktreeAbortError extends Error {
  constructor(message = "worktree preparation was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export function isWorktreeAbort(error: unknown): boolean {
  return (
    error instanceof WorktreeAbortError ||
    (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError")
  );
}

/** Plain names only: the key becomes a single path segment. */
const SAFE_CALL_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const META_FILE = "pi-worktree.json";
const LOCK_OWNER = "owner.json";
const MAX_CAPTURE = 1 << 20;
const LOCK_POLL_MS = 50;

function refuse(message: string): never {
  throw new WorktreeIsolationError(message);
}

function assertCallKey(callKey: string): void {
  if (!SAFE_CALL_KEY.test(callKey) || callKey.includes("..")) {
    refuse(
      "worktree isolation needs a plain call key (letters, digits, dot, dash, underscore; " +
        "no path separators, no '..', no absolute path), got " + JSON.stringify(callKey),
    );
  }
}

/** Real path when it exists, resolved path otherwise (symlinked tmp dirs). */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run git in its own process group.
 *
 * An abort kills the group but does NOT reject yet: the promise settles only when
 * git has actually closed, so a caller's cleanup can never race a git process
 * that is still writing into the worktree.
 */
function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<GitResult> {
  if (signal?.aborted) return Promise.reject(new WorktreeAbortError());
  return new Promise<GitResult>((settle, fail) => {
    let child;
    try {
      child = spawn("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: process.env,
      });
    } catch (error: any) {
      fail(new WorktreeIsolationError("could not run git: " + (error?.message ?? error)));
      return;
    }
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let done = false;
    const finish = (action: () => void) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const killGroup = () => {
      if (typeof child.pid !== "number") return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };
    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      finish(() =>
        fail(
          aborted
            ? new WorktreeAbortError()
            : new WorktreeIsolationError("could not run git: " + error.message),
        ),
      ),
    );
    child.on("close", (code) =>
      finish(() => {
        if (aborted) fail(new WorktreeAbortError());
        else settle({ code: code ?? 1, stdout, stderr });
      }),
    );
  });
}

async function git(cwd: string, args: string[], signal: AbortSignal | undefined, what: string): Promise<string> {
  const result = await runGit(cwd, args, signal);
  if (result.code !== 0) {
    refuse(what + " failed (git " + args.join(" ") + "): " + (result.stderr.trim() || "exit " + result.code));
  }
  return result.stdout.trim();
}

interface WorktreeLock {
  path: string;
  release(): void;
}

function lockFile(worktreesRoot: string, callKey: string): string {
  return join(worktreesRoot, "." + callKey + ".lock");
}

function lockOwner(lockPath: string): string {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, LOCK_OWNER), "utf8")) as {
      pid?: unknown;
      at?: unknown;
    };
    return "pid " + String(owner.pid ?? "unknown") + " since " + String(owner.at ?? "unknown");
  } catch {
    return "an unknown owner";
  }
}

async function waitForLockRelease(lockPath: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (!existsSync(lockPath)) return;
    if (signal.aborted) throw new WorktreeAbortError();
    if (Date.now() >= deadline) {
      refuse("timed out waiting for worktree creator lock " + lockPath + " (" + lockOwner(lockPath) + "); inspect its owner before removing it");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_POLL_MS));
  }
}

/**
 * Take the per-call creator lock. `mkdir` is atomic across processes; a lock
 * that already exists belongs to someone else and is never removed here.
 */
async function acquireWorktreeLock(
  worktreesRoot: string,
  callKey: string,
  signal?: AbortSignal,
): Promise<WorktreeLock> {
  mkdirSync(worktreesRoot, { recursive: true });
  const path = lockFile(worktreesRoot, callKey);
  for (;;) {
    if (signal?.aborted) throw new WorktreeAbortError();
    try {
      mkdirSync(path);
      try {
        writeFileSync(
          join(path, LOCK_OWNER),
          JSON.stringify({ pid: process.pid, at: new Date().toISOString(), callKey }),
          "utf8",
        );
      } catch (error) {
        // We created this empty lock; a failed owner write must not wedge resume.
        try { rmdirSync(path); } catch { /* preserve anything not empty */ }
        throw error;
      }
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          try {
            rmSync(path, { recursive: true, force: true });
          } catch {
            // A lock we cannot remove is not worth failing the call over.
          }
        },
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        refuse("could not create the worktree lock " + path + ": " + (error?.message ?? error));
      }
      const owner = lockOwner(path);
      if (!signal) {
        refuse(
          "another creator is preparing the worktree for " + callKey + " (" + owner + ", lock " + path +
            "); refusing to interfere. If that process is gone, remove the lock yourself",
        );
      }
      await waitForLockRelease(path, signal);
    }
  }
}

interface ReuseArgs {
  worktreePath: string;
  repoRoot: string;
  callKey: string;
  signal?: AbortSignal;
}

/** Validate that an existing path is this call's worktree and return it as-is. */
async function reuseWorktree(args: ReuseArgs): Promise<WorkflowWorktree> {
  const { worktreePath, repoRoot, callKey, signal } = args;
  const top = await runGit(worktreePath, ["rev-parse", "--show-toplevel"], signal);
  if (top.code !== 0 || canonical(top.stdout.trim()) !== canonical(worktreePath)) {
    refuse(
      "the worktree path " + worktreePath + " already exists but is not a git worktree of " + repoRoot +
        "; refusing to reuse, reset or remove it",
    );
  }
  const adminDir = canonical(await git(worktreePath, ["rev-parse", "--absolute-git-dir"], signal, "read worktree metadata"));
  const commonDir = canonical(await git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal, "read worktree repository"));
  const expectedCommonDir = canonical(await git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal, "read parent repository"));
  if (commonDir !== expectedCommonDir) {
    refuse("the worktree at " + worktreePath + " belongs to another git repository; refusing to reuse it");
  }
  let pointer = "";
  try {
    pointer = readFileSync(join(adminDir, "gitdir"), "utf8").trim();
  } catch {
    refuse("the worktree at " + worktreePath + " has no gitdir pointer in " + adminDir + "; refusing to reuse it");
  }
  if (canonical(pointer) !== canonical(join(worktreePath, ".git"))) {
    refuse("the worktree at " + worktreePath + " does not point back to " + adminDir + "; refusing to reuse it");
  }
  let meta: { callKey?: unknown; path?: unknown; repoRoot?: unknown; baseCommit?: unknown } = {};
  try {
    meta = JSON.parse(readFileSync(join(adminDir, META_FILE), "utf8"));
  } catch {
    refuse(
      "the worktree at " + worktreePath + " was not created for this call (no " + META_FILE +
        "); remove it yourself or choose another run directory",
    );
  }
  if (meta.callKey !== callKey) {
    refuse(
      "the worktree at " + worktreePath + " belongs to a different call (" + String(meta.callKey) +
        "); refusing to reuse it for " + callKey,
    );
  }
  if (canonical(String(meta.path)) !== canonical(worktreePath) || canonical(String(meta.repoRoot)) !== canonical(repoRoot)) {
    refuse("the worktree at " + worktreePath + " was recorded for another path or repository; refusing to reuse it");
  }
  // No reset, no clean: modifications and commits made inside stay exactly as
  // they are.
  return {
    cwd: worktreePath,
    repoRoot,
    baseCommit: String(meta.baseCommit),
    callKey,
    created: false,
  };
}

/**
 * Best-effort cleanup of a partially created worktree after cancellation.
 *
 * Runs only while this call holds the creator lock, and never with --force: a
 * worktree that already carries metadata is a completed product and is left
 * alone; anything else is left when git refuses to remove it.
 */
async function cleanupPartialWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    const adminDir = canonical(await git(worktreePath, ["rev-parse", "--absolute-git-dir"], undefined, "inspect partial worktree"));
    if (existsSync(join(adminDir, META_FILE))) return;
  } catch {
    // Not a registered worktree; fall through to the best-effort removal.
  }
  try {
    await runGit(repoRoot, ["worktree", "remove", worktreePath]);
  } catch {
    // Leave it; a later call reports a clear ownership error instead.
  }
  try {
    if (existsSync(worktreePath) && readdirSync(worktreePath).length === 0) rmdirSync(worktreePath);
  } catch {
    // Leave it.
  }
}

/**
 * Prepare the isolated worktree for one call.
 *
 * Creates `<runDir>/worktrees/<callKey>` as a detached worktree of the current
 * HEAD, or validates and reuses it when it already exists.
 */
export async function prepareWorkflowWorktree(options: WorkflowWorktreeOptions): Promise<WorkflowWorktree> {
  const { callKey, signal } = options;
  if (signal?.aborted) throw new WorktreeAbortError();
  assertCallKey(callKey);

  const cwd = resolve(options.cwd);
  const runDir = resolve(options.runDir);
  const worktreesRoot = join(runDir, "worktrees");
  const worktreePath = join(worktreesRoot, callKey);
  const rel = relative(worktreesRoot, worktreePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    refuse("the worktree path " + worktreePath + " escapes the run directory " + worktreesRoot);
  }

  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], signal);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    refuse(
      "worktree isolation requires a git repository; " + cwd + " is not inside one" +
        (inside.stderr.trim() ? " (" + inside.stderr.trim() + ")" : ""),
    );
  }
  const repoRoot = canonical(await git(cwd, ["rev-parse", "--show-toplevel"], signal, "resolve the repository root"));

  // A symlinked container would place the worktree outside the run directory,
  // and a symlink at the target would make every later check read another tree.
  const rootStat = lstatOrUndefined(worktreesRoot);
  if (rootStat) {
    if (rootStat.isSymbolicLink()) {
      refuse("the worktrees directory " + worktreesRoot + " is a symbolic link; refusing to follow it");
    }
    if (!rootStat.isDirectory()) {
      refuse("the worktrees path " + worktreesRoot + " exists but is not a directory; refusing to use it");
    }
  }

  const lock = await acquireWorktreeLock(worktreesRoot, callKey, signal);
  try {
    const targetStat = lstatOrUndefined(worktreePath);
    if (targetStat) {
      if (targetStat.isSymbolicLink()) {
        refuse("the worktree path " + worktreePath + " is a symbolic link; refusing to follow it");
      }
      if (!targetStat.isDirectory()) {
        refuse("the worktree path " + worktreePath + " exists but is not a directory; refusing to reuse or remove it");
      }
      if (canonical(worktreePath) !== join(canonical(worktreesRoot), callKey)) {
        refuse("the worktree path " + worktreePath + " resolves outside the run directory; refusing to reuse it");
      }
      return await reuseWorktree({ worktreePath, repoRoot, callKey, signal });
    }

    const baseCommit = await git(repoRoot, ["rev-parse", "HEAD"], signal, "resolve HEAD");
    try {
      await git(repoRoot, ["worktree", "add", "--detach", worktreePath, baseCommit], signal, "create the worktree");
    } catch (error) {
      if (error instanceof WorktreeAbortError) {
        await cleanupPartialWorktree(repoRoot, worktreePath);
        throw error;
      }
      // A concurrent creator may have won the race. If the path now validates as
      // this call's worktree, reuse it instead of failing the call.
      if (existsSync(worktreePath)) {
        try {
          return await reuseWorktree({ worktreePath, repoRoot, callKey, signal });
        } catch {
          // Not ours: fall through to the original error.
        }
      }
      throw error;
    }

    // The add already succeeded. Finalize without the caller's signal: aborting
    // between here and the metadata write would leave a worktree that every later
    // reuse has to refuse. The lock is still held, so nobody else can race us.
    const adminDir = canonical(await git(worktreePath, ["rev-parse", "--absolute-git-dir"], undefined, "read the new worktree metadata"));
    writeFileSync(
      join(adminDir, META_FILE),
      JSON.stringify({ callKey, path: worktreePath, repoRoot, baseCommit }, null, 2),
      "utf8",
    );

    if (signal?.aborted) throw new WorktreeAbortError();
    return { cwd: worktreePath, repoRoot, baseCommit, callKey, created: true };
  } finally {
    lock.release();
  }
}
