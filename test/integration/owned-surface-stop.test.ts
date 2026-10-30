import './tmux-isolation.ts';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureSurfaceOwnership, inspectOwnedSurface, shellEscape, stopOwnedSurfaceTree } from '../../pi-extension/subagents/tmux.ts';

const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'real process did not reach the expected state');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-owned-stop-'));
  const name = `pi-owned-stop-${process.pid}-${Date.now()}`;
  const parent = tmux('new-session', '-d', '-s', name, '-x', '160', '-y', '48', '-P', '-F', '#{pane_id}');
  const sibling = tmux('split-window', '-d', '-t', parent, '-P', '-F', '#{pane_id}');
  const child = tmux('new-window', '-d', '-t', name + ':', '-P', '-F', '#{pane_id}');
  const owner = 'test-owned-stop-' + process.pid;
  tmux('set-option', '-p', '-t', child, '@pi_subagent_owner', owner);
  tmux('set-option', '-p', '-t', child, '@pi_subagent_parent', parent);
  t.after(() => {
    try { tmux('kill-session', '-t', name); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, name, parent, sibling, child, owner };
}

it('strict stop verifies real detached tools and delegated panes, preserving parent and siblings', { timeout: 15000 }, async t => {
  const { dir, name, parent, sibling, child, owner } = fixture(t);
  const grandchild = tmux('split-window', '-d', '-t', child, '-P', '-F', '#{pane_id}');
  tmux('set-option', '-p', '-t', grandchild, '@pi_subagent_parent', child);
  tmux('set-option', '-p', '-t', grandchild, '@pi_subagent_owner', owner + '-nested');
  const script = join(dir, 'running.mjs');
  const tool = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(join(dir, 'tool-pid'))}, String(process.pid)); setInterval(() => { if (fs.existsSync(${JSON.stringify(join(dir, 'release'))})) fs.writeFileSync(${JSON.stringify(join(dir, 'escaped'))}, 'escaped'); }, 20);`;
  writeFileSync(script, `import {spawn} from 'node:child_process';
    import {writeFileSync} from 'node:fs';
    spawn(process.execPath, ['-e', ${JSON.stringify(tool)}], {detached:true, stdio:'ignore'});
    writeFileSync(${JSON.stringify(join(dir, 'ready'))}, String(process.pid));
    setInterval(() => {}, 1000);
  `);
  tmux('respawn-pane', '-k', '-t', child, `${shellEscape(process.execPath)} ${shellEscape(script)}; exec sleep 86400`);
  await until(() => existsSync(join(dir, 'tool-pid')) && existsSync(join(dir, 'ready')));
  const ownership = captureSurfaceOwnership(child);
  assert.equal(inspectOwnedSurface(child, ownership).state, 'owned');
  const result = await stopOwnedSurfaceTree(child, ownership);
  assert.equal(result.confirmed, true, result.reason);
  writeFileSync(join(dir, 'release'), 'release');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(existsSync(join(dir, 'escaped')), false, 'detached tool cannot continue after a confirmed stop');
  assert.deepEqual(tmux('list-panes', '-s', '-t', name, '-F', '#{pane_id}').split('\n'), [parent, sibling]);
  assert.equal(inspectOwnedSurface(child, ownership).state, 'absent');
  const repeated = await stopOwnedSurfaceTree(child, ownership);
  assert.equal(repeated.confirmed, false, 'absence alone cannot reconfirm historical descendant cleanup');
  assert.match(repeated.reason, /absent/);
  assert.deepEqual(tmux('list-panes', '-s', '-t', name, '-F', '#{pane_id}').split('\n'), [parent, sibling]);
  const toolPid = readFileSync(join(dir, 'tool-pid'), 'utf8').trim();
  try { assert.match(execFileSync('ps', ['-o', 'stat=', '-p', toolPid], { encoding: 'utf8' }).trim(), /^Z/); }
  catch (error) { if ((error as any).status !== 1) throw error; }
});

it('strict stop refuses a stale owner, pane process or server identity without disturbing parked processes', async t => {
  const { dir, name, parent, sibling, child, owner } = fixture(t);
  const script = join(dir, 'waiting.mjs');
  writeFileSync(script, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(dir, 'waiting'))}, String(process.pid)); process.stdin.resume();`);
  const before = captureSurfaceOwnership(child);
  tmux('respawn-pane', '-k', '-t', child, `exec ${shellEscape(process.execPath)} ${shellEscape(script)}`);
  await until(() => existsSync(join(dir, 'waiting')));
  assert.equal(inspectOwnedSurface(child, before).state, 'stale');
  assert.equal((await stopOwnedSurfaceTree(child, before)).confirmed, false);
  const current = captureSurfaceOwnership(child);
  assert.equal((await stopOwnedSurfaceTree(child, { ...current, serverPid: current.serverPid + 1 })).confirmed, false);
  tmux('set-option', '-p', '-t', child, '@pi_subagent_owner', owner + '-replacement');
  assert.equal(inspectOwnedSurface(child, current).state, 'stale');
  assert.equal((await stopOwnedSurfaceTree(child, current)).confirmed, false);
  assert.deepEqual(tmux('list-panes', '-s', '-t', name, '-F', '#{pane_id}').split('\n'), [parent, sibling, child]);
  process.kill(Number(readFileSync(join(dir, 'waiting'), 'utf8')), 0);
});

