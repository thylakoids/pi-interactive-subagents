/**
 * Worktree isolation tests, against real temporary git repositories.
 *
 * These cover the contract the runtime relies on: a detached worktree per call,
 * the main checkout left exactly as it was, reuse that keeps whatever the agent
 * wrote or committed, explicit refusals for foreign paths and non-repos, and
 * cancellation that neither starts git up front nor leaves a git process behind.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isWorktreeAbort,
  prepareWorkflowWorktree,
  WorktreeIsolationError,
} from "../pi-extension/subagents/workflow/worktree.ts";

const ROOT = realpathSync.native(tmpdir());
const GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(ROOT, prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync(GIT, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(cwd: string, message: string): void {
  git(cwd, ["add", "-A"]);
  git(cwd, [
    "-c", "user.name=Worktree Test",
    "-c", "user.email=worktree-test@example.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "-qm", message,
  ]);
}

/** A repository with one committed file, plus a run directory outside it. */
function repoWithRun(): { repo: string; runDir: string } {
  const repo = tempDir("wf-worktree-repo-");
  git(repo, ["init", "-q"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  commit(repo, "initial");
  return { repo, runDir: tempDir("wf-worktree-run-") };
}

describe("workflow worktree isolation", () => {
  for (const level of ['container', 'target']) {
    it('refuses a symbolic link at the worktree ' + level + ' without touching its destination', async () => {
      const { repo, runDir } = repoWithRun();
      const external = tempDir('wf-worktree-external-');
      writeFileSync(join(external, 'keep'), 'USER-DATA');
      const root = join(runDir, 'worktrees');
      if (level === 'target') mkdirSync(root);
      symlinkSync(external, level === 'container' ? root : join(root, 'linked'));
      await assert.rejects(prepareWorkflowWorktree({ cwd: repo, runDir, callKey: 'linked' }), /symbolic link/);
      assert.equal(readFileSync(join(external, 'keep'), 'utf8'), 'USER-DATA');
      assert.equal(existsSync(join(external, '.git')), false);
    });
  }

  it("creates, isolates and reuses a detached worktree without changing parent files or agent work", async () => {
    const { repo, runDir } = repoWithRun();
    const head = git(repo, ["rev-parse", "HEAD"]);
    const first = await prepareWorkflowWorktree({ cwd: repo, runDir, callKey: "call-lifecycle" });
    assert.equal(first.cwd, join(runDir, "worktrees", "call-lifecycle"));
    assert.equal(first.created, true);
    assert.equal(first.baseCommit, head);
    assert.equal(git(first.cwd, ["rev-parse", "HEAD"]), head);
    assert.equal(git(first.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD", "the worktree is detached");
    assert.equal(readFileSync(join(first.cwd, "README.md"), "utf8"), "base\n");

    writeFileSync(join(first.cwd, "only-in-worktree.txt"), "isolated\n");
    assert.equal(existsSync(join(repo, "only-in-worktree.txt")), false);
    assert.match(git(first.cwd, ["status", "--porcelain"]), /only-in-worktree\.txt/);
    assert.equal(git(repo, ["status", "--porcelain"]), "", "agent writes leave a clean parent clean");

    writeFileSync(join(repo, "README.md"), "changed in main\n");
    writeFileSync(join(repo, "scratch.txt"), "not committed\n");
    const parentStatus = git(repo, ["status", "--porcelain"]);
    const isolated = await prepareWorkflowWorktree({ cwd: repo, runDir, callKey: "call-dirty-main" });
    assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "changed in main\n");
    assert.equal(readFileSync(join(repo, "scratch.txt"), "utf8"), "not committed\n");
    assert.equal(git(repo, ["status", "--porcelain"]), parentStatus, "a dirty parent stays unchanged");
    assert.equal(readFileSync(join(isolated.cwd, "README.md"), "utf8"), "base\n", "isolation starts from HEAD, not dirty content");

    writeFileSync(join(first.cwd, "work.txt"), "draft\n");
    commit(first.cwd, "work in progress");
    writeFileSync(join(first.cwd, "uncommitted.txt"), "still dirty\n");
    const agentHead = git(first.cwd, ["rev-parse", "HEAD"]);
    const agentStatus = git(first.cwd, ["status", "--porcelain"]);
    const reused = await prepareWorkflowWorktree({ cwd: repo, runDir, callKey: "call-lifecycle" });
    assert.equal(reused.created, false);
    assert.equal(reused.cwd, first.cwd);
    assert.equal(reused.baseCommit, first.baseCommit, "the recorded base commit does not drift");
    assert.equal(git(reused.cwd, ["rev-parse", "HEAD"]), agentHead, "agent commits survive reuse");
    assert.equal(git(reused.cwd, ["status", "--porcelain"]), agentStatus, "nothing is reset or cleaned");
    assert.equal(readFileSync(join(reused.cwd, "work.txt"), "utf8"), "draft\n");
    assert.equal(readFileSync(join(reused.cwd, "uncommitted.txt"), "utf8"), "still dirty\n");
  });

  it("refuses file and foreign-directory targets without touching their contents", async () => {
    const { repo, runDir } = repoWithRun();
    const target = join(runDir, "worktrees", "call-foreign");
    mkdirSync(join(runDir, "worktrees"), { recursive: true });
    writeFileSync(target, "user file\n");
    await assert.rejects(
      prepareWorkflowWorktree({ cwd: repo, runDir, callKey: "call-foreign" }),
      (error: unknown) => error instanceof WorktreeIsolationError,
    );
    assert.equal(readFileSync(target, "utf8"), "user file\n", "a rejected file stays intact");
    rmSync(target);
    mkdirSync(target);
    writeFileSync(join(target, "user-data.txt"), "precious\n");
    await assert.rejects(
      prepareWorkflowWorktree({ cwd: repo, runDir, callKey: "call-foreign" }),
      (error: unknown) => error instanceof WorktreeIsolationError && /not a git worktree|refusing to reuse/i.test(String((error as Error).message)),
    );
    assert.equal(readFileSync(join(target, "user-data.txt"), "utf8"), "precious\n");
  });

  it("refuses a working directory that is not a git repository", async () => {
    const plain = tempDir("wf-worktree-plain-");
    const runDir = tempDir("wf-worktree-run-");
    await assert.rejects(
      prepareWorkflowWorktree({ cwd: plain, runDir, callKey: "call-nonrepo" }),
      (error: unknown) =>
        error instanceof WorktreeIsolationError && /requires a git repository/.test(String((error as Error).message)),
    );
    assert.equal(existsSync(join(runDir, "worktrees")), false);
  });

  it("refuses call keys that would escape the run directory", async () => {
    const { repo, runDir } = repoWithRun();
    const bad = ["../escape", "a/b", "/absolute", "..", ".", "a b", "x".repeat(200)];
    for (const callKey of bad) {
      await assert.rejects(
        prepareWorkflowWorktree({ cwd: repo, runDir, callKey }),
        (error: unknown) =>
          error instanceof WorktreeIsolationError && /plain call key/.test(String((error as Error).message)),
        "accepted dangerous call key " + JSON.stringify(callKey),
      );
    }
    assert.equal(existsSync(join(runDir, "worktrees")), false, "nothing was created for a rejected key");
  });

  it("does not start anything when the signal is already aborted", async () => {
    const { repo, runDir } = repoWithRun();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      prepareWorkflowWorktree({ cwd: repo, runDir, callKey: "call-pre-abort", signal: controller.signal }),
      (error: unknown) => isWorktreeAbort(error),
    );
    assert.equal(existsSync(join(runDir, "worktrees")), false);
  });

  it("kills git and leaves no worktree when cancelled mid-creation", async () => {
    const { repo, runDir } = repoWithRun();
    const shim = tempDir("wf-worktree-shim-");
    const pidFile = join(shim, "git.pid");
    writeFileSync(
      join(shim, "git"),
      [
        "#!/bin/sh",
        'if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then',
        '  echo $$ > "$WF_SHIM_PIDFILE"',
        "  sleep 30",
        "fi",
        'exec "' + GIT + '" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(join(shim, "git"), 0o755);
    const previousPath = process.env.PATH;
    const previousPidFile = process.env.WF_SHIM_PIDFILE;
    process.env.PATH = shim + ":" + (previousPath ?? "");
    process.env.WF_SHIM_PIDFILE = pidFile;
    try {
      const controller = new AbortController();
      const pending = prepareWorkflowWorktree({ cwd: repo, runDir, callKey: "call-abort", signal: controller.signal });
      const deadline = Date.now() + 10_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(existsSync(pidFile), "the shimmed git must have started");
      const gitPid = Number(readFileSync(pidFile, "utf8").trim());
      controller.abort();
      await assert.rejects(pending, (error: unknown) => isWorktreeAbort(error));

      const gone = (pid: number) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      };
      const goneDeadline = Date.now() + 5_000;
      while (!gone(gitPid) && Date.now() < goneDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(gone(gitPid), true, "the git process must not outlive the abort");
      let groupAlive = true;
      try {
        process.kill(-gitPid, 0);
      } catch {
        groupAlive = false;
      }
      assert.equal(groupAlive, false, "the whole git process group is gone");
      assert.equal(existsSync(join(runDir, "worktrees", "call-abort")), false, "no partial worktree is left behind");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousPidFile === undefined) delete process.env.WF_SHIM_PIDFILE;
      else process.env.WF_SHIM_PIDFILE = previousPidFile;
    }
  });

  it("refuses to reuse a worktree whose metadata names another call", async () => {
    const { repo, runDir } = repoWithRun();
    const worktree = await prepareWorkflowWorktree({ cwd: repo, runDir, callKey: "call-owned" });
    writeFileSync(join(worktree.cwd, "keep.txt"), "agent work\n");
    const adminDir = git(worktree.cwd, ["rev-parse", "--absolute-git-dir"]);
    writeFileSync(
      join(adminDir, "pi-worktree.json"),
      JSON.stringify({ callKey: "another-call", path: worktree.cwd, repoRoot: repo, baseCommit: worktree.baseCommit }),
    );

    await assert.rejects(
      prepareWorkflowWorktree({ cwd: repo, runDir, callKey: "call-owned" }),
      (error: unknown) =>
        error instanceof WorktreeIsolationError && /belongs to a different call/.test(String((error as Error).message)),
    );
    assert.equal(readFileSync(join(worktree.cwd, "keep.txt"), "utf8"), "agent work\n", "the worktree is untouched");
  });
});

describe("worktree creator locking", () => {
  const lockAt = (runDir: string, callKey: string) => join(runDir, "worktrees", "." + callKey + ".lock");

  /** Put a shim named git in front of PATH; it runs the real git afterwards. */
  function shimGit(lines: string[]) {
    const dir = tempDir("wf-worktree-shim-");
    writeFileSync(join(dir, "git"), ["#!/bin/sh", ...lines, 'exec "' + GIT + '" "$@"', ""].join("\n"));
    chmodSync(join(dir, "git"), 0o755);
    const previous = process.env.PATH;
    process.env.PATH = dir + ":" + (previous ?? "");
    return {
      dir,
      restore() {
        if (previous === undefined) delete process.env.PATH;
        else process.env.PATH = previous;
      },
    };
  }

  it("refuses while another creator holds the lock and never removes that lock", async () => {
    const { repo, runDir } = repoWithRun();
    const callKey = "call-locked";
    const lock = lockAt(runDir, callKey);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 424242, at: "2020-01-01T00:00:00.000Z", callKey }));

    await assert.rejects(
      prepareWorkflowWorktree({ cwd: repo, runDir, callKey }),
      (error: unknown) =>
        error instanceof WorktreeIsolationError &&
        /another creator|lock/.test(String((error as Error).message)) &&
        /424242/.test(String((error as Error).message)),
    );
    assert.equal(existsSync(lock), true, "an unknown owner's lock is never removed automatically");
    assert.equal(existsSync(join(runDir, "worktrees", callKey)), false);
  });

  it("waits for the lock and aborts without touching either side", async () => {
    const { repo, runDir } = repoWithRun();
    const callKey = "call-wait";
    const lock = lockAt(runDir, callKey);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), callKey }));
    const controller = new AbortController();
    const pending = prepareWorkflowWorktree({ cwd: repo, runDir, callKey, signal: controller.signal });
    setTimeout(() => controller.abort(), 120);
    await assert.rejects(pending, (error: unknown) => isWorktreeAbort(error));
    assert.equal(existsSync(lock), true, "the holder's lock stays");
    assert.equal(existsSync(join(runDir, "worktrees", callKey)), false, "the waiter created nothing");
  });

  it("holds the lock while git creates the worktree and releases it afterwards", async () => {
    const { repo, runDir } = repoWithRun();
    const callKey = "call-hold";
    const lock = lockAt(runDir, callKey);
    const marker = join(tempDir("wf-worktree-marker-"), "held.txt");
    process.env.WF_LOCK = lock;
    process.env.WF_LOCK_MARKER = marker;
    const shim = shimGit([
      'if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then',
      '  if [ -d "$WF_LOCK" ]; then echo held > "$WF_LOCK_MARKER"; fi',
      "fi",
    ]);
    try {
      await prepareWorkflowWorktree({ cwd: repo, runDir, callKey });
      assert.equal(readFileSync(marker, "utf8").trim(), "held", "git must run while the creator lock is held");
      assert.equal(existsSync(lock), false, "the lock is released once the metadata is written");
    } finally {
      shim.restore();
      delete process.env.WF_LOCK;
      delete process.env.WF_LOCK_MARKER;
    }
  });

  it("keeps a completed worktree when the abort lands after git add succeeded", async () => {
    const { repo, runDir } = repoWithRun();
    const callKey = "call-finalize";
    const pidFile = join(tempDir("wf-worktree-finalize-"), "rev-parse.pid");
    process.env.WF_FINALIZE_PIDFILE = pidFile;
    const shim = shimGit([
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--absolute-git-dir" ]; then',
      '  echo $$ > "$WF_FINALIZE_PIDFILE"',
      "  sleep 1",
      "fi",
    ]);
    try {
      const controller = new AbortController();
      const pending = prepareWorkflowWorktree({ cwd: repo, runDir, callKey, signal: controller.signal });
      const deadline = Date.now() + 10_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      assert.ok(existsSync(pidFile), "the finalization git call must be running");
      controller.abort();
      await assert.rejects(pending, (error: unknown) => isWorktreeAbort(error));

      const worktreePath = join(runDir, "worktrees", callKey);
      assert.equal(existsSync(worktreePath), true, "the completed worktree is kept");
      const adminDir = git(worktreePath, ["rev-parse", "--absolute-git-dir"]);
      assert.equal(existsSync(join(adminDir, "pi-worktree.json")), true, "metadata is written despite the abort");
      assert.equal(existsSync(lockAt(runDir, callKey)), false, "the lock is released");

      const reused = await prepareWorkflowWorktree({ cwd: repo, runDir, callKey });
      assert.equal(reused.created, false, "the aborted-but-complete worktree is reusable, not rejected");
      assert.equal(reused.cwd, worktreePath);
    } finally {
      shim.restore();
      delete process.env.WF_FINALIZE_PIDFILE;
    }
  });

  it("lets exactly one concurrent creator win and leaves a single healthy worktree", async () => {
    const { repo, runDir } = repoWithRun();
    const callKey = "call-concurrent";
    const options = { cwd: repo, runDir, callKey };
    const results = await Promise.allSettled([
      prepareWorkflowWorktree(options),
      prepareWorkflowWorktree(options),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.ok(fulfilled.length >= 1, "at least one creator must succeed");
    for (const result of results) {
      if (result.status === "rejected") {
        assert.ok(
          result.reason instanceof WorktreeIsolationError,
          "a losing creator must refuse cleanly, got " + String(result.reason),
        );
      }
    }
    const worktreePath = join(runDir, "worktrees", callKey);
    assert.equal(existsSync(join(worktreePath, ".git")), true);
    const blocks = git(repo, ["worktree", "list", "--porcelain"])
      .split("\n\n")
      .filter((block) => block.includes(worktreePath));
    assert.equal(blocks.length, 1, "git must register the worktree exactly once");
    writeFileSync(join(worktreePath, "after-create.txt"), "kept\n");
    assert.equal(readFileSync(join(worktreePath, "after-create.txt"), "utf8"), "kept\n");
    assert.equal(existsSync(lockAt(runDir, callKey)), false, "no lock is left behind");
  });
});
