/**
 * Read-only execution backend for workflow steps that only gather evidence.
 *
 * A read-only step still needs to *run* things - a test suite, a type check, a
 * build - but it must not change the workspace. verify_command is that one
 * door: the process runs under an OS sandbox that denies every file write
 * outside a private per-command scratch directory and denies network and
 * mach/IPC access, so a command cannot rewrite the tree, reach the network, or
 * drive tmux and other panes.
 *
 * What the sandbox does and does not say: file *reads* are unrestricted - the
 * command can read the whole filesystem, not merely the workspace - and CPU,
 * memory and process count are unbounded except for the timeout. This is a
 * runtime tool-permission policy plus a shell sandbox: it prevents accidental
 * writes and casual escapes from a cooperative model. It is not a general
 * security boundary against hostile code.
 *
 * Fail closed: when no backend has been verified on the running platform, the
 * tool refuses to run anything. There is deliberately no unsandboxed fallback.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LINUX_LANDLOCK_EXEC } from "./linux-landlock.ts";

/** The one tool a read-only step may use to execute something. */
export const VERIFY_COMMAND_TOOL = "verify_command";

/** Built-in tools that cannot change the workspace. */
export const READONLY_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;

/**
 * The complete read-only allowlist. structured_output is deliberately absent:
 * the launcher adds it from the schema wiring, so a read-only call without a
 * schema does not carry a tool it can never use.
 */
export const READONLY_TOOL_ALLOWLIST = [...READONLY_BUILTIN_TOOLS, "ask_question", VERIFY_COMMAND_TOOL].join(",");

/** Parent-provided environment. Without the scratch directory the tool is inert. */
export const READONLY_ENV = {
  scratch: "PI_SUBAGENT_VERIFY_SCRATCH",
  timeoutMs: "PI_SUBAGENT_VERIFY_TIMEOUT_MS",
  outputBytes: "PI_SUBAGENT_VERIFY_OUTPUT_BYTES",
} as const;

export const MIN_VERIFY_TIMEOUT_MS = 1_000;
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
export const MAX_VERIFY_TIMEOUT_MS = 600_000;
export const MIN_VERIFY_OUTPUT_BYTES = 4_096;
export const DEFAULT_VERIFY_OUTPUT_BYTES = 32_768;
export const MAX_VERIFY_OUTPUT_BYTES = 262_144;

/** How long a terminated command may still ignore SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;

export type VerifyBackend = { kind: "sandbox-exec"; command: string } | { kind: "bwrap"; command: string; pythonCommand: string };

export type VerifyBackendResolution =
  | { ok: true; backend: VerifyBackend }
  | { ok: false; reason: string };

export type VerifyResult = {
  /** False when the sandbox itself could not run the command (fail closed). */
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
  output: string;
  /** Bytes of stdout+stderr actually retained, before decoding. */
  outputBytes: number;
  backend: string | null;
  /** Process-group leader, for diagnostics and cleanup assertions. */
  pid: number | null;
  /** The per-command scratch directory that was writable, for diagnostics. */
  scratchDir: string | null;
  error?: string;
  /** Established by the guard below; false means the command never ran. */
  executed: boolean;
};

export function clampTimeout(value: unknown, fallback = DEFAULT_VERIFY_TIMEOUT_MS): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(MAX_VERIFY_TIMEOUT_MS, Math.max(MIN_VERIFY_TIMEOUT_MS, numeric));
}

export function clampOutputBytes(value: unknown, fallback = DEFAULT_VERIFY_OUTPUT_BYTES): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(MAX_VERIFY_OUTPUT_BYTES, Math.max(MIN_VERIFY_OUTPUT_BYTES, numeric));
}

/** Whether the tool should register at all: the parent must supply a scratch dir. */
export function verifyToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env[READONLY_ENV.scratch] === "string" && env[READONLY_ENV.scratch]!.trim().startsWith("/");
}

