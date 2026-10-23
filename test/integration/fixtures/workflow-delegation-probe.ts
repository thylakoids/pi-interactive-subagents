/** Real branch -> relay -> leaf cancellation alongside an independent workflow. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WorkflowManager, type WorkflowManagerOptions } from '../../../pi-extension/subagents/workflow/manager.ts';
import { __test__ } from '../../../pi-extension/subagents/index.ts';
import { surfaceExists } from '../../../pi-extension/subagents/tmux.ts';
import { getSessionId, readNameRegistry } from '../../../pi-extension/subagents/session.ts';

export async function delegationProbe(options: WorkflowManagerOptions, dir: string) {
  const manager = new WorkflowManager(options);
  const resumedManager = new WorkflowManager(options);
  const until = async (check: () => boolean, label: string) => {
    const deadline = Date.now() + 180_000;
    while (!check()) { assert.ok(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  const pid = (name: string) => Number(readFileSync(join(dir, name + '-pid'), 'utf8').trim());
  const alive = (id: number) => {
    assert.ok(Number.isInteger(id) && id > 0);
    try { return !execFileSync('ps', ['-o','stat=','-p',String(id)], { encoding: 'utf8' }).trim().startsWith('Z'); }
    catch (error) { if ((error as any).status !== 1) throw error; return false; }
  };
  const prompt = (command: string) => 'Execute exactly this bash command once, then reply DONE. Existing marker files intentionally preserve earlier attempts. Do not add setup/cleanup or reset files. Do not delegate: ' + command;
  const blocking = (name: string) => prompt(`timeout 240 sh -c 'echo $$ > ${name}-pid; echo started >> ${name}-started; while ! test -f ${name}-release; do sleep 0.2; done; echo done >> ${name}-done'`);
  const delegate = (agent: string, task: string) => 'Call subagent exactly once with ' + JSON.stringify({ agent, name: agent + '-probe', task }) + '. End your turn and wait for the actual subagent result. Then return that result. Do not do its work yourself.';
  const source = (name: string, body: string) => 'export const meta = ' + JSON.stringify({ name, description: 'Delegation isolation probe' }) + '\n' + body;
  const sibling = await manager.start({ source: source('parallel-sibling', `return await agent(${JSON.stringify(blocking('sibling'))}, {agent:'leaf',label:'sibling'});`), args: {} });
  const executions: Promise<unknown>[] = [sibling.execute()];
  try {
    await until(() => existsSync(join(dir, 'sibling-pid')), 'independent workflow blocks');
    const siblingPid = pid('sibling');
    const branch = await manager.start({ source: source('nested-branch', `
      const saved = await agent(${JSON.stringify(prompt('echo once >> branch-saved'))}, {agent:'leaf',label:'saved'});
      if (!saved) throw new Error('saved failed');
      return await agent(${JSON.stringify(delegate('relay', delegate('leaf', blocking('branch'))))}, {agent:'branch',label:'branch'});`), args: {} });
    const first = branch.execute(); executions.push(first);
    await until(() => existsSync(join(dir, 'branch-pid')), 'third-level agent executes a real bash tool');
    const oldPid = pid('branch');
    const rootCall = branch.view().calls.find(call => call.label === 'branch')!;
    const rootPane = [...__test__.runningSubagents.values()].find(child => child.name === rootCall.name)!.surface;
    const panes = execFileSync('tmux', ['list-panes','-a','-F','#{pane_id}|#{@pi_subagent_parent}'], { encoding: 'utf8' }).trim().split('\n').map(row => row.split('|'));
    const owned = new Set([rootPane]);
    for (const root of owned) for (const [pane, parent] of panes) if (parent === root) owned.add(pane);
    assert.equal(owned.size, 3, 'must actually delegate through branch, relay and leaf');
    const sessions = [rootCall.sessionFile!];
    for (let depth = 0; depth < 2; depth++) {
      const parent = sessions.at(-1)!;
      const children = Object.values(readNameRegistry(join(dirname(parent), 'artifacts', getSessionId(parent)!)));
      assert.equal(children.length, 1);
      sessions.push(children[0].sessionFile);
    }
    for (const file of sessions) {
      const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(rows.some(row => row.message?.role === 'assistant' && row.message.usage?.output > 0), 'every delegation level must use the real model');
    }
    branch.abort('cancel only this delegated workflow');
    assert.equal((await first).status, 'aborted');
    await until(() => [...owned].every(pane => !surfaceExists(pane)) && !alive(oldPid), 'all old descendant panes and actual leaf process exit');
    assert.equal(alive(siblingPid), true, 'cancelling branch cannot kill the other workflow tool');
    assert.equal(sibling.view().status, 'running');
    const resumed = await resumedManager.resume(branch.runId);
    const next = resumed.execute(); executions.push(next);
    await until(() => readFileSync(join(dir, 'branch-started'), 'utf8') === 'started\nstarted\n', 'one replacement leaf starts');
    assert.notEqual(pid('branch'), oldPid);
    assert.equal(alive(siblingPid), true, 'resume cannot reap another live workflow owned by this parent');
    writeFileSync(join(dir, 'branch-release'), 'release');
    const done = await next;
    assert.equal(done.status, 'completed', done.error);
    assert.ok(done.calls.every(call => call.status === 'completed'), JSON.stringify(done.calls));
    assert.equal(readFileSync(join(dir, 'branch-saved'), 'utf8'), 'once\n', 'committed work must not repeat');
    assert.equal(readFileSync(join(dir, 'branch-done'), 'utf8'), 'done\n', 'cancelled descendant must not write after resume');
    assert.equal(alive(siblingPid), true, 'normal delegated completion cannot close a sibling workflow');
    writeFileSync(join(dir, 'sibling-release'), 'release');
    const other = await executions[0] as any;
    assert.equal(other.status, 'completed');
    assert.ok(other.calls.every((call: any) => call.status === 'completed'), JSON.stringify(other.calls));
    assert.equal(readFileSync(join(dir, 'sibling-done'), 'utf8'), 'done\n');
    writeFileSync(join(dir, 'delegation-isolation.json'), JSON.stringify({ runId: branch.runId, sibling: sibling.runId, oldPid, replacementPid: pid('branch'), panes: [...owned], sessions }));
  } finally {
    manager.abortAll('delegation probe cleanup'); resumedManager.abortAll('delegation probe cleanup');
    await Promise.all(executions);
  }
}
