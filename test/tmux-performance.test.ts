import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmuxFixture } from './tmux-fixture.ts';

for (const asynchronous of [false, true]) {
  it(`${asynchronous ? 'async' : 'sync'} tree cleanup indexes descendants, preserves guardians and foreign panes`, async t => {
    const panes = new Map([
      ['%1', { parent: '', pid: 100, tree: '%1', window: '@1' }],
      ['%2', { parent: '%1', pid: 200, tree: '%1', window: '@1' }],
      ['%3', { parent: '%2', pid: 300, tree: '%1', window: '@2' }],
      ['%4', { parent: '%2', pid: 400, tree: '%1', window: '@2' }],
      ['%9', { parent: '%other', pid: 900, tree: '%other', window: '@1' }],
    ]);
    const guardian = fileURLToPath(new URL('../pi-extension/subagents/surface-guardian.ts', import.meta.url));
    const killed: number[] = [];
    const closed: string[] = [];
    t.mock.method(process, 'kill', (pid: number, signal: string) => {
      assert.equal(signal, 'SIGKILL');
      killed.push(pid);
      return true;
    });
    const { tmux, calls } = await tmuxFixture(t, ({ command, args }) => {
      if (command === 'ps') return [
        '100 1 shell', '200 1 shell', '300 1 shell', '400 1 shell', '900 1 foreign',
        '201 200 detached-tool', '202 201 timeout', `203 200 ${process.execPath} ${guardian} scratch`,
        `204 201 sh -c echo ${guardian}`, '901 900 foreign-tool',
      ].join('\n');
      if (args[0] === 'list-panes' && args.includes('-a')) {
        return [...panes].map(([id, p]) => `${id}|${p.parent}|${p.pid}|0`).join('\n');
      }
      if (args[0] === 'display-message') {
        const id = args[args.indexOf('-t') + 1];
        const pane = panes.get(id);
        if (!pane) return '';
        return `W|${pane.window}\n` + [...panes].filter(([, p]) => p.window === pane.window)
          .map(([id, p]) => `P|${id}|${p.tree}`).join('\n');
      }
      if (args[0] === 'kill-pane') {
        const id = args[2];
        closed.push(id);
        assert.notEqual(id, '%9');
        // @1 contains a foreign pane and must never receive select-layout.
        if (panes.get(id)?.window === '@1') assert.ok(!args.includes('select-layout'));
        panes.delete(id);
        return '';
      }
      throw new Error(`Unexpected command ${command} ${args.join(' ')}`);
    });
    if (asynchronous) await tmux.closeSurfaceTreeAsync('%1'); else tmux.closeSurfaceTree('%1');
    assert.deepEqual(new Set(killed), new Set([201, 202, 204]));
    assert.ok(killed.indexOf(202) < killed.indexOf(201), 'detached child dies before its parent');
    assert.deepEqual(closed, ['%4', '%3', '%2', '%1']);
    assert.deepEqual([...panes.keys()], ['%9']);
    assert.equal(calls.filter(c => c.args[0] === 'list-panes' && c.args.includes('-a')).length, 1);
    assert.equal(calls.filter(c => c.command === 'ps').length, 1);
    assert.ok(calls.every(c => c.async === asynchronous), 'async cleanup must never synchronously spawn a command');
  });
}

it('async cleanup observes a user pane added after its ancestry snapshot', async t => {
  t.mock.method(process, 'kill', () => true);
  const { tmux, calls } = await tmuxFixture(t, ({ command, args }) => {
    if (command === 'ps') return '';
    if (args[0] === 'list-panes') return '%1||100|0\n%2|%1|200|0';
    if (args[0] === 'display-message') return 'W|@1\nP|%1|\nP|%2|%1\nP|%user|';
    if (args[0] === 'kill-pane') return '';
    throw new Error('Unexpected command');
  });
  await tmux.closeSurfaceTreeAsync('%2');
  assert.ok(calls.filter(c => c.args[0] === 'kill-pane').every(c => !c.args.includes('select-layout')));
});

it('concurrent native exit polls share one async liveness query and never capture screens', async t => {
  const { tmux, calls } = await tmuxFixture(t, async () => {
    await new Promise(resolve => setImmediate(resolve));
    return '%other|0';
  });
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => tmux.pollForExit(`%${i}`, new AbortController().signal, { cli: true, interval: 1 })));
  assert.ok(results.every(result => result.reason === 'error' && /closed/.test(result.errorMessage)));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['list-panes', '-a', '-F', '#{pane_id}|#{pane_dead}']);
  assert.equal(calls[0].async, true);
});

it('native polling detects remain-on-exit dead panes and refreshes its snapshot', async t => {
  let generation = 0;
  const { tmux, calls } = await tmuxFixture(t, () => ++generation === 1 ? '%1|0' : '%1|1');
  const result = await tmux.pollForExit('%1', new AbortController().signal, { cli: true, interval: 1 });
  assert.equal(result.reason, 'error');
  assert.equal(calls.length, 2);
});

it('native polling cancels a live pane without reading its terminal sentinel', async t => {
  const controller = new AbortController();
  const { tmux, calls } = await tmuxFixture(t, () => '%1|0');
  await assert.rejects(tmux.pollForExit('%1', controller.signal, {
    cli: true, interval: 1000, onTick() { controller.abort(); },
  }), /Aborted/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'list-panes');
});

for (const diagnostic of [false, true]) {
  it(`native polling rechecks ${diagnostic ? 'hook errors' : 'completion files'} when a pane closes during its query`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-poll-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'done');
    const { tmux } = await tmuxFixture(t, () => {
      writeFileSync(file + (diagnostic ? '.hook-error' : ''), diagnostic ? JSON.stringify({ errorMessage: 'hook failed' }) : 'done');
      return '';
    });
    const result = await tmux.pollForExit('%1', new AbortController().signal, { cli: true, sentinelFile: file, interval: 1 });
    assert.equal(result.reason, diagnostic ? 'error' : 'sentinel');
    if (diagnostic) assert.equal(result.errorMessage, 'hook failed');
  });
}

it('Pi retains terminal sentinel fallback and its actual exit status', async t => {
  const { tmux, calls } = await tmuxFixture(t, () => '__SUBAGENT_DONE_7__');
  assert.deepEqual(await tmux.pollForExit('%1', new AbortController().signal, { interval: 1 }), { reason: 'sentinel', exitCode: 7 });
  assert.equal(calls[0].args[0], 'capture-pane');
});

it('Pi rechecks settled sidecars when its pane disappears', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-sidecar-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  const { tmux } = await tmuxFixture(t, () => {
    writeFileSync(file + '.exit', JSON.stringify({ type: 'done' }));
    throw new Error('pane unavailable');
  });
  assert.deepEqual(await tmux.pollForExit('%1', new AbortController().signal, { interval: 1, sessionFile: file }), { reason: 'done', exitCode: 0 });
});