function findExecutable(name: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | null {
  const system = ["/usr/bin", "/bin", "/usr/local/bin"].map(dir => join(dir, name)).find(exists);
  if (system) return system;
  const fromPath = (env.PATH ?? "")
    .split(":")
    .map(entry => entry.trim())
    .filter(entry => entry.startsWith("/"))
    .map(entry => join(entry, name))
    .find(candidate => exists(candidate));
  if (fromPath) return fromPath;
  return null;
}

/**
 * Pick a backend that has been verified on the running platform, or refuse.
 *
 * Linux requires bubblewrap, user namespaces and seccomp. Failure to establish
 * any isolation layer is fatal; neither platform falls back to a bare shell.
 */
export function resolveVerifyBackend(probe: {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
} = {}): VerifyBackendResolution {
  const platform = probe.platform ?? process.platform;
  const env = probe.env ?? process.env;
  const exists = probe.existsSync ?? existsSync;

  if (platform === "darwin") {
    const command = "/usr/bin/sandbox-exec";
    if (!exists(command)) {
      return { ok: false, reason: "read-only backend unavailable: " + command + " is missing; refusing to run the command unsandboxed" };
    }
    return { ok: true, backend: { kind: "sandbox-exec", command } };
  }

  if (platform === "linux") {
    if (!['arm64', 'x64'].includes(probe.arch ?? process.arch)) {
      return { ok: false, reason: "read-only Linux backend requires an arm64 or x64 seccomp ABI; refusing unsandboxed execution" };
    }
    const installed = findExecutable("bwrap", env, exists);
    if (installed) {
      const pythonCommand = findExecutable('python3', env, exists);
      if (!pythonCommand) return { ok: false, reason: 'Linux read-only verification requires Python 3 to establish Landlock path-write restrictions; refusing unsandboxed execution' };
      return { ok: true, backend: { kind: "bwrap", command: installed, pythonCommand } };
    }
    return { ok: false, reason: "read-only Linux backend unavailable: install bubblewrap (bwrap), enable user namespaces and seccomp; refusing unsandboxed execution" };
  }

  return { ok: false, reason: "read-only backend unsupported on " + platform + ": no verified read-only sandbox exists for this platform, so verify_command stays disabled instead of running unsandboxed" };
}

/** An absolute path that can be embedded in a sandbox profile without escaping it. */
function assertSafePath(path: string, what: string): string {
  if (!path.startsWith("/")) throw new Error(what + " must be an absolute path, got: " + path);
  if (/[\u0000-\u001f"]/.test(path)) throw new Error(what + " may not contain control characters or quotes: " + path);
  return path;
}

/**
 * The macOS sandbox profile: deny everything, then re-open reads (the whole
 * filesystem, not just the workspace), one private directory for writes, and
 * /dev/null. Network and mach lookups stay denied, which blocks tmux, sockets
 * and other-application IPC as well as curl and fetch.
 */
export function sandboxProfile(scratchDir: string): string {
  const scratch = assertSafePath(scratchDir, "scratch directory");
  return [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    "(deny mach-lookup)",
    "(allow process-fork)",
    "(allow process-exec*)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow file-read*)",
    '(allow file-write* (subpath "' + scratch + '") (literal "/dev/null"))',
    "",
  ].join("\n");
}

/**
 * Keep /tmp readable: projects and dependencies often live there. Only the
 * private command directory is rebound writable. A private /dev and /proc must
 * not expose host devices or processes. FD 3 carries the mandatory socket filter.
 */
export function bwrapArgv(scratchDir: string, cwd: string, command: string, pythonCommand = '/usr/bin/python3'): string[] {
  const scratch = assertSafePath(scratchDir, "scratch directory");
  return [
    "--die-with-parent",
    "--unshare-all",
    "--unshare-user",
    "--cap-drop", "ALL",
    "--new-session",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--remount-ro", "/dev",
    "--proc", "/proc",
    "--remount-ro", "/proc",
    "--bind", scratch, scratch,
    "--seccomp", "3",
    "--json-status-fd", "4",
    "--chdir", assertSafePath(cwd, "working directory"),
    "--",
    pythonCommand, '-I', '-S', '-c', LINUX_LANDLOCK_EXEC, scratch,
    "/bin/sh", "-c", command,
  ];
}

/** Linux classic BPF, passed as an inherited read-only FD, never as shell text. */
export function linuxVerifySeccomp(arch = process.arch): Buffer {
  const abi = arch === 'arm64' ? { audit: 0xc00000b7, socket: 198 }
    : arch === 'x64' ? { audit: 0xc000003e, socket: 41 } : null;
  if (!abi) throw new Error('Unsupported Linux verification seccomp ABI: ' + arch);
  const instructions: number[][] = [
    [0x20, 0, 0, 4],                   // seccomp_data.arch
    [0x15, 1, 0, abi.audit],
    [0x06, 0, 0, 0x80000000],          // KILL_PROCESS: no compat ABI bypass
    [0x20, 0, 0, 0],                   // seccomp_data.nr
  ];
  if (arch === 'x64') instructions.push([0x45, 0, 1, 0x40000000], [0x06, 0, 0, 0x80000000]);
  // socketpair remains available for local node --test/child-process IPC.
  // io_uring socket operations would otherwise bypass the socket syscall rule.
  for (const syscall of [abi.socket, 425, 426, 427]) {
    instructions.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x00050001]); // EPERM
  }
  instructions.push([0x06, 0, 0, 0x7fff0000]); // ALLOW
  const program = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    const offset = index * 8;
    program.writeUInt16LE(code, offset);
    program[offset + 2] = jt;
    program[offset + 3] = jf;
    program.writeUInt32LE(k, offset + 4);
  });
  return program;
}

