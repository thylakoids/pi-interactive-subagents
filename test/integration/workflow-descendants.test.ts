/** Real tmux cancellation ancestry, without model requests. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createSurface, closeSurfaceTree, surfaceExists } from '../../pi-extension/subagents/tmux.ts';
import extension, { __test__ } from '../../pi-extension/subagents/index.ts';
import { createVerifyScratch, cleanupVerifyScratch } from '../../pi-extension/subagents/workflow/readonly.ts';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.equal(surfaceExists(root), true);
  assert.equal(surfaceExists(sibling), true);
});
}
