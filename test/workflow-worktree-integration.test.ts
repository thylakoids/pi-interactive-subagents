import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, script } from './helpers/workflow.ts';

it('the manager executes isolated calls in real worktrees and resume preserves their edits', async t => {
  const f = fixture(t, request => {
    assert.ok(request.cwd);
    const path = join(request.cwd!, 'tracked.txt');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, 'isolated edit\n');
    writeFileSync(join(request.cwd!, 'agent-created.txt'), 'retained\n');
    return { text: original };
  });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  writeFileSync(join(f.dir, 'tracked.txt'), 'committed HEAD\n');
  git('add', 'tracked.txt');
  git('-c', 'user.name=Workflow Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed');
  writeFileSync(join(f.dir, 'tracked.txt'), 'main dirty edit\n');
  const source = (label: string) => script(`return await agent('edit tracked file', {label:${JSON.stringify(label)}, isolation:'worktree'});`);
  const run = await f.manager.start({ source: source('original'), args: {} });
  const first = await run.execute();
  assert.equal(first.status, 'completed', first.error);
  assert.equal(first.calls[0].status, 'completed', first.calls[0].error);
  assert.equal(first.result, 'committed HEAD\n', 'uncommitted parent files must not leak into the child worktree');
  const isolated = join(first.runDir, 'worktrees', first.calls[0].callKey);
  assert.equal(f.calls[0].cwd, isolated, 'worktree preparation must reach the production service boundary');
  assert.equal(readFileSync(join(f.dir, 'tracked.txt'), 'utf8'), 'main dirty edit\n');
  assert.equal(existsSync(join(f.dir, 'agent-created.txt')), false);
  assert.equal(readFileSync(join(isolated, 'tracked.txt'), 'utf8'), 'isolated edit\n');
  const after = await (await f.reload().resume(run.runId, { source: source('renamed') })).execute();
  assert.equal(after.status, 'completed', after.error);
  assert.equal(after.result, first.result);
  assert.equal(f.calls.length, 1);
  assert.equal(readFileSync(join(isolated, 'agent-created.txt'), 'utf8'), 'retained\n');
});

it('worktree preparation failure settles the call without spawning a non-isolated fallback', async t => {
  const f = fixture(t, () => ({ text: 'must not launch' }));
  const view = await (await f.manager.start({ source: script("return await agent('task', {isolation:'worktree'});"), args: {} })).execute();
  assert.equal(view.status, 'completed', view.error);
  assert.equal(view.result, null);
  assert.equal(view.calls[0].status, 'failed');
  assert.match(view.calls[0].error!, /git repository/);
  assert.equal(f.calls.length, 0, 'isolation failure must not silently run in the main workspace');
});