function argvFor(backend: VerifyBackend, scratch: string, cwd: string, command: string): string[] {
  if (backend.kind === "sandbox-exec") {
    return ["-p", sandboxProfile(scratch), "/bin/sh", "-c", command];
  }
  return bwrapArgv(scratch, cwd, command, backend.pythonCommand);
}

/**
 * The shell that runs the wrapper. Fixed, so the backend argv passes through
 * untouched.
 */
export const VERIFY_WRAPPER_SHELL = "/bin/sh";

/**
 * Fixed pre-sandbox wrapper: fork a watchdog, then exec the backend argv.
 *
 * Why it exists: the verify command runs in its own process group (detached), so
 * killing pi does not kill it - it is reparented and keeps running in the
 * workspace with nobody left to watch it. The watchdog closes that hole: it
 * polls the leader's PPID and SIGKILLs the whole group once that is no longer
 * the owning pi process - and also when the leader is already gone. That second
 * case matters: owner and leader can both exit between two polls, leaving a
 * background child of the command running with no one to reap it. The watchdog
 * keeps its own PGID alive for exactly this reason, so the group it kills is
 * still its own and cannot have been recycled.
 *
 * Nothing from the caller is interpolated into this script. The owner pid and
 * the backend argv arrive as positional parameters and exec "$@" hands the argv
 * through verbatim, so a command string cannot escape into the wrapper's own
 * code. Binaries are absolute so a PATH entry in the workspace cannot shadow
 * the monitoring commands.
 */
export const VERIFY_WRAPPER = [
  "leader=$$",
  "owner=$1",
  "shift",
  "(",
  "  while :; do",
  '    parent=$(/bin/ps -o ppid= -p "$leader" 2>/dev/null | /usr/bin/tr -d " ")',
  '    if [ "$parent" != "$owner" ]; then',
  '      /bin/kill -KILL -- -"$leader" 2>/dev/null',
  "      exit 0",
  "    fi",
  "    /bin/sleep 0.25",
  "  done",
  ") </dev/null >/dev/null 2>&1 &",
  'exec "$@"',
  "",
].join("\n");

/**
 * Build the argv for "sh -c <wrapper> <name> <ownerPid> <backend> <argv...>".
 *
 * The user command is one element of the backend argv; the wrapper never parses
 * or concatenates it.
 */
export function wrapperArgv(
  ownerPid: number,
  backend: VerifyBackend,
  scratch: string,
  cwd: string,
  command: string,
): string[] {
  return [
    "-c",
    VERIFY_WRAPPER,
    "pi-verify-wrapper",
    String(ownerPid),
    backend.command,
    ...argvFor(backend, scratch, cwd, command),
  ];
}

