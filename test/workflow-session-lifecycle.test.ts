import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerWorkflowExtension } from '../pi-extension/subagents/workflow/index.ts';
import { deferred, fixture, script } from './helpers/workflow.ts';

for (const reason of ['reload', 'quit']) {
  it(`session ${reason} awaits terminal persistence and lock release before returning`, async t => {
    const gate = deferred<void>();
    const f = fixture(t, async () => { await gate.promise; return { text: 'late' }; });
    const hooks = new Map<string, Function[]>();
    let tool: any;
    const sent: unknown[] = [];
    registerWorkflowExtension({
      registerTool(value: any) { tool = value; }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
      on(event: string, handler: Function) { hooks.set(event, [...(hooks.get(event) ?? []), handler]); },
      sendMessage(value: unknown) { sent.push(value); },
    } as any, { service: f.service });
    const ctx = (id: string) => ({ cwd: f.dir, hasUI: false, ui: { notify() {} }, sessionManager: {
      getSessionFile: () => join(f.dir, id + '.jsonl'), getSessionId: () => id, getSessionDir: () => f.dir,
    } });
    const emit = async (event: string, context: any) => {
      for (const handler of hooks.get(event) ?? []) await handler({ reason }, context);
    };
    const firstCtx = ctx('first');
    await emit('session_start', firstCtx);
    const started = await tool.execute('start', { script: script('return await agent("blocked");') }, undefined, undefined, firstCtx);
    assert.equal(started.isError, undefined, started.content?.[0]?.text);
    await f.waitForCall(() => true);
    await emit('session_shutdown', firstCtx);
    const disk = JSON.parse(readFileSync(join(started.details.runDir, 'snapshot.json'), 'utf8'));
    assert.equal(disk.status, 'aborted');
    assert.equal(existsSync(join(started.details.runDir, 'lock')), false, 'shutdown must not leave a live-PID lock');
    assert.equal(f.stopped.length, 1);
    assert.deepEqual(sent, [], 'teardown must not wake a closing session');
    gate.resolve();

    const secondCtx = ctx('second');
    await emit('session_start', secondCtx);
    const next = await tool.execute('next', { script: script('return "new session";') }, undefined, undefined, secondCtx);
    assert.ok(next.details.runDir.startsWith(join(f.dir, 'artifacts', 'second')), 'a new session cannot reuse the previous manager');
    await emit('session_shutdown', secondCtx);
  });
}
