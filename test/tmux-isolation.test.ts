/** Exercise hostile config/environment without ever addressing a user server. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedTmux } from './helpers/tmux.ts';
import { shellEscape } from '../pi-extension/subagents/tmux.ts';

let available = true;
try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch { available = false; }
it('test servers ignore hostile config, strip inherited identity, and leave the parent server untouched', { skip: !available, timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mux-isolation-'));
  const guardSocket = join(dir, 'guard.sock'), socket = join(dir, 'owned.sock');
  const guard = isolatedTmux(guardSocket), control = isolatedTmux(join(dir, 'control.sock'));
  const marker = join(dir, 'config-loaded'), childEnvFile = join(dir, 'child-env.json');
  const config = join(dir, '.tmux.conf'), xdg = join(dir, 'config');
  const trap = join(dir, 'config-trap.cjs');
  const owned = isolatedTmux(socket, { HOME: dir, XDG_CONFIG_HOME: xdg,
    TMUX: guardSocket + ',1,0', TMUX_PANE: '%host', TMUX_SOCKET: guardSocket,
    PI_SUBAGENT_TREE: '%host', CODEX_HOME: join(dir, 'codex') });
  t.after(() => {
    for (const mux of [owned, control, guard]) { try { mux('kill-server'); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  });
  guard('new-session', '-d', '-s', 'guard', 'sleep 120');
  guard('set-option', '-g', '@isolation-guard', 'untouched');
  const inherited = { ...process.env, HOME: dir, XDG_CONFIG_HOME: xdg, TMUX_SOCKET: guardSocket };
  writeFileSync(trap,
    "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'loaded');" +
    "require('node:child_process').execFileSync('tmux', ['-f','/dev/null','-S',process.env.TMUX_SOCKET,'set-option','-g','@isolation-guard','touched']);");
  mkdirSync(join(xdg, 'tmux'), { recursive: true });
  const configText = 'run-shell "' + shellEscape(process.execPath) + ' ' + shellEscape(trap) + '"\n';
  writeFileSync(config, configText);
  writeFileSync(join(xdg, 'tmux', 'tmux.conf'), configText);
  // Positive control: the test config really can model a plugin touching the
  // inherited parent socket. Every socket in this test belongs to this test.
  execFileSync('tmux', ['-f', config, '-S', join(dir, 'control.sock'), 'new-session', '-d', '-s', 'control', 'sleep 120'], { env: inherited });
  assert.equal(readFileSync(marker, 'utf8'), 'loaded');
  assert.equal(guard('show-option', '-gv', '@isolation-guard'), 'touched');
  guard('set-option', '-g', '@isolation-guard', 'untouched');
  rmSync(marker);
  owned('new-session', '-d', '-s', 'owned', 'sleep 120');
  assert.equal(existsSync(marker), false, 'personal config must not run');
  assert.equal(guard('show-option', '-gv', '@isolation-guard'), 'untouched');
  const environment = owned('show-environment', '-g');
  assert.doesNotMatch(environment, /^(TMUX|TMUX_PANE|TMUX_SOCKET|PI_SUBAGENT_TREE)=/m);
  const dump = "require('node:fs').writeFileSync(" + JSON.stringify(childEnvFile) + ", JSON.stringify(process.env))";
  owned('new-window', '-d', '-t', 'owned', shellEscape(process.execPath) + ' -e ' + shellEscape(dump) + '; sleep 120');
  const deadline = Date.now() + 5000;
  while (!existsSync(childEnvFile)) {
    assert.ok(Date.now() < deadline, 'owned child must start');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const child = JSON.parse(readFileSync(childEnvFile, 'utf8'));
  assert.ok(child.TMUX.startsWith(socket + ','), child.TMUX);
  assert.equal(child.TMUX_SOCKET, undefined);
  assert.equal(child.PI_SUBAGENT_TREE, undefined);
  assert.equal(child.CODEX_HOME, join(dir, 'codex'));
  // The ordinary integration bootstrap must provide the same isolation even
  // when the test is invoked directly and its caller is already inside tmux.
  const probe = join(dir, 'probe.test.mjs'), report = join(dir, 'probe.json');
  writeFileSync(probe, "import " + JSON.stringify(new URL('./integration/tmux-isolation.ts', import.meta.url).href) + ";" +
    "import {it} from 'node:test'; import {execFileSync} from 'node:child_process'; import {writeFileSync} from 'node:fs';" +
    "it('private root',()=>{const path=execFileSync('tmux',['display-message','-p','#{socket_path}'],{encoding:'utf8'}).trim();" +
    "if(path!==process.env.TMUX_SOCKET) throw new Error('wrong socket');" +
    "writeFileSync(" + JSON.stringify(report) + ",JSON.stringify({path,pane:process.env.TMUX_PANE}));});");
  const probeEnv: NodeJS.ProcessEnv = { ...inherited, TMUX: guardSocket + ',1,0', TMUX_PANE: '%host', PI_SUBAGENT_TREE: '%host' };
  delete probeEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', probe], { env: probeEnv, encoding: 'utf8', timeout: 8000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(report), result.stdout + result.stderr);
  const isolated = JSON.parse(readFileSync(report, 'utf8'));
  assert.notEqual(isolated.path, guardSocket);
  assert.notEqual(isolated.pane, '%host');
  assert.throws(() => isolatedTmux(isolated.path)('list-sessions'), 'the bootstrap must remove its server after tests');
  assert.equal(guard('show-option', '-gv', '@isolation-guard'), 'untouched');
  assert.equal(existsSync(marker), false);
  rmSync(report);
  writeFileSync(probe, readFileSync(probe, 'utf8') + "setInterval(()=>{},1000); it('hold',()=>new Promise(()=>{}));");
  const interrupted = spawn(process.execPath, [probe], { env: probeEnv, stdio: 'ignore' });
  const exited = new Promise(resolve => interrupted.once('close', resolve));
  t.after(async () => { interrupted.kill('SIGTERM'); await exited; });
  const signalDeadline = Date.now() + 5000;
  while (!existsSync(report)) {
    assert.ok(Date.now() < signalDeadline, 'interrupted test must start its private server');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const held = JSON.parse(readFileSync(report, 'utf8'));
  assert.ok(isolatedTmux(held.path)('list-sessions'));
  interrupted.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.throws(() => isolatedTmux(held.path)('list-sessions'));
  assert.equal(guard('show-option', '-gv', '@isolation-guard'), 'untouched');
});