/**
 * Run one command under the read-only sandbox.
 *
 * Guarantees: the command never runs without a verified backend; each command
 * gets its own private scratch directory (HOME and TMPDIR point there) which is
 * removed afterwards; the whole process group is reaped on timeout,
 * cancellation *and* leader exit, so a background child cannot outlive its
 * command; output is capped by bytes, not by string length.
 */
export async function runVerifyCommand(input: {
  command: string;
  scratchDir: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  realpathSync?: (path: string) => string;
  mkdtempSync?: (template: string) => string;
  removeDir?: (path: string) => void;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** The process whose death must take this command down; defaults to this one. */
  ownerPid?: number;
}): Promise<VerifyResult> {
  const started = Date.now();
  const fail = (error: string): VerifyResult => ({
    ok: false, exitCode: null, timedOut: false, cancelled: false, truncated: false,
    durationMs: Date.now() - started, output: "", outputBytes: 0, backend: null, pid: null,
    scratchDir: null, error, executed: false,
  });

  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) return fail("verify_command needs a non-empty command");

  const resolution = resolveVerifyBackend({
    platform: input.platform,
    env: input.env,
    existsSync: input.existsSync,
  });
  if (!resolution.ok) return fail(resolution.reason);
  const backend = resolution.backend;

  const realpath = input.realpathSync ?? realpathSync;
  const makeTemp = input.mkdtempSync ?? ((template: string) => mkdtempSync(template));
  const removeDir = input.removeDir ?? ((path: string) => rmSync(path, { recursive: true, force: true }));

  // One directory per command, created under the parent's scratch root: two
  // commands never share a writable directory, and nothing survives the call.
  let scratch: string;
  try {
    const parentScratch = assertSafePath(input.scratchDir, "scratch directory");
    mkdirSync(parentScratch, { recursive: true, mode: 0o700 });
    const realParent = assertSafePath(realpath(parentScratch), "scratch directory");
    // macOS resolves /tmp to /private/tmp; a profile that names the unresolved
    // path matches nothing and silently denies the scratch directory too.
    scratch = assertSafePath(realpath(makeTemp(join(realParent, "cmd-"))), "scratch directory");
  } catch (error: any) {
    return fail("verify_command cannot prepare its scratch directory: " + (error?.message ?? error));
  }

  const cwd = input.cwd ?? process.cwd();
  const timeoutMs = clampTimeout(input.timeoutMs, Number(input.env?.[READONLY_ENV.timeoutMs]) || DEFAULT_VERIFY_TIMEOUT_MS);
  const maxOutputBytes = clampOutputBytes(input.maxOutputBytes, Number(input.env?.[READONLY_ENV.outputBytes]) || DEFAULT_VERIFY_OUTPUT_BYTES);
  // The owner is the process that must not outlive this call: normally this pi
  // process. The wrapper's watchdog watches this pid, so a SIGKILLed pi leaves
  // nothing running in the workspace.
  const ownerPid = input.ownerPid ?? process.pid;
  const killGroup = input.killProcessGroup ?? ((pid: number, signal: NodeJS.Signals) => {
    try { process.kill(-pid, signal); } catch { /* group already gone */ }
  });

  const cleanup = () => {
    try { removeDir(scratch); } catch { /* best effort: never mask the result */ }
  };

  if (input.signal?.aborted) {
    cleanup();
    return { ok: true, exitCode: null, timedOut: false, cancelled: true, truncated: false, durationMs: Date.now() - started, output: "", outputBytes: 0, backend: backend.kind, pid: null, scratchDir: scratch, executed: false };
  }

  // The command must not inherit pi's own plumbing: the test-runner context
  // would make a nested node --test refuse to run at all, and the
  // PI_SUBAGENT_* variables are the parent's business, not the command's.
  const childEnv: NodeJS.ProcessEnv = { ...(input.env ?? process.env) };
  delete childEnv.NODE_TEST_CONTEXT;
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("PI_SUBAGENT_")) delete childEnv[key];
  }
  childEnv.HOME = scratch;
  childEnv.TMPDIR = scratch;

  return await new Promise<VerifyResult>((resolve) => {
    let child;
    let filterFd: number | undefined;
    try {
      if (backend.kind === 'bwrap') {
        const filterPath = join(scratch, '.verify-seccomp');
        writeFileSync(filterPath, linuxVerifySeccomp(), { mode: 0o400, flag: 'wx' });
        filterFd = openSync(filterPath, 'r');
        unlinkSync(filterPath);
      }
      child = spawn(VERIFY_WRAPPER_SHELL, wrapperArgv(ownerPid, backend, scratch, cwd, command), {
        cwd,
        detached: true,
        stdio: filterFd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", filterFd, "pipe"],
        env: childEnv,
      });
    } catch (error: any) {
      cleanup();
      resolve(fail("verify_command could not start " + backend.kind + ": " + (error?.message ?? error)));
      return;
    } finally {
      if (filterFd !== undefined) closeSync(filterFd);
    }

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let leaderExitCode: number | null = null;
    let sandboxStarted = backend.kind !== 'bwrap';
    let policyReady = backend.kind !== 'bwrap';
    let preamble = Buffer.alloc(0);
    const readyMarker = Buffer.from('pi-verify-landlock-ready\n');
    let statusBuffer = '';
    const statusPipe = backend.kind === 'bwrap' ? child.stdio[4] : null;
    if (backend.kind === 'bwrap') {
      // A setup failure is not an executed user command. bubblewrap reports the
      // sandbox child only after establishing the namespaces and mounts.
      if (statusPipe && 'on' in statusPipe) statusPipe.on('data', (chunk: Buffer) => {
        statusBuffer += chunk.toString('utf8');
        const lines = statusBuffer.split('\n');
        statusBuffer = lines.pop() ?? '';
        for (const line of lines) {
          try {
            if (typeof JSON.parse(line)['child-pid'] === 'number') sandboxStarted = true;
          } catch { /* malformed status cannot establish a successful sandbox */ }
        }
      });
    }
    let killTimer: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;

    // Cap in bytes. Counting string length would let a multi-byte payload past
    // the ceiling, which is the difference between a bounded and an unbounded
    // result.
    const collect = (chunk: Buffer) => {
      if (truncated) return;
      const room = maxOutputBytes - outputBytes;
      if (chunk.length <= room) {
        chunks.push(chunk);
        outputBytes += chunk.length;
        return;
      }
      if (room > 0) {
        chunks.push(chunk.subarray(0, room));
        outputBytes += room;
      }
      truncated = true;
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", (chunk: Buffer) => {
      if (policyReady) { collect(chunk); return; }
      // Only the trusted Landlock bootstrap can reach this point before the
      // command is exec'd. Its handshake is control data, not command output.
      preamble = Buffer.concat([preamble, chunk]);
      let newline: number;
      while ((newline = preamble.indexOf(10)) >= 0) {
        const line = preamble.subarray(0, newline + 1);
        preamble = preamble.subarray(newline + 1);
        if (line.equals(readyMarker)) policyReady = true;
        else collect(line);
        if (policyReady) break;
      }
      if (policyReady || preamble.length > readyMarker.length) {
        collect(preamble);
        preamble = Buffer.alloc(0);
      }
    });

    // Single shot, first reason wins. Timeout and abort can fire back to back
    // (the timer fires while the caller is already aborting); a second call would
    // overwrite killTimer, leave the first one armed after finish() and let it
    // SIGKILL a process group whose pid may already belong to something else.
    let terminating = false;
    const terminate = (reason: "timeout" | "cancel") => {
      if (settled || terminating) return;
      terminating = true;
      if (reason === "timeout") timedOut = true; else cancelled = true;
      if (typeof child.pid !== "number") return;
      killGroup(child.pid, "SIGTERM");
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        if (settled) return;
        if (typeof child.pid === "number") killGroup(child.pid, "SIGKILL");
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    const onAbort = () => terminate("cancel");
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (reapTimer) clearTimeout(reapTimer);
      input.signal?.removeEventListener("abort", onAbort);
      // Whatever happened, nothing from this command may outlive the call.
      if (typeof child.pid === "number") killGroup(child.pid, "SIGKILL");
      collect(preamble);
      const output = Buffer.concat(chunks).toString("utf8");
      statusPipe?.destroy();
      const executed = sandboxStarted && policyReady;
      if (!executed && !error && !cancelled && !timedOut) {
        error = 'Linux read-only sandbox could not start: bubblewrap requires user namespaces/seccomp, and Python 3 must establish Landlock. ' + output.trim();
      }
      cleanup();
      resolve({
        ok: !error,
        exitCode,
        timedOut,
        cancelled,
        truncated,
        durationMs: Date.now() - started,
        output: truncated ? output + "\n[output truncated at " + maxOutputBytes + " bytes]" : output,
        outputBytes,
        backend: backend.kind,
        pid: typeof child.pid === "number" ? child.pid : null,
        scratchDir: scratch,
        ...(error ? { error } : {}),
        executed,
      });
    };

    // The leader exiting is not the end: a background child can still hold the
    // pipes (so close never fires) and keep running in the workspace. Reap the
    // whole group here, not only on timeout or cancellation.
    child.on("exit", (code) => {
      leaderExitCode = code;
      if (settled) return;
      if (typeof child.pid === "number") {
        killGroup(child.pid, "SIGTERM");
        reapTimer = setTimeout(() => {
          if (typeof child.pid === "number") killGroup(child.pid, "SIGKILL");
          // A detached descendant can hold the pipes open forever; do not hang.
          finish(leaderExitCode);
        }, KILL_GRACE_MS);
        reapTimer.unref?.();
      }
    });

    child.on("error", (error: any) => finish(null, "verify_command failed to run: " + (error?.message ?? error)));
    child.on("close", (code) => finish(code ?? leaderExitCode));
  });
}

