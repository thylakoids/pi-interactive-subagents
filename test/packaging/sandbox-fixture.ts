/** Runs inside the installed official Pi, before any provider request. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { runScript, type StartScriptOptions } from '../../pi-extension/subagents/workflow/runner.ts';
import subagents from '../../pi-extension/subagents/index.ts';

export default function (pi: ExtensionAPI) {
  subagents(pi);
  pi.on('session_start', async () => {
    const report = process.env.PI_PACKAGE_REPORT!;
    try {
      const execute = (code: string, options: Partial<StartScriptOptions> = {}) => runScript({
        code, args: {}, startedAt: Date.now(), seed: 7, signal: new AbortController().signal,
        onCall(call, deliver) {
          assert.equal(call.name, '__wfBridgeBudget');
          deliver({ok:true, value:{total:null,spent:0,remaining:null}});
        }, ...options,
      });
      const ordinary = await execute('return {value:7, process:typeof process, require:typeof require};');
      assert.equal(ordinary.ok, true, ordinary.error?.message);
      assert.deepEqual(ordinary.value, {value:7,process:'undefined',require:'undefined'});
      const controller = new AbortController();
      let ticks = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let aborted;
      try {
        aborted = await execute('while(true) {}', {
          signal:controller.signal,
          onStarted() {
            heartbeat = setInterval(() => { ticks++; }, 10);
            timer = setTimeout(() => controller.abort('package CPU-loop probe'), 100);
          },
        });
      } finally { clearTimeout(timer); clearInterval(heartbeat); }
      assert.equal(aborted.ok, false);
      assert.equal(aborted.error?.kind, 'aborted', aborted.error?.message);
      assert.ok(ticks >= 2, 'the Pi event loop must remain responsive while the worker spins');
      const afterAbort = await execute('return "worker-still-usable";');
      assert.equal(afterAbort.value, 'worker-still-usable', afterAbort.error?.message);
      writeFileSync(report, JSON.stringify({ok:true,checks:['extension-load','isolated-vm','responsive-abort','run-after-abort'],ticks}));
      process.exit(0);
    } catch (error) {
      writeFileSync(report, JSON.stringify({ok:false,error:String(error instanceof Error ? error.stack : error)}));
      process.exit(1);
    }
  });
}
