/**
 * Read-only workflow execution: policy shape, backend selection, fail-closed
 * behaviour, and real sandbox probes on macOS (sandbox-exec) and Linux (bwrap).
 *
 * The probes spawn real processes under the shipped backend and resolve the
 * sandboxed command's *host* pid through the shared helper, because under bwrap
 * the pid the command prints is a namespace pid. Probes are skipped only where
 * no backend exists on the host; PI_REQUIRE_READONLY_SANDBOX=1 turns a missing
 * backend into a failure instead, and a backend that exists but cannot set
 * itself up fails its own assertions rather than being skipped.
 */
import { it } from 'node:test';
import { createConnection, createServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { closeSync, constants, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';

import { READONLY_EXECUTION_CONTRACT, workflowExecution } from '../pi-extension/subagents/workflow/execution.ts';
import {
  DEFAULT_VERIFY_OUTPUT_BYTES,
  DEFAULT_VERIFY_TIMEOUT_MS,
  MAX_VERIFY_OUTPUT_BYTES,
  MAX_VERIFY_TIMEOUT_MS,
  MIN_VERIFY_OUTPUT_BYTES,
  MIN_VERIFY_TIMEOUT_MS,
  READONLY_ENV,
  READONLY_TOOL_ALLOWLIST,
  VERIFY_COMMAND_TOOL,
  bwrapArgv,
  clampOutputBytes,
  clampTimeout,
  linuxVerifySeccomp,
  resolveVerifyBackend,
  runVerifyCommand,
  sandboxProfile,
  verifyToolEnabled,
} from '../pi-extension/subagents/workflow/readonly.ts';
import {
  findProcessesWithScratch,
  killProcessGroup,
  processGroupAlive,
  waitForProcessGroupExit,
  waitForSandboxCommand,
} from './helpers/readonly-process.ts';

/** Strict environments (the Linux image) must fail, not skip, without a backend. */
const requireSandbox = process.env.PI_REQUIRE_READONLY_SANDBOX === '1';
const backendProbe = resolveVerifyBackend();
const expectedBackend = process.platform === 'darwin' ? 'sandbox-exec'
  : process.platform === 'linux' ? 'bwrap'
    : null;
/** Under bwrap the command sees its own PID namespace, so printed pids are ns pids. */
const inNamespace = expectedBackend === 'bwrap';
const skipProbe = backendProbe.ok
  ? false
  : requireSandbox
    ? false
    : 'no verified read-only backend on this host: ' + backendProbe.reason;

function scratchFixture(base: string = tmpdir()) {
  const root = mkdtempSync(join(base, 'workflow-readonly-'));
  const work = join(root, 'work');
  const scratch = join(root, 'scratch');
  mkdirSync(work, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  return {
    root, work, scratch,
    run: (command: string, extra: Record<string, unknown> = {}) =>
      runVerifyCommand({ command, scratchDir: scratch, cwd: work, timeoutMs: 60_000, ...extra }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Minimal classic-BPF interpreter for the shipped seccomp filter. Executing the
 * control flow is what makes this a test of the filter rather than of its bytes:
 * every case below is "given this syscall, what does the program decide?".
 */
function runSeccompFilter(program: Buffer, syscall: { arch: number; nr: number }): number {
  let accumulator = 0;
  const load = (offset: number): number => {
    if (offset === 0) return syscall.nr;   // seccomp_data.nr
    if (offset === 4) return syscall.arch; // seccomp_data.arch
    throw new Error('filter reads an unsupported offset: ' + offset);
  };
  let pc = 0;
  while (pc * 8 < program.length) {
    const offset = pc * 8;
    const code = program.readUInt16LE(offset);
    const jt = program[offset + 2];
    const jf = program[offset + 3];
    const k = program.readUInt32LE(offset + 4);
    if (code === 0x20) { accumulator = load(k); pc += 1; continue; }              // LD | W | ABS
    if (code === 0x15) { pc += (accumulator === k ? jt : jf) + 1; continue; }     // JEQ | K
    if (code === 0x45) { pc += ((accumulator & k) !== 0 ? jt : jf) + 1; continue; } // JSET | K
    if (code === 0x06) return k;                                                  // RET | K
    throw new Error('filter uses an unsupported instruction: 0x' + code.toString(16));
  }
  throw new Error('filter ran off the end without deciding');
}

const SECCOMP_EPERM = 0x00050001;
const SECCOMP_KILL = 0x80000000;
const SECCOMP_ALLOW = 0x7fff0000;
it('read-only execution keeps only non-writing tools and never grants spawning', () => {
  const policy = workflowExecution(
    {
      tools: 'read,write,edit,bash,grep,find,ls,web_search,safe_bash,subagent,subagent_message,subagents_list,foo*',
      subagentAgents: ['worker', 'scout'],
    },
    { readOnly: true },
  );
  assert.deepEqual(policy.toolAllowlist.split(','), ['read', 'grep', 'find', 'ls', 'ask_question', VERIFY_COMMAND_TOOL]);
  assert.equal(policy.toolAllowlist, READONLY_TOOL_ALLOWLIST);
  assert.equal(policy.spawnable, null);
  assert.equal(policy.readOnly, true);
  assert.equal(policy.interactive, false);
  assert.equal(policy.autoExit, true);
  for (const writer of ['write', 'edit', 'bash', 'safe_bash', 'web_search', 'subagent', 'subagent_message', 'subagents_list', 'workflow', 'structured_output']) {
    assert.equal(policy.toolAllowlist.split(',').includes(writer), false, writer + ' must never be granted to a read-only step');
  }
  assert.match(policy.identity, /Read-only execution contract/);
  assert.match(policy.identity, /Delegation is disabled/);
  assert.equal(policy.identity.includes(READONLY_EXECUTION_CONTRACT), true);
});

it('a normal workflow step keeps its writers, extensions and delegation', () => {
  const policy = workflowExecution({
    tools: 'read,write,edit,bash,grep,find,ls,web_search,subagent,subagent_message,subagents_list',
    subagentAgents: ['worker'],
  });
  for (const tool of ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'web_search', 'ask_question', 'subagent', 'subagent_message', 'subagents_list']) {
    assert.equal(policy.toolAllowlist.split(',').includes(tool), true, tool);
  }
  assert.deepEqual(policy.spawnable, ['worker']);
  assert.equal(policy.readOnly, false);
  assert.equal(policy.identity.includes('Read-only execution contract'), false);
});

it('the macOS sandbox profile denies by default and opens writes only inside the scratch directory', () => {
  const scratch = '/private/var/tmp/readonly-scratch';
  const profile = sandboxProfile(scratch);
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(deny mach-lookup\)/);
  assert.match(profile, /\(allow file-read\*\)/);
  assert.equal(profile.includes('(allow file-write* (subpath "' + scratch + '") (literal "/dev/null"))'), true);
  assert.equal(profile.split('\n').filter(line => line.includes('file-write')).length, 1, 'exactly one write rule');
  assert.throws(() => sandboxProfile('relative/scratch'), /absolute path/);
  assert.throws(() => sandboxProfile('/tmp/sc"ratch'), /control characters or quotes/);
  assert.throws(() => sandboxProfile('/tmp/scratch\n(allow file-write* (subpath "/"))'), /control characters or quotes/);
});

it('the bubblewrap backend isolates namespaces and keeps only the scratch writable', () => {
  const argv = bwrapArgv('/scratch', '/work', 'node --test');
  assert.ok(argv.includes('--unshare-all'), 'all namespaces, network included, are unshared');
  assert.ok(argv.includes('--unshare-user'), 'a user namespace is required for the rest');
  assert.ok(argv.includes('--die-with-parent'), 'a dead owner must not leave the sandbox running');
  assert.ok(argv.includes('--new-session'), 'the command gets its own session and process group');
  const capDrop = argv.indexOf('--cap-drop');
  assert.deepEqual(argv.slice(capDrop, capDrop + 2), ['--cap-drop', 'ALL'], 'no capabilities survive');
  // The whole tree is bound read-only and /tmp is *not* shadowed, so a cwd
  // inside /tmp stays readable. A tmpfs there would hand the command an empty
  // directory and hide the project it is supposed to verify.
  const roBind = argv.indexOf('--ro-bind');
  assert.deepEqual(argv.slice(roBind, roBind + 3), ['--ro-bind', '/', '/']);
  assert.equal(argv.includes('--tmpfs'), false, '/tmp must not be shadowed');
  assert.deepEqual(argv.slice(argv.indexOf('--dev'), argv.indexOf('--dev') + 2), ['--dev', '/dev']);
  assert.deepEqual(argv.slice(argv.indexOf('--proc'), argv.indexOf('--proc') + 2), ['--proc', '/proc']);
  // The command's own scratch directory is the only writable bind.
  const bind = argv.indexOf('--bind');
  assert.deepEqual(argv.slice(bind, bind + 3), ['--bind', '/scratch', '/scratch']);
  assert.equal(argv.join(' ').includes('--bind / /'), false, 'the root is never bound writable');
  // The seccomp filter and the setup-status pipe travel as inherited fds, never
  // as shell text.
  const seccomp = argv.indexOf('--seccomp');
  assert.deepEqual(argv.slice(seccomp, seccomp + 2), ['--seccomp', '3']);
  const statusFd = argv.indexOf('--json-status-fd');
  assert.deepEqual(argv.slice(statusFd, statusFd + 2), ['--json-status-fd', '4']);
  assert.deepEqual(argv.slice(-3), ['/bin/sh', '-c', 'node --test']);
  assert.equal(argv.includes('--chdir'), true, 'the sandbox keeps the caller cwd');
});

it('the Linux seccomp filter denies socket creation and nothing else', () => {
  // Generic syscall numbers: socketpair(53/199), socket(41/198) and the
  // io_uring socket operations (425/426/427) are the same everywhere.
  for (const [arch, audit, socketNr, socketpairNr] of [
    ['x64', 0xc000003e, 41, 53],
    ['arm64', 0xc00000b7, 198, 199],
  ] as const) {
    const program = linuxVerifySeccomp(arch);
    assert.ok(Buffer.isBuffer(program) && program.length > 0);
    assert.equal(program.length % 8, 0, 'classic BPF instructions are 8 bytes each');

    const decide = (nr: number, abi = audit) => runSeccompFilter(program, { arch: abi, nr });
    assert.equal(decide(socketNr), SECCOMP_EPERM, 'socket() is refused with EPERM');
    for (const ioUring of [425, 426, 427]) {
      assert.equal(decide(ioUring), SECCOMP_EPERM, 'io_uring ' + ioUring + ' cannot sneak a socket past the filter');
    }
    // socketpair is what node uses for child_process IPC and test runners: if it
    // were denied, verify_command could not run a real suite.
    assert.equal(decide(socketpairNr), SECCOMP_ALLOW, 'socketpair stays allowed');
    assert.equal(decide(0), SECCOMP_ALLOW, 'unrelated syscalls stay allowed');
    assert.equal(decide(socketNr, 0x40000003e), SECCOMP_KILL, 'a foreign ABI is killed, never allowed');
  }

  // Control for the interpreter itself: a program that always returns ALLOW
  // must be read as ALLOW. Without this, a broken interpreter could pass every
  // assertion above by returning the expected constant.
  const allowAll = Buffer.alloc(8);
  allowAll.writeUInt16LE(0x06, 0);
  allowAll.writeUInt32LE(SECCOMP_ALLOW, 4);
  assert.equal(runSeccompFilter(allowAll, { arch: 0xc000003e, nr: 41 }), SECCOMP_ALLOW, 'the interpreter executes the program');
  const denyAll = Buffer.alloc(8);
  denyAll.writeUInt16LE(0x06, 0);
  denyAll.writeUInt32LE(SECCOMP_EPERM, 4);
  assert.equal(runSeccompFilter(denyAll, { arch: 0xc000003e, nr: 53 }), SECCOMP_EPERM, 'and follows its decisions');

  // x32 is the classic x86_64 escape: the audit arch matches but the syscall
  // number carries the 0x40000000 bit.
  const x64 = linuxVerifySeccomp('x64');
  assert.equal(runSeccompFilter(x64, { arch: 0xc000003e, nr: 0x40000000 | 41 }), SECCOMP_KILL, 'x32 syscalls are killed');
  assert.throws(() => linuxVerifySeccomp('ia32'), /Unsupported Linux verification seccomp ABI/);
  assert.throws(() => linuxVerifySeccomp('riscv64' as NodeJS.Architecture), /Unsupported Linux verification seccomp ABI/);
});

it('reports the platform backend, or why this host has none', () => {
  if (backendProbe.ok) {
    assert.equal(backendProbe.backend.kind, expectedBackend, 'the selected backend must match the platform');
  } else {
    assert.ok(backendProbe.reason.length > 0, 'a refusal must explain itself');
    if (expectedBackend === 'bwrap') assert.match(backendProbe.reason, /bwrap|bubblewrap/);
    if (expectedBackend === 'sandbox-exec') assert.match(backendProbe.reason, /sandbox-exec/);
  }
});

it('PI_REQUIRE_READONLY_SANDBOX=1 fails instead of skipping when no backend exists', () => {
  if (!requireSandbox) return; // the flag is only meaningful in the strict image
  assert.equal(skipProbe, false, 'the strict flag must disable probe skipping');
  assert.equal(backendProbe.ok, true, 'PI_REQUIRE_READONLY_SANDBOX=1 without a usable backend: '
    + (backendProbe.ok ? 'backend present' : backendProbe.reason));
});

it('refuses to run anything when no backend matches the platform', async () => {
  const noSandbox = resolveVerifyBackend({ platform: 'darwin', existsSync: () => false });
  assert.equal(noSandbox.ok, false);
  assert.match(String((noSandbox as any).reason), /sandbox-exec/);

  const noBwrap = resolveVerifyBackend({ platform: 'linux', existsSync: () => false, env: { PATH: '/usr/bin' } });
  assert.equal(noBwrap.ok, false);
  assert.match(String((noBwrap as any).reason), /bubblewrap|bwrap/);

  const wrongAbi = resolveVerifyBackend({ platform: 'linux', arch: 'ia32' as NodeJS.Architecture, existsSync: () => true, env: { PATH: '/usr/bin' } } as any);
  assert.equal(wrongAbi.ok, false);
  assert.match(String((wrongAbi as any).reason), /arm64 or x64/);

  const otherPlatform = resolveVerifyBackend({ platform: 'win32', existsSync: () => true });
  assert.equal(otherPlatform.ok, false);
  assert.match(String((otherPlatform as any).reason), /unsupported/);

  const fixture = scratchFixture();
  try {
    const marker = join(fixture.root, 'marker');
    const result = await runVerifyCommand({
      command: 'touch ' + marker,
      scratchDir: fixture.scratch,
      cwd: fixture.work,
      platform: 'linux',
      env: { PATH: '/nonexistent' },
      existsSync: () => false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.executed, false, 'the command must not run at all');
    assert.equal(result.backend, null);
    assert.equal(existsSync(marker), false);
  } finally {
    fixture.cleanup();
  }
});

it('the verify tool stays inert without a parent-supplied scratch directory', () => {
  assert.equal(verifyToolEnabled({}), false);
  assert.equal(verifyToolEnabled({ [READONLY_ENV.scratch]: 'relative/scratch' }), false);
  assert.equal(verifyToolEnabled({ [READONLY_ENV.scratch]: '/tmp/scratch' }), true);
});

it('clamps the command timeout and the output ceiling', () => {
  assert.equal(clampTimeout(1), MIN_VERIFY_TIMEOUT_MS);
  assert.equal(clampTimeout(10 ** 9), MAX_VERIFY_TIMEOUT_MS);
  assert.equal(clampTimeout('nope'), DEFAULT_VERIFY_TIMEOUT_MS);
  assert.equal(clampOutputBytes(1), MIN_VERIFY_OUTPUT_BYTES);
  assert.equal(clampOutputBytes(10 ** 9), MAX_VERIFY_OUTPUT_BYTES);
  assert.equal(clampOutputBytes('nope'), DEFAULT_VERIFY_OUTPUT_BYTES);
});

it('templates mark plan, review and verify steps read-only while apply stays writable', () => {
  const review = readFileSync(new URL('../examples/workflows/review-changes.js', import.meta.url), 'utf8');
  const migrate = readFileSync(new URL('../examples/workflows/migrate-files.js', import.meta.url), 'utf8');
  assert.equal((review.match(/readOnly: true/g) ?? []).length, 2, 'audit and verifier are read-only');
  // plan and the single verify call (quick or risky) are read-only; apply is not
  assert.equal((migrate.match(/readOnly: true/g) ?? []).length, 2, 'plan and the verifier are read-only');
  assert.match(review, /label: 'audit:' \+ dimension\.name,[\s\S]{0,200}?readOnly: true/);
  assert.match(review, /label: 'verify:' \+ dimension\.name \+ ':' \+ \(index \+ 1\),[\s\S]{0,200}?readOnly: true/);
  assert.match(migrate, /label: 'plan:' \+ baseName\(file\),[\s\S]{0,200}?readOnly: true/);
  assert.doesNotMatch(migrate, /label: 'apply:' \+ baseName\(file\),[\s\S]{0,200}?readOnly: true/, 'apply must stay writable');
});
it('runs a real test suite read-only, blocks writes, symlink escapes, network and IPC', { skip: skipProbe }, async () => {
  const fixture = scratchFixture();
  try {
    writeFileSync(join(fixture.work, 'test.cjs'), "const { test } = require('node:test');\nconst assert = require('node:assert');\ntest('adds', () => assert.equal(1 + 1, 2));\n");

    const suite = await fixture.run('node --test test.cjs');
    assert.equal(suite.ok, true, suite.error);
    assert.equal(suite.exitCode, 0, suite.output);
    assert.match(suite.output, /# pass 1/);
    assert.equal(suite.backend, expectedBackend, 'the probe must exercise the platform backend');

    // Each command gets its own scratch directory under the parent's root;
    // the parent directory itself is not writable by the command.
    // fixture.scratch may be a symlinked path (/tmp -> /private/tmp on macOS).
    assert.ok(suite.scratchDir && suite.scratchDir.startsWith(realpathSync(fixture.scratch)), 'scratch lives under the parent root');
    assert.notEqual(suite.scratchDir, fixture.scratch, 'each command gets a private directory');
    assert.equal(existsSync(suite.scratchDir!), false, 'the per-command scratch directory is removed afterwards');

    const outside = join(fixture.root, 'outside.txt');
    const direct = await fixture.run('echo hi > ' + outside);
    assert.notEqual(direct.exitCode, 0, 'a write outside the scratch directory must fail');
    assert.equal(existsSync(outside), false);
    const outsideDir = join(fixture.root, 'outside-directory');
    const directory = await fixture.run('mkdir ' + outsideDir);
    assert.notEqual(directory.exitCode, 0, 'metadata writes outside scratch must also fail');
    assert.equal(existsSync(outsideDir), false);

    const target = join(fixture.root, 'symlink-target.txt');
    // The realistic escape: the command creates the symlink itself inside its
    // writable directory, then writes through it.
    const viaLink = await fixture.run('ln -s ' + target + ' ./link && echo hi > ./link');
    assert.notEqual(viaLink.exitCode, 0, 'a symlink out of the scratch directory must fail');
    assert.equal(existsSync(target), false);

    // Writes are limited to the command's own scratch directory, so the command
    // has to use $TMPDIR (which points there) rather than its cwd.
    const inside = await fixture.run('echo ok > "$TMPDIR/inside.txt" && cat "$TMPDIR/inside.txt"');
    assert.equal(inside.exitCode, 0, inside.output);
    assert.match(inside.output, /ok/);

    const network = await fixture.run(
      "node -e \"fetch('https://example.com',{signal:AbortSignal.timeout(3000)}).then(()=>{console.log('NET-OK');process.exit(7)}).catch(()=>console.log('NET-BLOCKED'))\"",
    );
    assert.match(network.output, /NET-BLOCKED/);
    assert.notEqual(network.exitCode, 7, 'the fetch must not have succeeded');

    const server = createServer(socket => socket.end('PONG'));
    const socketPath = join(fixture.root, 'ipc.sock');
    await new Promise<void>(resolve => server.listen(socketPath, () => resolve()));
    try {
      // Positive control first: the very same client code succeeds from outside
      // the sandbox. Without this the refusal below could just be a broken probe.
      const outside = await new Promise<string>((resolve, reject) => {
        const probe = createConnection(socketPath);
        probe.on('data', data => { probe.destroy(); resolve(data.toString()); });
        probe.on('error', reject);
      });
      assert.equal(outside, 'PONG', 'the listener must serve a client outside the sandbox');

      const ipc = await fixture.run(
        'node -e "const net=require(\'node:net\');const s=net.connect(process.argv[1]);' +
        "s.on('data',d=>{console.log('IPC-OK:'+d);process.exit(7)});" +
        "s.on('error',e=>console.log('IPC-BLOCKED:'+e.code));\" " + socketPath,
      );
      assert.doesNotMatch(ipc.output, /IPC-OK/, 'a Unix pathname socket must stay unreachable');
      assert.match(ipc.output, /IPC-BLOCKED:(EPERM|EACCES|ENOENT|ECONNREFUSED|EPROTOTYPE)/, 'the refusal must be an errno, not a crash');
      assert.notEqual(ipc.exitCode, 7, 'reaching another local process must be blocked');
    } finally {
      server.close();
    }
  } finally {
    fixture.cleanup();
  }
});

it('keeps socketpair-based child IPC working inside the sandbox', { skip: skipProbe }, async () => {
  // The seccomp filter denies socket(), so socketpair() is what still lets a
  // sandboxed command run tests and child processes. If this breaks, the
  // filter is too wide and verify_command becomes useless for real projects.
  const fixture = scratchFixture();
  try {
    writeFileSync(join(fixture.work, 'pair-child.cjs'), "process.send('pong', () => process.exit(0));\n");
    const childPath = join(fixture.work, 'pair-child.cjs');
    const pair = await fixture.run(
      'node -e "const cp=require(\'node:child_process\');' +
      "const c=cp.fork(process.argv[1],{stdio:['ignore','pipe','pipe','ipc']});" +
      "c.on('message',m=>console.log('PAIR-OK:'+m));" +
      "c.on('error',e=>{console.log('PAIR-ERROR:'+e.message);process.exit(7);});\" " + childPath,
    );
    assert.equal(pair.exitCode, 0, pair.output);
    assert.match(pair.output, /PAIR-OK:pong/);
  } finally {
    fixture.cleanup();
  }
});

it('keeps a cwd under /tmp readable while the scratch stays the only writable place', { skip: skipProbe }, async () => {
  // Linux binds / read-only instead of shadowing /tmp with a tmpfs, so a cwd
  // inside /tmp stays readable. This is the regression that would appear if the
  // bwrap argv ever gained --tmpfs /tmp: the command would run in an empty
  // directory and see none of the project.
  const fixture = scratchFixture('/tmp');
  try {
    writeFileSync(join(fixture.work, 'marker.txt'), 'CWD-READABLE');
    const read = await fixture.run('cat marker.txt && pwd');
    assert.equal(read.exitCode, 0, read.output);
    assert.match(read.output, /CWD-READABLE/);
    assert.equal(read.output.includes(realpathSync(fixture.work)), true, 'the command ran in the real cwd: ' + read.output);

    const cwdWrite = await fixture.run('echo nope > ./cwd-write.txt');
    assert.notEqual(cwdWrite.exitCode, 0, 'the cwd must stay read-only');
    assert.equal(existsSync(join(fixture.work, 'cwd-write.txt')), false);

    const tmpWrite = await fixture.run('echo nope > /tmp/verify-escape-' + process.pid);
    assert.notEqual(tmpWrite.exitCode, 0, '/tmp itself must stay read-only');
    assert.equal(existsSync('/tmp/verify-escape-' + process.pid), false);

    const scratchWrite = await fixture.run('echo ok > "$TMPDIR/only.txt" && cat "$TMPDIR/only.txt"');
    assert.equal(scratchWrite.exitCode, 0, scratchWrite.output);
    assert.match(scratchWrite.output, /ok/);
  } finally {
    fixture.cleanup();
  }
});

it('cancels a running command and leaves no process behind', { skip: skipProbe }, async () => {
  const fixture = scratchFixture();
  const controller = new AbortController();
  try {
    const pending = fixture.run('echo $$ > "$TMPDIR/group.txt"; sleep 60', { signal: controller.signal });
    const started = await waitForSandboxCommand({ parentScratch: fixture.scratch });
    assert.equal(processGroupAlive(started.ref.pgid), true, 'the command group runs before the cancel');

    controller.abort();
    const result = await pending;
    assert.equal(result.ok, true, result.error);
    assert.equal(result.cancelled, true, 'the abort must be recorded as a cancel');
    assert.equal(result.timedOut, false);
    assert.equal(
      await waitForProcessGroupExit(started.ref.pgid, 5_000),
      true,
      'the sandboxed command group must die with the cancel (pgid ' + started.ref.pgid + ')',
    );
  } finally {
    fixture.cleanup();
  }
});
it('abort racing a timeout records one reason and leaves no late kill armed', { skip: skipProbe }, async () => {
  const fixture = scratchFixture();
  try {
    // Deterministic race: the injected kill hook aborts the call in the very same
    // tick the timeout fires, before the child can exit. A second terminate() must
    // be ignored, so the first reason (timeout) survives and no extra kill timer
    // stays armed past the result.
    const controller = new AbortController();
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let abortedInHook = false;
    const pending = runVerifyCommand({
      command: 'sleep 30',
      scratchDir: fixture.scratch,
      cwd: fixture.work,
      timeoutMs: MIN_VERIFY_TIMEOUT_MS,
      signal: controller.signal,
      killProcessGroup: (pid, signal) => {
        kills.push({ pid, signal });
        if (!abortedInHook) {
          // Abort while terminate() is still on the stack: this is the race.
          abortedInHook = true;
          controller.abort();
        }
      },
    });
    // The hook does not really signal, so end the command ourselves once the
    // race has been staged.
    const deadline = Date.now() + 10_000;
    while (!abortedInHook && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.equal(abortedInHook, true, 'the timeout must fire and stage the race');
    const leader = kills[0].pid;
    killProcessGroup(leader);

    const result = await pending;
    assert.equal(result.timedOut, true, 'the timeout is the first reason');
    assert.equal(result.cancelled, false, 'a racing abort must not overwrite the first reason');

    const atSettle = kills.length;
    await new Promise(r => setTimeout(r, 2_500));
    assert.equal(kills.length, atSettle, 'no kill may fire after the result settled: ' + JSON.stringify(kills.slice(atSettle)));
  } finally {
    fixture.cleanup();
  }
});

it('kills its process group when the owning pi process is SIGKILLed', { skip: skipProbe }, async () => {
  const fixture = scratchFixture();
  const readonlyModule = join(fileURLToPath(new URL('..', import.meta.url)), 'pi-extension', 'subagents', 'workflow', 'readonly.ts');
  const childScript = join(fixture.root, 'owner.mjs');
  // The command reports its own pid (a namespace pid under bwrap) into its own
  // scratch directory; the helper maps it back to a host pid.
  writeFileSync(childScript, [
    'import { runVerifyCommand } from ' + JSON.stringify(readonlyModule) + ';',
    'const [scratch, cwd] = process.argv.slice(2);',
    "runVerifyCommand({ command: 'echo $$ > $TMPDIR/group.txt; sleep 120',",
    '  scratchDir: scratch, cwd, timeoutMs: 600_000 }).then(r => console.log("RESULT", r.exitCode, r.executed));',
    '',
  ].join('\n'));

  // A stand-in for pi: it owns the verify command through ownerPid = its own pid.
  const owner = spawn(process.execPath, ['--experimental-strip-types', childScript, fixture.scratch, fixture.work], {
    cwd: fixture.root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  let pgid = 0;
  try {
    const started = await waitForSandboxCommand({ parentScratch: fixture.scratch, timeoutMs: 5_000 });
    pgid = started.ref.pgid;
    assert.equal(processGroupAlive(pgid), true, 'the command group is alive before the owner dies');

    // Kill the owner outright: no abort, no cleanup path, no chance to signal.
    owner.kill('SIGKILL');
    await new Promise(resolve => owner.once('exit', resolve));

    // The watchdog must notice and kill the wrapper's group; bwrap --die-with-parent
    // reaps the namespace behind it. Bounded, so a missing watchdog fails an
    // assertion instead of hanging the suite.
    assert.equal(
      await waitForProcessGroupExit(pgid, 3_000),
      true,
      'the sandboxed command group must die with its owner (pgid ' + pgid + ' still alive)',
    );
  } finally {
    killProcessGroup(pgid);
    try { owner.kill('SIGKILL'); } catch { /* already gone */ }
    fixture.cleanup();
  }
});

it('detects a survivor by its scratch path, so the leftover probe is not vacuous', async () => {
  // Positive control for findProcessesWithScratch: a process carrying the path
  // in its argv must be found, and must disappear once it exits. Without this
  // the "no wrapper outlives a command" assertion could pass by finding nothing
  // ever.
  const fixture = scratchFixture();
  let child: ReturnType<typeof spawn> | null = null;
  try {
    const markerPath = join(fixture.scratch, 'cmd-control');
    mkdirSync(markerPath, { recursive: true });
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', markerPath], { stdio: 'ignore' });
    const deadline = Date.now() + 3_000;
    let found = findProcessesWithScratch(fixture.scratch);
    while (found.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      found = findProcessesWithScratch(fixture.scratch);
    }
    assert.ok(found.includes(child.pid!), 'a live process carrying the scratch path must be detected, saw ' + JSON.stringify(found));

    child.kill('SIGKILL');
    await new Promise(resolve => child!.once('exit', resolve));
    const cleared = Date.now() + 2_000;
    let remaining = findProcessesWithScratch(fixture.scratch);
    while (remaining.includes(child.pid!) && Date.now() < cleared) {
      await new Promise(resolve => setTimeout(resolve, 50));
      remaining = findProcessesWithScratch(fixture.scratch);
    }
    assert.equal(remaining.includes(child.pid!), false, 'the detector must clear once the process is gone');
  } finally {
    try { child?.kill('SIGKILL'); } catch { /* already gone */ }
    fixture.cleanup();
  }
});

it('leaves no wrapper or watchdog process behind after a normal exit', { skip: skipProbe }, async () => {
  const fixture = scratchFixture();
  try {
    const result = await fixture.run('echo done');
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.executed, true, 'a real run must report that the sandbox started');

    // The wrapper, the watchdog and the sandbox share this unique scratch path in
    // their argv/environment, so a survivor is visible without touching pids.
    const deadline = Date.now() + 3_000;
    let survivors = findProcessesWithScratch(fixture.scratch);
    while (survivors.length > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      survivors = findProcessesWithScratch(fixture.scratch);
    }
    assert.deepEqual(survivors, [], 'no wrapper, watchdog or sandbox may outlive a completed command');
  } finally {
    fixture.cleanup();
  }
});

it('fails closed when bubblewrap is installed but cannot set up the sandbox', async () => {
  // A bwrap that exits before it reports a child pid must never look like a run
  // command: the runtime reports ok=false / executed=false and the user command
  // never starts. This is the Linux variant of "no backend", and there is no
  // unsandboxed fallback.
  const fixture = scratchFixture();
  const fakeBin = join(fixture.root, 'fake-bin');
  mkdirSync(fakeBin, { recursive: true });
  const fakeBwrap = join(fakeBin, 'bwrap');
  writeFileSync(fakeBwrap, '#!/bin/sh\necho "bwrap: setting up uid map: Permission denied" >&2\nexit 1\n', { mode: 0o755 });
  try {
    const marker = join(fixture.work, 'marker');
    const result = await runVerifyCommand({
      command: 'touch ' + marker,
      scratchDir: fixture.scratch,
      cwd: fixture.work,
      platform: 'linux',
      env: { PATH: fakeBin },
      // The resolver prefers system directories (/usr/bin/bwrap), so pin the
      // probe to this fake explicitly: only the failure path is under test, and
      // on a Linux host the real bubblewrap must not be picked up instead.
      existsSync: (path: string) => {
        // Only the fake bwrap "exists"; python3 keeps resolving normally, so the
        // backend is complete and the failure under test is bubblewrap's setup.
        if (/python3$/.test(path)) return existsSync(path);
        try { return realpathSync(path) === realpathSync(fakeBwrap); } catch { return false; }
      },
    });
    assert.equal(result.ok, false, 'a setup failure is not a successful run');
    assert.equal(result.executed, false, 'no user command ran, so nothing may be reported as executed');
    assert.equal(result.backend, 'bwrap');
    assert.match(String(result.error), /could not start|user namespaces/);
    assert.equal(existsSync(marker), false, 'the user command must not run without a sandbox');
  } finally {
    fixture.cleanup();
  }
});

for (const reason of ['cancel', 'timeout'] as const) {
  it('preserves ' + reason + ' while Linux sandbox setup is still pending', async () => {
    const fixture = scratchFixture();
    const fake = join(fixture.root, 'bwrap');
    const ready = join(fixture.root, 'setup-ready');
    const controller = new AbortController();
    writeFileSync(fake, '#!/bin/sh\nprintf ready > "$BWRAP_GATE_PATH"\nexec /bin/sleep 60\n', { mode: 0o755 });
    const pending = fixture.run('touch must-not-run', {
      platform: 'linux', env: { PATH: fixture.root, BWRAP_GATE_PATH: ready },
      // Only the fake bubblewrap "exists"; python3 must keep resolving, or the
      // backend is rejected for the missing Landlock dependency before the
      // setup window this test is about ever opens.
      existsSync: (path: string) => (/python3$/.test(path) ? existsSync(path) : path === fake),
      signal: controller.signal, timeoutMs: reason === 'timeout' ? 1_000 : 60_000,
    });
    try {
      const deadline = Date.now() + 3_000;
      while (!existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(existsSync(ready), 'the backend must be inside setup before cancellation');
      if (reason === 'cancel') controller.abort();
      const result = await pending;
      assert.equal(result.ok, true, result.error);
      assert.equal(result.executed, false, 'the backend never reported a started sandbox');
      assert.equal(result.cancelled, reason === 'cancel');
      assert.equal(result.timedOut, reason === 'timeout');
      assert.equal(result.error, undefined, 'cancellation must not become an unavailable-backend error');
      assert.equal(existsSync(join(fixture.work, 'must-not-run')), false);
    } finally {
      controller.abort();
      await pending;
      fixture.cleanup();
    }
  });
}

it('refuses writing to an existing FIFO while the host end stays alive', { skip: skipProbe }, async () => {
  // A read-only bind/mount refuses creating, renaming and truncating through the
  // workspace, but opening an *existing* FIFO for writing is a different path:
  // the open itself does not modify the filesystem, so only Landlock (Linux) or
  // the file-write rules (macOS) stop it. This is the case that motivated the
  // Landlock layer, so it gets a real positive control rather than a "no output"
  // assertion: the host proves the FIFO is alive and then proves it received
  // nothing from the sandbox.
  const fixture = scratchFixture();
  let hostFd: number | null = null;
  try {
    const fifo = join(fixture.root, 'pipe.fifo');
    execFileSync('mkfifo', [fifo]);
    hostFd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);

    // Positive control: this end really moves bytes in both directions, so a
    // later silence means "the sandbox was refused", not "the FIFO is broken".
    writeSync(hostFd, 'HOST-PING');
    const ping = Buffer.alloc(64);
    const pingBytes = readSync(hostFd, ping, 0, 64, null);
    assert.equal(ping.subarray(0, pingBytes).toString(), 'HOST-PING', 'the FIFO must be alive before the probe');

    const result = await fixture.run(
      "node -e \"const fs=require('fs');try{const f=fs.openSync(process.argv[1],fs.constants.O_WRONLY|fs.constants.O_NONBLOCK);" +
      "fs.writeSync(f,'SANDBOX-BYTES');console.log('FIFO-WRITE-OK')}" +
      "catch(e){console.log('FIFO-WRITE-DENIED:'+e.code)}\" " + fifo,
    );
    assert.match(result.output, /FIFO-WRITE-DENIED:(EPERM|EACCES|EROFS)/, 'writing an existing FIFO must be refused, got: ' + JSON.stringify(result.output));
    assert.doesNotMatch(result.output, /FIFO-WRITE-OK/);

    // The host end may hold nothing but what the host itself wrote.
    const drained: string[] = [];
    const chunk = Buffer.alloc(64);
    for (;;) {
      let read = 0;
      try { read = readSync(hostFd, chunk, 0, 64, null); }
      catch (error: any) {
        assert.ok(error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK', 'only an empty FIFO is an acceptable read failure');
        break;
      }
      if (read <= 0) break;
      drained.push(chunk.subarray(0, read).toString());
    }
    assert.equal(drained.join(''), '', 'the sandbox must not have delivered a single byte: ' + JSON.stringify(drained.join('')));

    // The same ruleset must still leave the command's own scratch writable,
    // otherwise the Landlock layer would break every real verification command.
    const scratchWrite = await fixture.run('echo landlock-ok > "$TMPDIR/probe.txt" && cat "$TMPDIR/probe.txt"');
    assert.equal(scratchWrite.exitCode, 0, scratchWrite.output);
    assert.match(scratchWrite.output, /landlock-ok/);
  } finally {
    if (hostFd !== null) closeSync(hostFd);
    fixture.cleanup();
  }
});

it('refuses to start when Linux lacks Python 3 for the Landlock ruleset', async () => {
  // The Linux backend is bwrap (mounts + seccomp) plus a Landlock launcher. A
  // host with bubblewrap but no python3 has no way to close the FIFO write path,
  // so it must refuse rather than run the command under a weaker sandbox.
  const withBwrapNoPython = resolveVerifyBackend({
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    // bubblewrap resolves; python3 does not.
    existsSync: (path: string) => /bwrap$/.test(path),
  });
  assert.equal(withBwrapNoPython.ok, false, 'bwrap without python3 is not a read-only backend');
  assert.match(String((withBwrapNoPython as any).reason), /Python 3|Landlock/);

  // Both present → a bwrap backend carrying the python command it will use.
  const complete = resolveVerifyBackend({
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    existsSync: () => true,
  });
  assert.equal(complete.ok, true);
  assert.equal(complete.backend.kind, 'bwrap');
  assert.match(String((complete.backend as any).pythonCommand), /python3$/);
  // The launcher argv must keep the user command as the trailing sh -c, with the
  // fixed Landlock launcher in front of it.
  const argv = bwrapArgv('/scratch', '/work', 'echo hi', (complete.backend as any).pythonCommand);
  assert.deepEqual(argv.slice(-3), ['/bin/sh', '-c', 'echo hi']);
  assert.equal(argv[argv.indexOf('/bin/sh') - 1], '/scratch', 'the scratch is the launcher scratch argument');
  assert.ok(argv.includes('-I') && argv.includes('-S'), 'python3 runs isolated and without site customisation');
});

it('does not report an executed command when the Landlock launcher fails', async () => {
  // A fake bubblewrap that completes its own setup and then hands control to a
  // failing Landlock launcher: bubblewrap "started", but the user's command never
  // ran. The runtime must not turn that into executed=true.
  const fixture = scratchFixture();
  const fakeBin = join(fixture.root, 'fake-bin');
  mkdirSync(fakeBin, { recursive: true });
  const fakeBwrap = join(fakeBin, 'bwrap');
  const fakePython = join(fakeBin, 'python3');
  const marker = join(fixture.work, 'landlock-marker');
  // Skip bubblewrap's own flags, report a child pid like the real one does, then
  // exec the launcher argv it was given after "--".
  writeFileSync(fakeBwrap, [
    '#!/bin/sh',
    'while [ "$1" != "--" ] && [ $# -gt 0 ]; do shift; done',
    'shift',
    'printf \'{"child-pid":%s}\\n\' "$$" >&4 2>/dev/null || true',
    'exec "$@"',
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(fakePython, '#!/bin/sh\necho "Landlock setup failed: create_ruleset version probe: Operation not supported" >&2\nexit 125\n', { mode: 0o755 });
  try {
    const result = await runVerifyCommand({
      command: 'touch ' + marker,
      scratchDir: fixture.scratch,
      cwd: fixture.work,
      platform: 'linux',
      env: { PATH: fakeBin },
      existsSync: (path: string) => {
        try {
          const real = realpathSync(path);
          return real === realpathSync(fakeBwrap) || real === realpathSync(fakePython);
        } catch { return false; }
      },
    });
    assert.equal(existsSync(marker), false, 'the user command must never run behind a failed Landlock launcher');
    assert.equal(result.executed, false, 'a failed Landlock setup is not an executed command');
    assert.equal(result.ok, false, 'the call must fail closed, not report success');
    assert.match(String(result.error ?? '') + result.output, /Landlock/, 'the failure must name the Landlock launcher');
  } finally {
    fixture.cleanup();
  }
});

it('caps multi-byte output by bytes, not by string length', { skip: skipProbe }, async () => {
  const fixture = scratchFixture();
  try {
    // 2000 three-byte characters: 6000 bytes but only 2000 characters. Under a
    // cap of 4096 a length-based limit would keep all of it (2000 < 4096) and
    // let 6000 bytes through; a byte-based limit truncates at 4096.
    const cap = MIN_VERIFY_OUTPUT_BYTES;
    const result = await fixture.run("node -e \"process.stdout.write('\\u4e16'.repeat(2000))\"", {
      maxOutputBytes: cap,
    });
    assert.equal(result.truncated, true, 'the byte cap must trip even though the character count fits');
    assert.ok(Buffer.byteLength(result.output, 'utf8') <= cap + 128, 'retained bytes stay at the cap, got ' + Buffer.byteLength(result.output, 'utf8'));
    assert.ok(result.outputBytes <= cap, 'outputBytes counts bytes, got ' + result.outputBytes);
  } finally {
    fixture.cleanup();
  }
});

it('reaps a background child that outlives a normally-exiting shell', { skip: skipProbe }, async () => {
  const fixture = scratchFixture();
  try {
    // The leader exits 0 at once, but the background child inherits the pipes, so
    // the close event cannot fire until that child dies. Only a group reap on
    // leader exit ends the call: without it the step hangs until the timeout.
    const result = await fixture.run('sleep 30 & echo BG=$!; exit 0', { timeoutMs: 5_000 });
    assert.equal(result.timedOut, false, 'a normal exit must not be reported as a timeout');
    assert.equal(result.exitCode, 0, result.output);
    assert.ok(result.durationMs < 4_000, 'the call must end at leader exit, took ' + result.durationMs + 'ms');

    // Nothing from the command may survive it. The namespace pid the shell
    // printed is meaningless on the host, so look for the command's own scratch
    // path instead: every process of this call carries it in argv or TMPDIR.
    const deadline = Date.now() + 3_000;
    let survivors = findProcessesWithScratch(result.scratchDir!);
    while (survivors.length > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      survivors = findProcessesWithScratch(result.scratchDir!);
    }
    assert.deepEqual(survivors, [], 'the background child must not outlive the call');

    if (!inNamespace) {
      // macOS has no PID namespace, so the printed pid is the host pid.
      const pid = Number((/BG=(\d+)/.exec(result.output) ?? [])[1]);
      assert.ok(Number.isInteger(pid) && pid > 0, 'the probe must report the background pid, got: ' + JSON.stringify(result.output));
      assert.throws(() => process.kill(pid, 0), /ESRCH/, 'background pid ' + pid + ' must not survive the call');
    }
  } finally {
    fixture.cleanup();
  }
});

it('cannot hard-link a workspace file into its scratch directory to write through it', { skip: skipProbe }, async () => {
  const fixture = scratchFixture();
  try {
    const target = join(fixture.work, 'target.txt');
    writeFileSync(target, 'ORIGINAL');
    // A hard link shares the inode, so a path-based write rule would be bypassed
    // if the link could be created inside the writable directory. The sandbox
    // refuses link() itself, so the link never exists.
    const result = await fixture.run(
      "node -e \"try{require('fs').linkSync(process.argv[1], process.env.TMPDIR + '/link');" +
      "require('fs').writeFileSync(process.env.TMPDIR + '/link', 'HACKED');console.log('HARDLINK-WRITE-OK')}" +
      "catch(e){console.log('HARDLINK-DENIED:' + e.code)}\" " + target,
    );
    assert.match(result.output, /HARDLINK-DENIED/, 'creating a hard link to a workspace file must fail');
    assert.doesNotMatch(result.output, /HARDLINK-WRITE-OK/);
    assert.equal(readFileSync(target, 'utf8'), 'ORIGINAL', 'the workspace file bytes must be unchanged');
  } finally {
    fixture.cleanup();
  }
});

it('a hard link planted before the command is the one residual write path', { skip: skipProbe }, async () => {
  // Documents the limit rather than pretending it is closed: a link that already
  // exists inside the writable directory is writable through. The runtime makes
  // that unreachable by handing each command a fresh, empty mkdtemp directory
  // and deleting it afterwards, which this test also asserts.
  const fixture = scratchFixture();
  try {
    const target = join(fixture.work, 'target.txt');
    writeFileSync(target, 'ORIGINAL');
    let plantedLink = true;
    const planted = await runVerifyCommand({
      command: 'echo HACKED > $TMPDIR/preexisting',
      scratchDir: fixture.scratch,
      cwd: fixture.work,
      timeoutMs: 30_000,
      // Simulate a pre-planted link by creating it inside the per-command dir
      // the instant it exists, before the shell runs.
      mkdtempSync: (template: string) => {
        const dir = mkdtempSync(template);
        try {
          linkSync(target, join(dir, 'preexisting'));
        } catch {
          plantedLink = false; // e.g. EXDEV when the two live on different mounts
        }
        return dir;
      },
    });
    assert.equal(planted.exitCode, 0, planted.output);
    assert.equal(existsSync(planted.scratchDir!), false, 'the writable directory does not survive the command');
    if (plantedLink) {
      assert.equal(readFileSync(target, 'utf8'), 'HACKED\n', 'this is the residual path the fresh-empty-directory rule removes');
    }
  } finally {
    fixture.cleanup();
  }
});

it('timeout terminates the sandboxed command and its group', { skip: skipProbe }, async () => {
  const fixture = scratchFixture();
  try {
    const pending = fixture.run('echo $$ > "$TMPDIR/group.txt"; sleep 30', { timeoutMs: 2_500 });
    const started = await waitForSandboxCommand({ parentScratch: fixture.scratch, timeoutMs: 5_000 });
    assert.equal(processGroupAlive(started.ref.pgid), true, 'the command group runs before the timeout');

    const result = await pending;
    assert.equal(result.timedOut, true);
    assert.ok(result.durationMs < 15_000, 'the timeout must fire promptly, took ' + result.durationMs + 'ms');
    assert.equal(
      await waitForProcessGroupExit(started.ref.pgid, 5_000),
      true,
      'the sandboxed command group must die with the timeout (pgid ' + started.ref.pgid + ')',
    );
    // result.pid is the wrapper's group; nothing of it may survive either.
    assert.ok(typeof result.pid === 'number' && result.pid > 0);
    assert.equal(await waitForProcessGroupExit(result.pid!, 5_000), true, 'the wrapper group must die too');
  } finally {
    fixture.cleanup();
  }
});

it('caps command output instead of buffering it all', { skip: skipProbe }, async () => {
  const fixture = scratchFixture();
  try {
    const result = await fixture.run("node -e \"process.stdout.write('x'.repeat(200000))\"", {
      maxOutputBytes: MIN_VERIFY_OUTPUT_BYTES,
    });
    assert.equal(result.truncated, true);
    assert.ok(result.output.length <= MIN_VERIFY_OUTPUT_BYTES + 64, 'output stayed near the cap, got ' + result.output.length);
  } finally {
    fixture.cleanup();
  }
});
