import './tmux-isolation.ts';
/** Actual parent SIGKILL, OS pipe EOF and independent tmux resource ownership. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { shellEscape } from '../../pi-extension/subagents/tmux.ts';

it('closing an owned pane kills detached timeout descendants before they can write again', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-detached-tool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  const session = 'pi-detached-tool-' + process.pid;
  const root = tmux('new-session', '-d', '-s', session, '-P', '-F', '#{pane_id}');
  t.after(() => { try { tmux('kill-session', '-t', session); } catch {} });
  // Mentioning the helper in ordinary tool arguments must not exempt the tool.
  const guardian = fileURLToPath(new URL('../../pi-extension/subagents/surface-guardian.ts', import.meta.url));
  const command = `echo $$ > ${shellEscape(join(dir, 'pid'))}; while ! test -f ${shellEscape(join(dir, 'release'))}; do sleep 0.05; done; echo escaped > ${shellEscape(join(dir, 'escaped'))} # ${guardian}`;
  const source = `import {spawn} from 'node:child_process'; spawn('timeout',['240','sh','-c',${JSON.stringify(command)}],{detached:true,stdio:'ignore'}); setInterval(()=>{},1000);`;
  tmux('respawn-pane', '-k', '-t', root, `${shellEscape(process.execPath)} --input-type=module -e ${shellEscape(source)}`);
  const deadline = Date.now() + 5000;
  while (!existsSync(join(dir, 'pid'))) {
    assert.ok(Date.now() < deadline, 'detached timeout must actually run');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const pid = Number(readFileSync(join(dir, 'pid'), 'utf8').trim());
  const { closeSurfaceTree } = await import('../../pi-extension/subagents/tmux.ts');
  const oldTmux = process.env.TMUX;
  process.env.TMUX = tmux('display-message', '-p', '-t', root, '#{socket_path},#{pid},0');
  try { closeSurfaceTree(root); } finally {
    if (oldTmux === undefined) delete process.env.TMUX; else process.env.TMUX = oldTmux;
  }
  writeFileSync(join(dir, 'release'), 'release');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(existsSync(join(dir, 'escaped')), false, 'pane disappearance is not proof that its tool stopped');
  try {
    assert.match(execFileSync('ps', ['-o','stat=','-p',String(pid)], { encoding: 'utf8' }).trim(), /^Z/, 'the detached shell must be dead');
  } catch (error) {
    if ((error as any).status !== 1) throw error;
  }
});

for (const ready of [true, false]) {
it('SIGKILL reaps only the dead parent panes and verification scratch: guardian ' + (ready ? 'ready' : 'starting'), { timeout: 20000 }, async t => {
  const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  const session = 'pi-owner-kill-' + process.pid;
  const root = tmux('new-session', '-d', '-s', session, '-x', '160', '-y', '48', '-P', '-F', '#{pane_id}');
  t.after(() => { try { tmux('kill-session', '-t', session); } catch {} });
  const sibling = tmux('split-window', '-d', '-t', root, '-P', '-F', '#{pane_id}');
  const module = (name: string) => new URL('../../pi-extension/subagents/' + name, import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createSurface,sendCommand} from ${JSON.stringify(module('tmux.ts'))};
    import {waitForSurfaceOwner,surfaceOwnerDirectory} from ${JSON.stringify(module('surface-owner.ts'))};
    import {createVerifyScratch} from ${JSON.stringify(module('workflow/readonly.ts'))};
    const pane=createSurface('owned');
    ${ready ? 'await waitForSurfaceOwner();' : ''}
    const scratch=createVerifyScratch(surfaceOwnerDirectory());
    sendCommand(pane,'sleep 240');
    console.log(JSON.stringify({pane,scratch}));
    setInterval(()=>{},1000);
  `], { env: { ...process.env, TMUX: tmux('display-message','-p','-t',root,'#{socket_path},#{pid},0'), TMUX_PANE: root, PI_SUBAGENT_TREE: root }, stdio: ['ignore','pipe','pipe'] });
  const closed = once(child, 'close');
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  const [output] = await once(child.stdout, 'data');
  const owned = JSON.parse(String(output));
  t.after(() => rmSync(dirname(owned.scratch), { recursive: true, force: true }));
  assert.ok(existsSync(owned.scratch));
  child.kill('SIGKILL'); await closed;
  const panes = () => tmux('list-panes','-s','-t',session,'-F','#{pane_id}').split('\n');
  const deadline = Date.now() + 5000;
  while (panes().includes(owned.pane) || existsSync(owned.scratch)) {
    assert.ok(Date.now() < deadline, 'guardian must close the owned pane and remove its scratch without parent hooks');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(panes().includes(root));
  assert.ok(panes().includes(sibling), 'unrelated live panes must survive');
});
}
