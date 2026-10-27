import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUN_LOCK_HELPER } from '../pi-extension/subagents/workflow/run-lock.ts';
import { acquireLock, releaseLock } from '../pi-extension/subagents/workflow/journal.ts';

it('an unreaped zombie owner does not strand its workflow lock', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-zombie-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const code = `import os, subprocess, sys
pid = os.fork()
if pid == 0:
    result = subprocess.run(['python3', '-c', ${JSON.stringify(RUN_LOCK_HELPER)}, ${JSON.stringify(dir)}, 'acquire', str(os.getpid()), 'zombie-token'], stdout=subprocess.DEVNULL)
    os._exit(result.returncode)
print(pid, flush=True)
sys.stdin.readline()
os.waitpid(pid, 0)
`;
  const parent = spawn('python3', ['-c', code], { stdio: ['pipe','pipe','pipe'] });
  const closed = once(parent, 'close');
  t.after(async () => { parent.stdin.end('\n'); await closed; });
  const [output] = await once(parent.stdout, 'data');
  const pid = Number(String(output).trim());
  const deadline = Date.now() + 5000;
  while (!execFileSync('ps', ['-o','stat=','-p',String(pid)], { encoding: 'utf8' }).trim().startsWith('Z')) {
    assert.ok(Date.now() < deadline, 'fixture must actually reach kernel zombie state');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.doesNotThrow(() => process.kill(pid, 0), 'PID existence alone incorrectly says this owner is alive');
  const lock = await acquireLock(dir);
  assert.equal(lock.ok, true, JSON.stringify(lock));
  if (lock.ok) await releaseLock(lock.path);
});
