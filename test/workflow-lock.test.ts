import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, script } from './helpers/workflow.ts';
import { acquireLock, releaseLock } from '../pi-extension/subagents/workflow/journal.ts';

const journalModule = new URL('../pi-extension/subagents/workflow/journal.ts', import.meta.url).href;
function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-run-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

it('exactly one process reclaims a dead run owner under synchronized contention', { timeout: 15000 }, async t => {
  const dir = directory(t);
  const lock = join(dir, 'lock');
  const go = join(dir, 'go');
  const dead = spawnSync(process.execPath, ['-e', '']);
  assert.equal(dead.status, 0);
  writeFileSync(lock, JSON.stringify({ pid: dead.pid }));
  const children: ReturnType<typeof spawn>[] = [];
  const closed: Promise<unknown>[] = [];
  t.after(async () => {
    for (const child of children) child.kill('SIGKILL');
    await Promise.all(closed);
  });
  const ready = new Set<number>();
  const results: any[] = [];
  await new Promise<void>((resolve, reject) => {
    for (let index = 0; index < 4; index++) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const read = fs.readFileSync;
        let paused = false;
        fs.readFileSync = (path, ...args) => {
          const value = read(path, ...args);
          if (path === ${JSON.stringify(lock)} && !paused) {
            paused = true;
            process.send({ kind: 'ready' });
            const timeout = Date.now() + 10000;
            while (!fs.existsSync(${JSON.stringify(go)})) {
              if (Date.now() > timeout) throw new Error('contention barrier timed out');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
            }
          }
          return value;
        };
        syncBuiltinESMExports();
        const { acquireLock } = await import(${JSON.stringify(journalModule)});
        const result = acquireLock(${JSON.stringify(dir)});
        process.send({ kind: 'result', result });
        setInterval(() => {}, 1000);
      `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child);
      closed.push(once(child, 'close'));
      let stderr = '';
      child.stderr!.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', () => reject(new Error('contender exited before cleanup: ' + stderr)));
      child.on('message', (message: any) => {
        ready.add(index);
        if (ready.size === 4) writeFileSync(go, 'release captured owner reads');
        if (message.kind === 'result') results.push({ ...message.result, pid: child.pid });
        if (results.length === 4) resolve();
      });
    }
  });
  const winners = results.filter(result => result.ok);
  assert.equal(winners.length, 1, 'stale lock replacement must not overwrite another successful rescuer');
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, winners[0].pid);
});

it('release cannot delete a replacement owner token', t => {
  const dir = directory(t);
  const lock = acquireLock(dir);
  assert.ok(lock.ok);
  writeFileSync(lock.path, JSON.stringify({ pid: process.pid, token: 'replacement-owner' }));
  releaseLock(lock.path);
  assert.ok(existsSync(lock.path), 'an obsolete cleanup must not remove another owner');
});

it('abandoned recovery guards fail closed without modifying the run lock', t => {
  const dir = directory(t);
  const path = join(dir, 'lock');
  writeFileSync(path, '{}');
  utimesSync(path, new Date(0), new Date(0));
  mkdirSync(path + '.reclaim');
  const result = acquireLock(dir);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason!, /manual inspection/);
  assert.equal(readFileSync(path, 'utf8'), '{}');
});

it('unknown lock owners are never stolen based only on age', t => {
  const dir = directory(t);
  const path = join(dir, 'lock');
  writeFileSync(path, '{');
  assert.equal(acquireLock(dir).ok, false);
  utimesSync(path, new Date(0), new Date(0));
  const result = acquireLock(dir);
  assert.equal(result.ok, false, 'a paused live writer can still own an old, not-yet-readable lock');
  if (!result.ok) assert.match(result.reason!, /manual inspection/);
  assert.equal(readFileSync(path, 'utf8'), '{');
});

it('resume reads snapshot and script only after acquiring ownership', t => {
  const dir = directory(t);
  const helper = new URL('./helpers/workflow.ts', import.meta.url).href;
  const program = join(dir, 'resume-race.mjs');
  writeFileSync(program, `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { fixture, script } from ${JSON.stringify(helper)};
    const cleanups = [];
    const f = fixture({ after(fn) { cleanups.push(fn); } }, () => ({text:'unused'}), { baseDir: ${JSON.stringify(dir)} });
    try {
      const run = await f.manager.start({source:script("return {seen:'stale-script'};"),args:{version:'stale'}});
      await run.execute();
      const open = fs.openSync;
      let injected = false;
      fs.openSync = (path, flags, ...rest) => {
        if (path === join(run.runDir, 'lock') && flags === 'wx' && !injected) {
          injected = true;
          const path = join(run.runDir, 'snapshot.json');
          const snapshot = JSON.parse(fs.readFileSync(path, 'utf8'));
          snapshot.args = {version:'latest'};
          fs.writeFileSync(path, JSON.stringify(snapshot));
          fs.writeFileSync(join(run.runDir, 'script.js'), script('return {seen:args.version};'));
        }
        return open(path, flags, ...rest);
      };
      syncBuiltinESMExports();
      const view = await (await f.reload().resume(run.runId)).execute();
      assert.ok(injected);
      assert.equal(view.status, 'completed', view.error);
      assert.deepEqual(view.result, {seen:'latest'});
    } finally { for (const cleanup of cleanups.reverse()) cleanup(); }
  `);
  const child = spawnSync(process.execPath, [program], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
});

it('an unreadable journal refuses resume and releases ownership for a repaired retry', async t => {
  const f = fixture(t, () => ({text:'completed-once'}));
  const run = await f.manager.start({source:script("return await agent('side effect');"),args:{}});
  const initial = await run.execute();
  assert.equal(initial.status, 'completed', initial.error);
  const path = join(initial.runDir, 'journal.jsonl');
  renameSync(path, path + '.saved');
  mkdirSync(path);
  await assert.rejects(f.reload().resume(run.runId), /EISDIR|directory/);
  assert.equal(existsSync(join(initial.runDir, 'lock')), false);
  rmdirSync(path);
  renameSync(path + '.saved', path);
  const recovered = await (await f.reload().resume(run.runId)).execute();
  assert.equal(recovered.status, 'completed', recovered.error);
  assert.equal(recovered.result, initial.result);
  assert.equal(f.calls.length, 1, 'IO failure must not become an empty replay cache');
});

for (const fault of ['script-write', 'lock-refused', 'lock-write']) {
  it('start refuses partial initialization and cleans its owned lock: ' + fault, t => {
    const dir = directory(t);
    const program = join(dir, 'start-fault.mjs');
    const helper = new URL('./helpers/workflow.ts', import.meta.url).href;
    writeFileSync(program, `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      import { dirname, join } from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      import { fixture, script } from ${JSON.stringify(helper)};
      const cleanups = [];
      const f = fixture({after(fn){cleanups.push(fn);}}, () => ({text:'unused'}), {baseDir:${JSON.stringify(dir)}});
      const originalWrite = fs.writeFileSync, originalOpen = fs.openSync;
      let runDir, lockFd;
      fs.writeFileSync = (path, ...rest) => {
        if (${JSON.stringify(fault)} === 'lock-write' && typeof path === 'number') throw new Error('injected lock write failure');
        if (${JSON.stringify(fault)} === 'script-write' && typeof path === 'string' && path.endsWith('/script.js')) {
          runDir = dirname(path);
          throw new Error('injected script write failure');
        }
        return originalWrite(path, ...rest);
      };
      fs.openSync = (path, flags, ...rest) => {
        if (${JSON.stringify(fault)} === 'lock-refused' && typeof path === 'string' && path.endsWith('/lock') && flags === 'wx' && !runDir) {
          runDir = dirname(path);
          originalWrite(path, JSON.stringify({pid:process.pid,token:'foreign-live-owner'}));
        }
        const fd = originalOpen(path, flags, ...rest);
        if (typeof path === 'string' && path.endsWith('/lock') && flags === 'wx') { runDir = dirname(path); lockFd = fd; }
        return fd;
      };
      syncBuiltinESMExports();
      try {
        await assert.rejects(f.manager.start({source:script('return 1;'),args:{}}), /injected (script|lock) write failure|execution lock/);
        assert.ok(runDir, 'the intended initialization boundary was reached');
        const lock = join(runDir, 'lock');
        if (${JSON.stringify(fault)} !== 'lock-refused') assert.equal(fs.existsSync(lock), false, 'failed start cannot strand its live-PID lock');
        else assert.equal(JSON.parse(fs.readFileSync(lock,'utf8')).token,'foreign-live-owner');
        if (${JSON.stringify(fault)} === 'lock-write') assert.throws(() => fs.fstatSync(lockFd), /EBADF/);
        assert.equal(f.calls.length,0);
      } finally { for (const cleanup of cleanups.reverse()) cleanup(); }
    `);
    const child = spawnSync(process.execPath, [program], {encoding:'utf8',timeout:10000});
    assert.equal(child.status, 0, child.stderr || child.error?.message);
  });
}

it('Skip still cancels a running agent when the journal cannot be appended', {timeout:5000}, async t => {
  const f = fixture(t, () => new Promise(() => {}));
  const run = await f.manager.start({source:script("return await agent('blocked');"),args:{}});
  const execution = run.execute();
  await f.waitForCall(() => true);
  while (!run.view().calls[0]?.sessionFile) await new Promise(resolve => setImmediate(resolve));
  mkdirSync(join(run.runDir, 'journal.jsonl'));
  const call = run.view().calls[0];
  assert.doesNotThrow(() => assert.equal(run.skip(call.callKey), true), 'an audit IO error must not prevent cancellation');
  const view = await execution;
  assert.equal(view.status, 'completed', view.error);
  assert.equal(view.result, null);
  assert.equal(view.calls[0].status, 'skipped');
  assert.deepEqual(f.stopped, [call.name]);
  assert.ok(view.logs.some(message => message.includes('could not persist Skip')));
  assert.equal(existsSync(join(run.runDir, 'lock')), false);
});

for (const first of ['failure', 'abort']) {
  it('the first terminal decision wins before VM settlement: ' + first, async t => {
    const notifications: Array<{status:string;error?:string}> = [];
    const f = fixture(t, () => ({text:'billed',tokens:1}), {budgetTotal:1,onSettled:view => notifications.push(view)});
    const run = await f.manager.start({source:script('return 42;'),args:{}});
    const bridge = (id: number) => run.dispatch({id,target:'global',name:'__wfBridgeAgent',args:['charge-' + id]}, () => {});
    await bridge(1);
    const admission = bridge(2); // Its real budget rejection is still crossing the async dispatcher.
    if (first === 'abort') run.abort('first explicit Abort');
    await admission;
    assert.equal(run.isFinished(), false, 'exercise the terminal-before-worker-settlement window');
    if (first === 'failure') run.abort('late obsolete Abort');
    const expected = first === 'failure' ? 'failed' : 'aborted';
    const error = first === 'failure' ? /budget exhausted/ : /first explicit Abort/;
    assert.equal(run.view().status, expected);
    assert.match(run.view().error!, error);
    assert.equal(f.manager.abort(run.runId, 'stale action'), false, 'the public action must reject an already-terminal run');
    const callCount = run.view().calls.length;
    await bridge(3);
    assert.equal(run.view().calls.length, callCount, 'host messages delivered after cancellation cannot admit new queued work');
    const beforeFinish = f.reload().inspect(run.runId)!;
    assert.equal(beforeFinish.status, expected, 'persisted and live terminal decisions agree immediately');
    assert.match(beforeFinish.error!, error);
    const settled = await run.execute();
    assert.equal(settled.status, expected);
    assert.equal(f.calls.length, 1, 'late admission failure must not launch more agents');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].status, expected);
    assert.match(notifications[0].error!, error);
    assert.equal(f.reload().inspect(run.runId)!.status, expected);
  });
}
