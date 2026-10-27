/** Real tmux/OS checks for the async cleanup and native liveness paths. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeSurfaceTreeAsync, pollForExit, shellEscape } from '../../pi-extension/subagents/tmux.ts';

const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for real process state');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function session(t: any) {
  const name = `pi-tmux-async-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const root = tmux('new-session', '-d', '-s', name, '-x', '160', '-y', '48', '-P', '-F', '#{pane_id}');
  const saved = process.env.TMUX;
  process.env.TMUX = tmux('display-message', '-p', '-t', root, '#{socket_path},#{pid},0');
  t.after(() => {
    try { tmux('kill-session', '-t', name); } catch {}
    if (saved === undefined) delete process.env.TMUX; else process.env.TMUX = saved;
  });
  return { root, name };
}

it('async cleanup kills detached tools across overflow panes while the guardian cleans scratch and a foreign pane survives', { timeout: 15000 }, async t => {
  const { root, name } = session(t);
  const dir = mkdtempSync(join(tmpdir(), 'pi-tmux-async-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const foreign = tmux('split-window', '-d', '-t', root, '-P', '-F', '#{pane_id}');
  const child = tmux('new-window', '-d', '-t', name + ':', '-P', '-F', '#{pane_id}');
  const grandchild = tmux('split-window', '-d', '-t', child, '-P', '-F', '#{pane_id}');
  tmux('set-option', '-p', '-t', child, '@pi_subagent_parent', root);
  tmux('set-option', '-p', '-t', grandchild, '@pi_subagent_parent', child);
  const tool = `echo $$ > ${shellEscape(join(dir, 'tool-pid'))}; while ! test -f ${shellEscape(join(dir, 'release'))}; do sleep 0.05; done; echo orphan > ${shellEscape(join(dir, 'orphan'))}`;
  const script = join(dir, 'pane.ts');
  writeFileSync(script, `
    import { spawn } from 'node:child_process';
    import { writeFileSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    import { surfaceOwnerDirectory, waitForSurfaceOwner } from ${JSON.stringify(new URL('../../pi-extension/subagents/surface-owner.ts', import.meta.url).href)};
    const directory = surfaceOwnerDirectory();
    writeFileSync(join(directory, 'scratch'), 'owned');
    await waitForSurfaceOwner();
    spawn('timeout', ['240', 'sh', '-c', ${JSON.stringify(tool)}], { detached: true, stdio: 'ignore' });
    while (!existsSync(${JSON.stringify(join(dir, 'tool-pid'))})) await new Promise(resolve => setTimeout(resolve, 10));
    writeFileSync(${JSON.stringify(join(dir, 'ready'))}, directory);
    setInterval(() => {}, 1000);
  `);
  tmux('respawn-pane', '-k', '-t', root, `exec ${shellEscape(process.execPath)} ${shellEscape(script)}`);
  await until(() => existsSync(join(dir, 'ready')));
  const ownerDirectory = readFileSync(join(dir, 'ready'), 'utf8');
  t.after(() => rmSync(ownerDirectory, { recursive: true, force: true }));
  const toolPid = readFileSync(join(dir, 'tool-pid'), 'utf8').trim();
  assert.ok(existsSync(join(ownerDirectory, 'scratch')));
  await closeSurfaceTreeAsync(root);
  writeFileSync(join(dir, 'release'), 'release');
  await until(() => !existsSync(ownerDirectory));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(existsSync(join(dir, 'orphan')), false, 'detached tool cannot write after pane cleanup');
  assert.deepEqual(tmux('list-panes', '-s', '-t', name, '-F', '#{pane_id}').split('\n'), [foreign]);
  try {
    assert.match(execFileSync('ps', ['-o', 'stat=', '-p', toolPid], { encoding: 'utf8' }).trim(), /^Z/, 'detached tool must be dead');
  } catch (error) {
    if ((error as any).status !== 1) throw error;
  }
});

it('native polling detects both manual pane close and remain-on-exit termination', { timeout: 10000 }, async t => {
  const { root } = session(t);
  const manual = tmux('split-window', '-d', '-t', root, '-P', '-F', '#{pane_id}');
  let closed = false;
  const result = await pollForExit(manual, new AbortController().signal, {
    cli: true, interval: 5, onTick() { if (!closed) { closed = true; tmux('kill-pane', '-t', manual); } },
  });
  assert.equal(result.reason, 'error');
  assert.match(result.errorMessage!, /closed before reporting completion/);
  const retained = tmux('split-window', '-d', '-t', root, '-P', '-F', '#{pane_id}');
  tmux('set-option', '-p', '-t', retained, 'remain-on-exit', 'on');
  tmux('respawn-pane', '-k', '-t', retained, 'exit 9');
  await until(() => tmux('display-message', '-p', '-t', retained, '#{pane_dead}') === '1');
  const deadResult = await pollForExit(retained, new AbortController().signal, { cli: true, interval: 5 });
  assert.equal(deadResult.reason, 'error');
});