it('unavailable tmux evidence stays unknown and never confirms termination', async t => {
  const { child } = fixture(t);
  const ownership = captureSurfaceOwnership(child);
  const saved = process.env.TMUX;
  process.env.TMUX = join(tmpdir(), 'nonexistent-pi-stop-socket') + ',12345,0';
  try {
    assert.equal(inspectOwnedSurface(child, ownership).state, 'unknown');
    const result = await stopOwnedSurfaceTree(child, ownership);
    assert.equal(result.confirmed, false);
    assert.match(result.reason, /could not be independently verified/);
  } finally { process.env.TMUX = saved; }
  assert.equal(inspectOwnedSurface(child, ownership).state, 'owned');
});

it('a retained dead pane cannot prove historical detached descendants terminated', async t => {
  const { child } = fixture(t);
  tmux('set-option', '-p', '-t', child, 'remain-on-exit', 'on');
  tmux('respawn-pane', '-k', '-t', child, 'exit 0');
  await until(() => tmux('display-message', '-p', '-t', child, '#{pane_dead}') === '1');
  const result = await stopOwnedSurfaceTree(child, captureSurfaceOwnership(child));
  assert.equal(result.confirmed, false);
  assert.match(result.reason, /historical descendants cannot be verified/);
});

it('a real detached fork after a process snapshot is reconciled before confirmed cleanup', { timeout: 15000 }, async t => {
  const { dir, child } = fixture(t);
  const script = join(dir, 'forking.mjs');
  const forked = join(dir, 'forked');
  const escaped = join(dir, 'escaped');
  const release = join(dir, 'release');
  const ready = join(dir, 'ready');
  const tool = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(forked)},String(process.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))fs.writeFileSync(${JSON.stringify(escaped)},'escaped')},10)`;
  writeFileSync(script, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
    process.once('SIGUSR1',()=>spawn(process.execPath,['-e',${JSON.stringify(tool)}],{detached:true,stdio:'ignore'}));
    writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`);
  tmux('respawn-pane', '-k', '-t', child, `${shellEscape(process.execPath)} ${shellEscape(script)}; sleep 86400`);
  await until(() => existsSync(ready));
  const ownership = captureSurfaceOwnership(child);
  const target = Number(readFileSync(ready, 'utf8'));
  const realPs = execFileSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).trim();
  const wrapper = join(dir, 'ps');
  const countFile = join(dir, 'snapshots');
  writeFileSync(wrapper, `#!${process.execPath}
    const {spawnSync}=require('node:child_process'),fs=require('node:fs');
    const args=process.argv.slice(2),result=spawnSync(${JSON.stringify(realPs)},args);
    if(args[0]==='-axo'){
      const file=${JSON.stringify(countFile)},n=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8'))+1:1;fs.writeFileSync(file,String(n));
      if(n===2){process.kill(${target},'SIGUSR1');const end=Date.now()+3000;while(!fs.existsSync(${JSON.stringify(forked)})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);if(!fs.existsSync(${JSON.stringify(forked)}))process.exit(74);}
    }process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status ?? 1;`, { mode: 0o700 });
  const saved = process.env.PATH;
  process.env.PATH = dirname(wrapper) + delimiter + saved;
  let result;
  try { result = await stopOwnedSurfaceTree(child, ownership); }
  finally { process.env.PATH = saved; }
  assert.ok(existsSync(forked), 'the process really forked after the second snapshot was taken');
  assert.equal(result.confirmed, true, result.reason);
  writeFileSync(release, 'release');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(existsSync(escaped), false, 'the newly discovered detached process cannot escape a confirmed stop');
});

