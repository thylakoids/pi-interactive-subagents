/** Subprocess fixture for tmux unit tests and the standalone benchmark. */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';

export type Call = { command: string; args: string[]; async: boolean };
export async function tmuxFixture(
  t: Pick<TestContext, 'mock' | 'after'>,
  respond: (call: Call) => string | Promise<string>,
  moduleUrl = new URL('../pi-extension/subagents/tmux.ts', import.meta.url).href,
) {
  const calls: Call[] = [];
  const saved = process.env.TMUX;
  process.env.TMUX = 'test-socket';
  const invoke = (command: string, args: string[], async: boolean) => {
    if (command === 'sh') return '';
    const call = { command, args, async };
    calls.push(call);
    return respond(call);
  };
  t.mock.method(childProcess, 'execFileSync', (command: string, args: string[]) => invoke(command, args, false));
  const savedExecFile = childProcess.execFile;
  // Node's execFile has a non-configurable custom promisifier; replacing the
  // function itself keeps the test from invoking that original implementation.
  childProcess.execFile = Object.assign(() => { throw new Error('Use promisified execFile'); }, {
    [promisify.custom]: async (command: string, args: string[]) => ({ stdout: await invoke(command, args, true), stderr: '' }),
  }) as unknown as typeof childProcess.execFile;
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    childProcess.execFile = savedExecFile;
    syncBuiltinESMExports();
    if (saved === undefined) delete process.env.TMUX; else process.env.TMUX = saved;
  });
  const tmux = await import(moduleUrl + '?fixture=' + Math.random());
  return { tmux, calls };
}
