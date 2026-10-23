/** Real tmux cancellation ancestry, without model requests. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createSurface, closeSurfaceTree, surfaceExists, sendCommand, shellEscape } from '../../pi-extension/subagents/tmux.ts';
import extension, { __test__ } from '../../pi-extension/subagents/index.ts';
import { createVerifyScratch, cleanupVerifyScratch } from '../../pi-extension/subagents/workflow/readonly.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStatusState } from '../../pi-extension/subagents/status.ts';
let available = true;
try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch { available = false; }
for (const exit of ['cancel', 'owner-exit', 'parent-shutdown']) {
it(exit + ' removes delegated descendants but preserves siblings and its parent', { skip: !available }, async t => {
  const keys = ['TMUX', 'TMUX_PANE', 'PI_SUBAGENT_TREE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const session = 'pi-branch-cancel-' + process.pid;
  const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  t.after(() => {
    try { tmux('kill-session', '-t', session); } catch {}
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  });
  const root = tmux('new-session', '-d', '-s', session, '-x', '160', '-y', '50', '-P', '-F', '#{pane_id}');
  process.env.TMUX = tmux('display-message', '-p', '-t', root, '#{socket_path},#{pid},0');
  process.env.TMUX_PANE = root; process.env.PI_SUBAGENT_TREE = root;
  const child = createSurface('child');
  const sibling = createSurface('sibling');
  tmux('set-option', '-p', '-t', sibling, '@pi_subagent_owner', 'unrelated-test-owner');
  process.env.TMUX_PANE = child;
  const delegated = createSurface('delegated');
  assert.equal(tmux('display-message', '-p', '-t', delegated, '#{@pi_subagent_parent}'), child);
  process.env.TMUX_PANE = delegated;
  const leaf = createSurface('third-level');
  const markers = mkdtempSync(join(tmpdir(), 'pi-branch-tools-'));
  t.after(() => rmSync(markers, { recursive: true, force: true }));
  for (const [pane, label] of [[leaf, 'leaf'], [sibling, 'sibling']]) {
    const command = `echo $$ > ${shellEscape(join(markers, label + '-pid'))}; while ! test -f ${shellEscape(join(markers, 'release'))}; do sleep 0.05; done; echo done > ${shellEscape(join(markers, label + '-done'))}`;
    sendCommand(pane, 'bash -c ' + shellEscape(command));
  }
  const deadline = Date.now() + 5000;
  while (!existsSync(join(markers, 'leaf-pid')) || !existsSync(join(markers, 'sibling-pid'))) {
    assert.ok(Date.now() < deadline, 'both actual tools must start before cancellation');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const leafPid = Number(readFileSync(join(markers, 'leaf-pid'), 'utf8'));
  const siblingPid = Number(readFileSync(join(markers, 'sibling-pid'), 'utf8'));
  if (exit === 'cancel') closeSurfaceTree(child);
  else {
    const scratch = createVerifyScratch();
    t.after(() => cleanupVerifyScratch(scratch));
    const dir = mkdtempSync(join(tmpdir(), 'pi-owner-exit-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const running = { id: 'exited-owner', name: 'child', task: '', surface: child, verifyScratchDir: scratch,
      startTime: Date.now(), sessionFile: join(dir, 'child.jsonl'),
      statusState: createStatusState({ source: 'pi', startTimeMs: Date.now() }) };
    __test__.runningSubagents.set(running.id, running);
    t.after(() => __test__.runningSubagents.delete(running.id));
    if (exit === 'owner-exit') {
      tmux('kill-pane', '-t', child);
      const result = await __test__.watchSubagent(running, new AbortController().signal);
      assert.equal(result.exitCode, 1, 'unreported process exit is a failure');
    } else {
      const shutdown: Function[] = [];
      let notifications = 0;
      extension({ on(event: string, handler: Function) { if (event === 'session_shutdown') shutdown.push(handler); },
        registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
        getThinkingLevel: () => 'off', getAllTools: () => [],
        sendMessage() { notifications++; },
      } as any);
      for (const handler of shutdown) await handler({ reason: 'quit' }, {});
      writeFileSync(running.sessionFile + '.ask', JSON.stringify({ question: 'late question' }));
      __test__.deliverPendingQuestion(running);
      assert.equal(notifications, 0, 'a late watcher must not notify an exited parent');
    }
    assert.equal(__test__.runningSubagents.has(running.id), false);
    assert.equal(existsSync(scratch), false, 'shutdown must finish resource cleanup before returning');
  }
  assert.equal(surfaceExists(child), false);
  assert.equal(surfaceExists(delegated), false);
  assert.equal(surfaceExists(leaf), false);
  assert.equal(surfaceExists(root), true);
  assert.equal(surfaceExists(sibling), true);
  assert.doesNotThrow(() => process.kill(siblingPid, 0), 'another branch tool must survive');
  writeFileSync(join(markers, 'release'), 'release');
  const finished = Date.now() + 5000;
  while (!existsSync(join(markers, 'sibling-done'))) {
    assert.ok(Date.now() < finished, 'unrelated branch must still make progress');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(join(markers, 'leaf-done')), false, 'closed third-level tool cannot execute after cancellation');
  assert.equal(readFileSync(join(markers, 'sibling-done'), 'utf8').trim(), 'done');
  try { assert.match(tmuxProcessState(leafPid), /^Z/); } catch (error) { if ((error as any).status !== 1) throw error; }
});
}

function tmuxProcessState(pid: number) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  return execFileSync('ps', ['-o','stat=','-p',String(pid)], { encoding: 'utf8' }).trim();
}
