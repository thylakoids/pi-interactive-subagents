import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJournal, loadJournal } from '../pi-extension/subagents/workflow/journal.ts';
import type { WorkflowJournalEntry } from '../pi-extension/subagents/workflow/types.ts';
import { fixture, script } from './helpers/workflow.ts';

function entry(key: string): WorkflowJournalEntry {
  return { type: 'call', callKey: key, status: 'completed', label: key, agentType: 'worker', prompt: key, value: key };
}

for (const suffix of ['', '\n', '\n{"type":"call","callKey":"torn']) {
  it('append preserves new records after an unterminated journal tail ' + JSON.stringify(suffix), t => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-journal-tail-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'journal.jsonl');
    writeFileSync(path, JSON.stringify(entry('before')) + suffix);
    appendJournal(path, entry('after'));
    appendJournal(path, entry('last'));
    const loaded = loadJournal(path);
    assert.deepEqual([...loaded.entries.keys()], ['before', 'after', 'last']);
    assert.equal(loaded.skippedLines, suffix.includes('torn') ? 1 : 0);
    assert.ok(readFileSync(path, 'utf8').endsWith('\n'));
  });
}

it('a result settled after a torn append survives another disk resume without repeating work', async t => {
  const f = fixture(t, request => ({ text: request.task, tokens: 3 }));
  const first = await f.manager.start({ source: script("return await agent('first');"), args: {} });
  const initial = await first.execute();
  assert.equal(initial.status, 'completed', initial.error);
  const journal = join(initial.runDir, 'journal.jsonl');
  appendFileSync(journal, '{"type":"call","callKey":"interrupted');
  const source = script("return [await agent('first'), await agent('second')];");
  const second = await (await f.reload().resume(first.runId, { source })).execute();
  assert.equal(second.status, 'completed', second.error);
  assert.equal(f.calls.length, 2);
  assert.equal(loadJournal(journal).records.length, 2, 'new settlement is independently readable after the corrupt tail');
  const third = await (await f.reload().resume(first.runId, { source })).execute();
  assert.equal(third.status, 'completed', third.error);
  assert.deepEqual(third.result, second.result);
  assert.equal(f.calls.length, 2, 'second disk resume must not repeat a completed side effect');
});

for (const fault of ['short-write', 'zero-write', 'flush-failure']) {
  it('journal durability boundary handles ' + fault, t => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-journal-io-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'journal.jsonl');
    const module = new URL('../pi-extension/subagents/workflow/journal.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      import { syncBuiltinESMExports } from 'node:module';
      const originalWrite = fs.writeSync;
      const originalFlush = fs.fsyncSync;
      let writes = 0, flushes = 0;
      fs.writeSync = (fd, buffer, offset, length) => {
        writes++;
        if (${JSON.stringify(fault)} === 'zero-write') return 0;
        return originalWrite(fd, buffer, offset, Math.min(length, 3));
      };
      fs.fsyncSync = fd => {
        flushes++;
        if (${JSON.stringify(fault)} === 'flush-failure') throw new Error('injected flush failure');
        originalFlush(fd);
      };
      syncBuiltinESMExports();
      const { appendJournal, loadJournal } = await import(${JSON.stringify(module)});
      const path = ${JSON.stringify(path)};
      const entry = ${JSON.stringify(entry('durable-\u96ea'))};
      if (${JSON.stringify(fault)} === 'short-write') {
        appendJournal(path, entry);
        assert.ok(writes > 1);
        assert.equal(flushes, 1, 'success must flush the completed record');
        assert.deepEqual(loadJournal(path).entries.get(entry.callKey), entry);
      } else {
        assert.throws(() => appendJournal(path, entry), ${fault === 'zero-write' ? '/no progress/' : '/injected flush failure/'});
      }
    `], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
  });
}
