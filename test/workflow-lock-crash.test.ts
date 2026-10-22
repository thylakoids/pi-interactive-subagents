import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock } from '../pi-extension/subagents/workflow/journal.ts';
import { RUN_LOCK_HELPER } from '../pi-extension/subagents/workflow/run-lock.ts';

const moduleUrl = new URL('../pi-extension/subagents/workflow/journal.ts', import.meta.url).href;
function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-lock-crash-'));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  return dir;
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'crash boundary was not reached');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const boundary of ['before-flush', 'after-flush', 'after-publish', 'after-release']) {
  it('a killed lock helper recovers without manual deletion: ' + boundary, {timeout:15000}, async t => {
    const dir = directory(t);
    const ready = join(dir, 'ready');
    const pause = `open(${JSON.stringify(ready)}, 'w').write(str(os.getpid()))\n            import signal; signal.pause()`;
    const program = join(dir, 'owner.mjs');
    writeFileSync(program, `
      import cp from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      const original = cp.spawnSync;
      let injected = false;
      cp.spawnSync = (cmd, args, ...rest) => {
        const release = ${JSON.stringify(boundary)} === 'after-release';
        if (cmd === 'python3' && args[3] === (release ? 'release' : 'acquire') && !injected) {
          injected = true;
          args = [...args];
          if (${JSON.stringify(boundary)} === 'before-flush') args[1] = args[1].replace('os.fsync(stream.fileno())', ${JSON.stringify(pause + '\n            os.fsync(stream.fileno())')});
          if (${JSON.stringify(boundary)} === 'after-flush') args[1] = args[1].replace('os.fsync(stream.fileno())', ${JSON.stringify('os.fsync(stream.fileno())\n            ' + pause)});
          if (${JSON.stringify(boundary)} === 'after-publish') args[1] = args[1].replace('return dict(ok=True, path=path, reclaimedResourceOwner=reclaimed_resource_owner)', ${JSON.stringify(pause.replaceAll('\n            ', '\n        ') + '\n        return dict(ok=True, path=path)')});
          if (release) args[1] = args[1].replace('os.unlink(path)', ${JSON.stringify('os.unlink(path)\n            ' + pause)});
        }
        return original(cmd, args, ...rest);
      };
      syncBuiltinESMExports();
      const {acquireLock, releaseLock} = await import(${JSON.stringify(moduleUrl)});
      try {
        const result = acquireLock(${JSON.stringify(dir)});
        if (!result.ok) throw new Error('unexpected lock refusal');
        releaseLock(result.path);
        process.send({ok:true});
      } catch(error) { process.send({error:error.message}); }
    `);
    const child = spawn(process.execPath, [program], {stdio:['ignore','ignore','pipe','ipc']});
    const closed = once(child, 'close');
    let helperPid: number | undefined;
    t.after(async () => {
      child.kill('SIGKILL');
      if (helperPid) { try { process.kill(helperPid, 'SIGKILL'); } catch {} }
      await closed;
    });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const message = once(child, 'message');
    await until(() => existsSync(ready));
    helperPid = Number(readFileSync(ready, 'utf8'));
    const guardInode = statSync(join(dir, 'lock.guard')).ino;
    assert.match(readlinkSync(join(dir, 'lock.reclaim')), /kernel-guard/);
    assert.throws(() => mkdirSync(join(dir, 'lock.reclaim')), /EEXIST/, 'old-version recovery must also see a competing transaction');
    const contender = acquireLock(dir);
    assert.equal(contender.ok, false, 'even an unpublished/removed record cannot bypass an active kernel transaction');
    if (!contender.ok) assert.match(contender.reason!, /transaction is active/);
    if (boundary === 'before-flush' || boundary === 'after-flush') {
      assert.equal(existsSync(join(dir, 'lock')), false, 'partial owner records must not become public');
    }
    process.kill(helperPid, 'SIGKILL');
    helperPid = undefined;
    const [result] = await message as any[];
    await closed;
    if (boundary === 'after-release') assert.equal(result.ok, true, stderr);
    else assert.match(result.error, /lock transaction failed/);
    assert.equal(existsSync(join(dir, 'lock')), false, 'lost acknowledgements must not strand live-parent ownership');
    assert.equal(readdirSync(dir).some(name => name.startsWith('.lock-owner-')), false);
    const recovered = acquireLock(dir);
    assert.ok(recovered.ok, 'the crashed transaction and its gate must recover without manual deletion');
    assert.ok(existsSync(join(dir, 'lock.guard')), 'the kernel guard must never be unlinked');
    assert.equal(statSync(join(dir, 'lock.guard')).ino, guardInode, 'all transactions must keep using the same kernel mutex inode');
    releaseLock(recovered.path);
  });
}