/**
 * The child-side extension. Inert unless the parent supplied
 * READONLY_ENV.scratch, which only happens for a read-only step.
 */
export default function readonlyVerifyExtension(pi: ExtensionAPI): void {
  if (!verifyToolEnabled()) return;
  const scratch = process.env[READONLY_ENV.scratch]!;

  pi.registerTool({
    name: VERIFY_COMMAND_TOOL,
    label: "Verify Command",
    description:
      "Run one local verification command (tests, type check, build) in a read-only sandbox. The command can read the " +
      "filesystem, but it can only write inside a private scratch directory that is deleted afterwards; the network, " +
      "tmux and other-application IPC are blocked. Use it as evidence for work you cannot modify - it cannot change the " +
      "workspace. A nonzero exit is a result, not a broken tool.",
    promptSnippet:
      "verify_command runs a local read-only check (tests, type check, build); writes are limited to its own temporary scratch directory.",
    promptGuidelines: [
      "Use verify_command to gather evidence (run tests, type checks or builds); it can never modify the workspace.",
      "A command that tries to write outside its scratch directory or reach the network fails: that is the sandbox, not a broken command.",
      "Prefer one command per check; long output is truncated and every command has a timeout.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run, e.g. node --test test/foo.test.ts" }),
      timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds (clamped to 1s..10min)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await runVerifyCommand({
        command: params.command,
        scratchDir: scratch,
        timeoutMs: params.timeout_ms,
        signal,
      });

      const header = [
        result.backend ? "sandbox=" + result.backend : "sandbox=none",
        result.executed ? "exit=" + (result.exitCode ?? "null") : "not-run",
        Math.round(result.durationMs) + "ms",
        result.outputBytes + "B",
        result.timedOut ? "timed-out" : null,
        result.cancelled ? "cancelled" : null,
        result.truncated ? "truncated" : null,
      ].filter(Boolean).join(" ");

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: header + "\n" + (result.error ?? "verify_command failed") }],
          details: { ok: false, executed: result.executed, backend: result.backend, error: result.error },
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: header + "\n" + result.output }],
        details: {
          ok: true,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          cancelled: result.cancelled,
          truncated: result.truncated,
          outputBytes: result.outputBytes,
          backend: result.backend,
        },
      };
    },
  });
}