it('strict stop reconciles padded macOS process titles across global and single-PID evidence', {
  skip: process.platform !== 'darwin', timeout: 15000,
}, async t => {
  const { dir, name, parent, sibling, child } = fixture(t);
  const actorFile = join(dir, 'actor-pid'), toolFile = join(dir, 'tool-pid');
  const release = join(dir, 'release'), escaped = join(dir, 'escaped');
  const script = join(dir, 'process-title.mjs');
  const tool = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(toolFile)},String(process.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))fs.writeFileSync(${JSON.stringify(escaped)},'escaped')},10)`;
  writeFileSync(script, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
    process.title='pi';
    spawn(process.execPath,['-e',${JSON.stringify(tool)}],{detached:true,stdio:'ignore'});
    writeFileSync(${JSON.stringify(actorFile)},String(process.pid));setInterval(()=>{},1000);`);
  tmux('respawn-pane', '-k', '-t', child, `${shellEscape(process.execPath)} ${shellEscape(script)}; sleep 86400`);
  await until(() => existsSync(actorFile) && existsSync(toolFile));
  const actorPid = readFileSync(actorFile, 'utf8').trim(), toolPid = readFileSync(toolFile, 'utf8').trim();
  const realPs = execFileSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).trim();
  t.after(() => {
    // The title actor is attached to our pane and exits with it. A detached
    // tool needs its own cleanup if an assertion fails before strict stop.
    try {
      const command = execFileSync(realPs, ['-p', toolPid, '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (command.includes(dir)) process.kill(Number(toolPid), 'SIGKILL');
    } catch (error) {
      if ((error as any).status !== 1 && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  });
  const options = { encoding: 'utf8' as const, env: { ...process.env, LC_ALL: 'C' } };
  const columns = 'pid=,ppid=,lstart=,stat=,args=';
  const global = execFileSync(realPs, ['-axo', columns], options);
  const single = execFileSync(realPs, ['-p', actorPid, '-o', columns], options);
  const row = global.split('\n').find(line => new RegExp('^\\s*' + actorPid + '\\s').test(line));
  assert.ok(row, 'the real titled process must be present in the global snapshot');
  const command = (line: string) => /^\s*\d+\s+\d+\s+\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+\s+\S+\s+(.*)$/.exec(line)![1];
  const globalCommand = command(row), singleCommand = command(single.trim());
  assert.match(globalCommand, /^pi\b/, 'the actor must use the actual Pi process title');
  assert.match(globalCommand, /[ \t]+$/, 'macOS preserves process-title padding on a middle snapshot row');
  assert.notEqual(globalCommand, singleCommand, 'whole-output trimming changes the same process command representation');
  assert.equal(globalCommand.trimEnd(), singleCommand, 'the discrepancy consists only of trailing presentation padding');

  const result = await stopOwnedSurfaceTree(child, captureSurfaceOwnership(child));
  assert.equal(result.confirmed, true, result.reason);
  for (const pid of [actorPid, toolPid]) {
    try { assert.match(execFileSync(realPs, ['-o', 'stat=', '-p', pid], { encoding: 'utf8' }).trim(), /^Z/); }
    catch (error) { if ((error as any).status !== 1) throw error; }
  }
  writeFileSync(release, 'release');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(existsSync(escaped), false, 'the titled process and its detached tool cannot continue after confirmed stop');
  assert.deepEqual(tmux('list-panes', '-s', '-t', name, '-F', '#{pane_id}').split('\n'), [parent, sibling]);
});

it('a real process disappearing before its macOS identity query does not interrupt the remaining stop', {
  skip: process.platform !== 'darwin', timeout: 15000,
}, async t => {
  const { dir, name, parent, sibling, child } = fixture(t);
  const victimFile = join(dir, 'victim-pid'), toolFile = join(dir, 'tool-pid');
  const release = join(dir, 'release'), escaped = join(dir, 'escaped'), disappeared = join(dir, 'disappeared');
  const script = join(dir, 'disappearing.mjs');
  const victim = `require('node:fs').writeFileSync(${JSON.stringify(victimFile)},String(process.pid));setInterval(()=>{},1000)`;
  const tool = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(toolFile)},String(process.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))fs.writeFileSync(${JSON.stringify(escaped)},'escaped')},10)`;
  writeFileSync(script, `import {spawn} from 'node:child_process';
    spawn(process.execPath,['-e',${JSON.stringify(victim)}],{detached:true,stdio:'ignore'});
    spawn(process.execPath,['-e',${JSON.stringify(tool)}],{detached:true,stdio:'ignore'});
    setInterval(()=>{},1000);`);
  tmux('respawn-pane', '-k', '-t', child, `${shellEscape(process.execPath)} ${shellEscape(script)}; sleep 86400`);
  await until(() => existsSync(victimFile) && existsSync(toolFile));
  const target = Number(readFileSync(victimFile, 'utf8'));
  const toolPid = readFileSync(toolFile, 'utf8').trim();
  const ownership = captureSurfaceOwnership(child);
  const realPs = execFileSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).trim();
  t.after(() => {
    for (const pid of [String(target), toolPid]) {
      try {
        const command = execFileSync(realPs, ['-p', pid, '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        if (command.includes(dir)) process.kill(Number(pid), 'SIGKILL');
      } catch (error) {
        if ((error as any).status !== 1 && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  });
  const wrapper = join(dir, 'ps');
  // Forward actual ps output/status. Only the timing changes: terminate our
  // frozen victim immediately before the production per-PID identity read.
  writeFileSync(wrapper, `#!${process.execPath}
    const {spawnSync}=require('node:child_process'),fs=require('node:fs'),args=process.argv.slice(2);
    if(args[0]==='-p'&&args[1]===${JSON.stringify(String(target))}&&!fs.existsSync(${JSON.stringify(disappeared)})){
      const state=spawnSync(${JSON.stringify(realPs)},['-o','stat=','-p',args[1]],{encoding:'utf8'});
      if(/^[Tt]/.test(state.stdout.trim())){
        process.kill(${target},'SIGKILL');
        const deadline=Date.now()+3000;
        while(Date.now()<deadline){
          const gone=spawnSync(${JSON.stringify(realPs)},['-p',args[1],'-o','pid='],{encoding:'utf8'});
          if(gone.status===1&&!gone.stdout.trim()&&!gone.stderr.trim()){fs.writeFileSync(${JSON.stringify(disappeared)},String(${target}));break;}
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
        }
        if(!fs.existsSync(${JSON.stringify(disappeared)}))process.exit(74);
      }
    }
    const result=spawnSync(${JSON.stringify(realPs)},args);
    process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status ?? 1;`, { mode: 0o700 });
  const saved = process.env.PATH;
  process.env.PATH = dirname(wrapper) + delimiter + saved;
  let result;
  try { result = await stopOwnedSurfaceTree(child, ownership); }
  finally { process.env.PATH = saved; }
  assert.equal(readFileSync(disappeared, 'utf8'), String(target), 'the actual captured process must disappear before its identity query');
  assert.equal(result.confirmed, true, result.reason);
  try { assert.match(execFileSync(realPs, ['-o', 'stat=', '-p', toolPid], { encoding: 'utf8' }).trim(), /^Z/); }
  catch (error) { if ((error as any).status !== 1) throw error; }
  writeFileSync(release, 'release');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(existsSync(escaped), false, 'remaining detached work must still terminate');
  assert.deepEqual(tmux('list-panes', '-s', '-t', name, '-F', '#{pane_id}').split('\n'), [parent, sibling]);
});

it('a process-query failure after freezing restores surviving detached work instead of leaving it stopped', { timeout: 15000 }, async t => {
  const { dir, child } = fixture(t);
  const script = join(dir, 'failure.mjs');
  const ready = join(dir, 'ready');
  const heartbeat = join(dir, 'heartbeat');
  const tool = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>require('node:fs').writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),10)`;
  writeFileSync(script, `import {spawn} from 'node:child_process';spawn(process.execPath,['-e',${JSON.stringify(tool)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000);`);
  tmux('respawn-pane', '-k', '-t', child, `${shellEscape(process.execPath)} ${shellEscape(script)}; sleep 86400`);
  await until(() => existsSync(ready) && existsSync(heartbeat));
  const toolPid = Number(readFileSync(ready, 'utf8'));
  t.after(() => { try { process.kill(toolPid, 'SIGKILL'); } catch {} });
  const ownership = captureSurfaceOwnership(child);
  const realPs = execFileSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).trim();
  const countFile = join(dir, 'snapshots');
  const wrapper = join(dir, 'ps');
  writeFileSync(wrapper, `#!${process.execPath}
    const fs=require('node:fs'),args=process.argv.slice(2);if(args[0]==='-axo'){
      const file=${JSON.stringify(countFile)},n=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8'))+1:1;fs.writeFileSync(file,String(n));if(n===3)process.exit(73);
    }const result=require('node:child_process').spawnSync(${JSON.stringify(realPs)},args);
    process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status ?? 1;`, { mode: 0o700 });
  const saved = process.env.PATH;
  process.env.PATH = dirname(wrapper) + delimiter + saved;
  let result;
  try { result = await stopOwnedSurfaceTree(child, ownership); }
  finally { process.env.PATH = saved; }
  assert.equal(result.confirmed, false);
  assert.equal(readFileSync(countFile, 'utf8'), '3', 'failure was injected after the freeze pass');
  const previous = readFileSync(heartbeat, 'utf8');
  await until(() => readFileSync(heartbeat, 'utf8') !== previous);
  assert.doesNotMatch(execFileSync(realPs, ['-o', 'stat=', '-p', String(toolPid)], { encoding: 'utf8' }).trim(), /^[Tt]/);
});