it('a stopped live owner is never stolen, and SIGKILL then permits automatic recovery', {timeout:15000}, async t => {
  const dir = directory(t);
  const child = spawn(process.execPath, ['--input-type=module','-e', `
    const {acquireLock} = await import(${JSON.stringify(moduleUrl)});
    process.send(acquireLock(${JSON.stringify(dir)}));
    setInterval(() => {},1000);
  `], {stdio:['ignore','ignore','pipe','ipc']});
  const closed = once(child, 'close');
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  const [owner] = await once(child, 'message') as any[];
  assert.ok(owner.ok);
  child.kill('SIGSTOP');
  utimesSync(join(dir,'lock'),new Date(0),new Date(0));
  const contender = acquireLock(dir);
  assert.equal(contender.ok, false, 'mtime is not evidence of process death');
  if (!contender.ok) assert.equal(contender.ownerPid,child.pid);
  child.kill('SIGKILL');
  await closed;
  const recovered = acquireLock(dir);
  assert.ok(recovered.ok);
  assert.notEqual(JSON.parse(readFileSync(recovered.path,'utf8')).pid,child.pid);
  releaseLock(recovered.path);
});

it('a killed transaction holder leaves only automatically recoverable artifacts', {timeout:15000}, async t => {
  const dir = directory(t);
  const ready = join(dir,'ready');
  // This helper has no logical owner record yet; kill its actual OS process,
  // leaving both a partially written private record and the compatibility gate.
  const code = RUN_LOCK_HELPER.replace('os.fsync(stream.fileno())', `open(${JSON.stringify(ready)},'w').write('ready')\n            import signal; signal.pause()`);
  const child = spawn('python3',['-c',code,dir,'acquire',String(process.pid),'interrupted'],{stdio:'ignore'});
  const closed = once(child,'close');
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  await until(() => existsSync(ready));
  assert.equal(acquireLock(dir).ok,false);
  child.kill('SIGKILL');
  await closed;
  const result = acquireLock(dir);
  assert.ok(result.ok);
  assert.equal(readdirSync(dir).some(name => name.startsWith('.lock-owner-')),false);
  releaseLock(result.path);
});

it('an unavailable lock backend fails closed instead of publishing an unsafe fallback', t => {
  const dir = directory(t);
  const program = `const {acquireLock} = await import(${JSON.stringify(moduleUrl)}); acquireLock(${JSON.stringify(dir)});`;
  const child = spawnSync(process.execPath,['--input-type=module','-e',program],{env:{...process.env,PATH:dir},encoding:'utf8'});
  assert.notEqual(child.status,0);
  assert.match(child.stderr,/Python 3 with fcntl is required/);
  assert.equal(existsSync(join(dir,'lock')),false);
});

it('a foreign-host record cannot be reclaimed using a local dead PID', t => {
  const dir = directory(t);
  const dead = spawnSync(process.execPath,['-e','']);
  assert.equal(dead.status,0);
  const data = JSON.stringify({pid:dead.pid,token:'remote',host:'different-host.invalid'});
  writeFileSync(join(dir,'lock'),data);
  const result = acquireLock(dir);
  assert.equal(result.ok,false);
  if (!result.ok) assert.match(result.reason!,/another host/);
  assert.equal(readFileSync(join(dir,'lock'),'utf8'),data);
});

it('release IO failure preserves the token and recovers after storage repair', {skip:process.getuid?.() === 0}, t => {
  const dir = directory(t);
  const owned = acquireLock(dir);
  assert.ok(owned.ok);
  chmodSync(dir,0o500);
  try {
    assert.equal(releaseLock(owned.path),false);
    assert.ok(existsSync(owned.path));
  } finally { chmodSync(dir,0o700); }
  const next = acquireLock(dir);
  assert.ok(next.ok,'same-process retry must release the known completed owner after IO repair');
  releaseLock(next.path);
});

