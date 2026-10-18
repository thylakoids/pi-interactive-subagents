/**
 * Read-only workflow execution: policy shape, backend selection, fail-closed
 * behaviour, and real macOS sandbox probes.
 *
 * The probes spawn real processes under the shipped profile. They are skipped
 * where no verified backend exists, so this file never claims sandbox coverage
 * it did not exercise.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  resolveVerifyBackend,
  runVerifyCommand,
  sandboxProfile,
  verifyToolEnabled,
} from '../pi-extension/subagents/workflow/readonly.ts';

const sandboxAvailable = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const skipProbe = sandboxAvailable ? false : 'no verified read-only backend on this host (macOS sandbox-exec only)';

function scratchFixture() {
  const root = mkdtempSync(join(tmpdir(), 'workflow-readonly-'));
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

it('the sandbox profile denies by default and opens writes only inside the scratch directory', () => {
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

it('the bubblewrap backend binds the tree read-only and unshares the network', () => {
  const argv = bwrapArgv('/scratch', '/work', 'node --test');
  assert.ok(argv.includes('--unshare-all'), 'namespaces and network are unshared');
  assert.ok(argv.includes('--die-with-parent'));
  const roBind = argv.indexOf('--ro-bind');
  assert.deepEqual(argv.slice(roBind, roBind + 3), ['--ro-bind', '/', '/']);
  assert.deepEqual(argv.slice(-3), ['/bin/sh', '-c', 'node --test']);
  assert.equal(argv.join(' ').includes('--bind / /'), false, 'the root is never bound writable');
  assert.ok(argv.join(' ').includes('--bind /scratch /scratch'), 'only the scratch directory is writable');
});

it('refuses to run anything when no verified read-only backend exists', async () => {
  const noSandbox = resolveVerifyBackend({ platform: 'darwin', existsSync: () => false });
  assert.equal(noSandbox.ok, false);
  assert.match(String((noSandbox as any).reason), /sandbox-exec/);

  // Linux stays unsupported this round: an installed bwrap binary is not evidence
  // that the shipped flags were ever validated on Linux.
  const noBwrap = resolveVerifyBackend({ platform: 'linux', existsSync: () => false, env: { PATH: '/usr/bin' } });
  assert.equal(noBwrap.ok, false);
  assert.match(String((noBwrap as any).reason), /bubblewrap|bwrap/);

  const withBwrap = resolveVerifyBackend({
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    existsSync: (path) => path === '/usr/bin/bwrap',
  });
  assert.equal(withBwrap.ok, false, 'an installed bwrap must not make Linux a verified backend');
  assert.match(String((withBwrap as any).reason), /not been validated on a Linux host/);
  assert.match(String((withBwrap as any).reason), /bwrap is installed at \/usr\/bin\/bwrap/);

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
    assert.equal(suite.backend, 'sandbox-exec');

    // Each command gets its own scratch directory under the parent's root;
    // the parent directory itself is not writable by the command.
    // fixture.scratch is a /var path while the sandbox resolves it to /private/var
    assert.ok(suite.scratchDir && suite.scratchDir.startsWith(realpathSync(fixture.scratch)), 'scratch lives under the parent root');
    assert.notEqual(suite.scratchDir, fixture.scratch, 'each command gets a private directory');
    assert.equal(existsSync(suite.scratchDir!), false, 'the per-command scratch directory is removed afterwards');

    const outside = join(fixture.root, 'outside.txt');
    const direct = await fixture.run('echo hi > ' + outside);
    assert.notEqual(direct.exitCode, 0, 'a write outside the scratch directory must fail');
    assert.equal(existsSync(outside), false);

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
      const ipc = await fixture.run(
        'node -e "const net=require(\'node:net\');const s=net.connect(process.argv[1]);' +
        "s.on('data',d=>{console.log('IPC-OK:'+d);process.exit(7)});" +
        "s.on('error',e=>console.log('IPC-BLOCKED:'+e.code));\" " + socketPath,
      );
      assert.doesNotMatch(ipc.output, /IPC-OK/);
      assert.notEqual(ipc.exitCode, 7, 'reaching another local process must be blocked');
    } finally {
      server.close();
    }
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
    try { process.kill(-leader, 'SIGKILL'); } catch { /* already gone */ }

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
  // The command reports its own pid inside its own scratch directory ($TMPDIR);
  // it cannot write to the fixture root.
  writeFileSync(childScript, [
    'import { runVerifyCommand } from ' + JSON.stringify(readonlyModule) + ';',
    'const [scratch, cwd] = process.argv.slice(2);',
    "runVerifyCommand({ command: 'echo $$ > $TMPDIR/group.txt; /bin/sleep 120',",
    '  scratchDir: scratch, cwd, timeoutMs: 600_000 }).then(r => console.log("RESULT", r.exitCode));',
    '',
  ].join('\n'));

  // A stand-in for pi: it owns the verify command through ownerPid = its own pid.
  const owner = spawn(process.execPath, ['--experimental-strip-types', childScript, fixture.scratch, fixture.work], {
    cwd: fixture.root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  let pgid = 0;
  const findGroupFile = () => {
    for (const entry of readdirSync(fixture.scratch)) {
      const file = join(fixture.scratch, entry, 'group.txt');
      if (existsSync(file)) return file;
    }
    return null;
  };
  try {
    // Bounded startup wait: a hung probe must fail an assertion, not the test.
    // The command writes one pid, so wait for a non-empty file rather than
    // reading a half-written one.
    let pidText = '';
    const startDeadline = Date.now() + 3_000;
    while (Date.now() < startDeadline) {
      const groupFile = findGroupFile();
      if (groupFile) {
        pidText = readFileSync(groupFile, 'utf8').trim();
        if (pidText) break;
      }
      await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(pidText, 'the verify command must start and report its pid');
    assert.ok(Number(pidText) > 0, 'reported a real pid, got: ' + pidText);
    // Resolve the process group from outside: ps cannot read the process table
    // inside the sandbox, and proc-info is not what this test is about.
    pgid = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', pidText], { encoding: 'utf8' }).trim());
    assert.ok(pgid > 0, 'resolved a real process group, got: ' + String(pgid));
    assert.doesNotThrow(() => process.kill(-pgid, 0), 'the group is alive before the owner dies');

    // Kill the owner outright: no abort, no cleanup path, no chance to signal.
    owner.kill('SIGKILL');
    await new Promise(resolve => owner.once('exit', resolve));

    // The watchdog must notice and kill the whole group. Bounded so a missing
    // watchdog fails an assertion instead of hanging the suite.
    const deathDeadline = Date.now() + 2_500;
    let alive = true;
    while (Date.now() < deathDeadline) {
      try { process.kill(-pgid, 0); } catch { alive = false; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(alive, false, 'the verify process group must die with its owner (pgid ' + pgid + ' still alive)');
  } finally {
    if (pgid > 0) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ } }
    try { owner.kill('SIGKILL'); } catch { /* already gone */ }
    fixture.cleanup();
  }
});

it('leaves no wrapper or watchdog process behind after a normal exit', { skip: skipProbe }, async () => {
  const fixture = scratchFixture();
  try {
    const result = await fixture.run('echo done');
    assert.equal(result.exitCode, 0, result.output);

    // The wrapper and its polling watchdog share this unique scratch path in
    // their argv, so any survivor shows up in ps.
    const survivors = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter(line => line.includes(fixture.scratch))
      .map(line => line.trim());
    assert.deepEqual(survivors, [], 'no wrapper or watchdog may outlive a completed command');
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
    const pid = Number((/BG=(\d+)/.exec(result.output) ?? [])[1]);
    assert.ok(Number.isInteger(pid) && pid > 0, 'the probe must report the background pid, got: ' + JSON.stringify(result.output));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'background pid ' + pid + ' must not survive the call');
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
    // if the link could be created inside the writable directory. Probe result:
    // the sandbox denies link() itself (EPERM), so the link never exists.
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
    const planted = await runVerifyCommand({
      command: 'echo HACKED > $TMPDIR/preexisting',
      scratchDir: fixture.scratch,
      cwd: fixture.work,
      timeoutMs: 30_000,
      // Simulate a pre-planted link by creating it inside the per-command dir
      // the instant it exists, before the shell runs.
      mkdtempSync: (template: string) => {
        const dir = mkdtempSync(template);
        linkSync(target, join(dir, 'preexisting'));
        return dir;
      },
    });
    assert.equal(planted.exitCode, 0, planted.output);
    assert.equal(readFileSync(target, 'utf8'), 'HACKED\n', 'this is the residual path the fresh-empty-directory rule removes');
    assert.equal(existsSync(planted.scratchDir!), false, 'the writable directory does not survive the command');
  } finally {
    fixture.cleanup();
  }
});
it('timeout terminates the whole command process group', { skip: skipProbe }, async () => {
  const fixture = scratchFixture();
  try {
    const result = await fixture.run('sleep 30 & sleep 30', { timeoutMs: 1500 });
    assert.equal(result.timedOut, true);
    assert.ok(result.durationMs < 15_000, 'the timeout must fire promptly, took ' + result.durationMs + 'ms');
    assert.ok(typeof result.pid === 'number' && result.pid > 0);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.throws(() => process.kill(-result.pid as number, 0), /ESRCH/, 'no process in the group may survive');
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