it('kernel identity proves a reused PID is not the original owner', {timeout:15000}, async t => {
  const dir = directory(t);
  const child = spawn(process.execPath,['--input-type=module','-e',`
    const {acquireLock} = await import(${JSON.stringify(moduleUrl)});
    process.send(acquireLock(${JSON.stringify(dir)}));
    setInterval(() => {},1000);
  `],{stdio:['ignore','ignore','pipe','ipc']});
  const closed = once(child,'close');
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  const [owned] = await once(child,'message') as any[];
  assert.ok(owned.ok);
  const previous = JSON.parse(readFileSync(owned.path,'utf8'));
  assert.equal(previous.identity?.kind,process.platform === 'darwin' ? 'darwin' : 'linux','actual kernel start identity is required; a silent PID-only fallback does not pass');
  assert.ok(previous.identity.boot && previous.identity.namespace && previous.identity.start);
  child.kill('SIGKILL');
  await closed;
  // Preserve the dead owner's real kernel birth identity but simulate its PID
  // being assigned to this still-live, different process instance.
  writeFileSync(owned.path,JSON.stringify({...previous,pid:process.pid}));
  const recovered = acquireLock(dir);
  assert.ok(recovered.ok,'a live reused PID must not strand a provably dead incarnation');
  const current = JSON.parse(readFileSync(recovered.path,'utf8'));
  assert.notEqual(current.identity.start,previous.identity.start);
  releaseLock(recovered.path);
});

it('a different PID namespace is not inferred dead even when its PID is absent locally', t => {
  const dir = directory(t);
  const owned = acquireLock(dir);
  assert.ok(owned.ok);
  const original = JSON.parse(readFileSync(owned.path,'utf8'));
  assert.ok(original.identity);
  assert.equal(releaseLock(owned.path),true);
  const dead = spawnSync(process.execPath,['-e','']);
  assert.equal(dead.status,0);
  writeFileSync(owned.path,JSON.stringify({...original,pid:dead.pid,identity:{...original.identity,namespace:'another-pid-namespace'}}));
  const result = acquireLock(dir);
  assert.equal(result.ok,false,'a local ESRCH says nothing about a process in another PID namespace');
  if (!result.ok) assert.match(result.reason!,/another PID namespace/);
});

it('identity inspection failure does not steal a known owner', t => {
  const dir = directory(t);
  const owned = acquireLock(dir);
  assert.ok(owned.ok);
  const before = readFileSync(owned.path,'utf8');
  const code = RUN_LOCK_HELPER.replace("if sys.platform == 'linux':", "if True: return None\n        if sys.platform == 'linux':");
  const child = spawnSync('python3',['-c',code,dir,'acquire',String(process.pid),'no-identity'],{encoding:'utf8'});
  assert.notEqual(child.status,0);
  assert.match(child.stderr,/cannot inspect.*identity/);
  assert.equal(readFileSync(owned.path,'utf8'),before);
  releaseLock(owned.path);
});

it('an unavailable birth-identity backend never publishes a PID-only lock', t => {
  const dir = directory(t);
  const code = RUN_LOCK_HELPER.replace("if sys.platform == 'linux':", "if True: return None\n        if sys.platform == 'linux':");
  const result = spawnSync('python3',['-c',code,dir,'acquire',String(process.pid),'identity-missing'],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/refusing PID-only ownership/);
  assert.equal(existsSync(join(dir,'lock')),false);
});

it('an identity-less legacy record cannot be reaped using namespace-blind PID liveness', t => {
  const dir = directory(t);
  const dead = spawnSync(process.execPath,['-e','']);
  assert.equal(dead.status,0);
  const data = JSON.stringify({pid:dead.pid,token:'legacy'});
  writeFileSync(join(dir,'lock'),data);
  const result = acquireLock(dir);
  assert.equal(result.ok,false,'a locally absent PID cannot prove an unknown-scope legacy owner died');
  if (!result.ok) assert.match(result.reason!,/legacy.*identity.*manual inspection/);
  assert.equal(readFileSync(join(dir,'lock'),'utf8'),data);
});
