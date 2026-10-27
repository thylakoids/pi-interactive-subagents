import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleCliEvent } from '../pi-extension/subagents/cli-hook.mjs';

const hook = join(import.meta.dirname, '../pi-extension/subagents/cli-hook.mjs');
const user = (id: string, text: string) => ({ type: 'user', uuid: id, promptId: id, message: { content: text } });
const answer = (id: string, text: string) => ({ type: 'assistant', uuid: id, message: { id, content: [{ type: 'text', text }] } });
const rows = (entries: any[]) => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

function fixture(t: any, prompts = ['first', 'later']) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-claude-snapshot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'session.jsonl'), resultFile = join(dir, 'result.json');
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'pi-id' }) + '\n');
  writeFileSync(`${sessionFile}.cli.json`, JSON.stringify({ kind: 'claude', nativeId: 'native' }));
  writeFileSync(`${resultFile}.inputs.json`, JSON.stringify(prompts));
  const event = (extra = {}) => ({ session_id: 'native', hook_event_name: 'Stop',
    transcript_path: transcript, prompt_id: 'first', ...extra });
  const send = (extra = {}, mode = 'auto') => handleCliEvent('claude', sessionFile, resultFile, mode, event(extra));
  const json = (suffix = '') => JSON.parse(readFileSync(resultFile + suffix, 'utf8'));
  return { dir, sessionFile, resultFile, transcript, event, send, json };
}

for (const payload of ['different answers', 'identical answers', 'omitted answer']) {
  test(`a delayed Stop is bounded to its own prompt with ${payload}`, t => {
    const f = fixture(t);
    const laterAnswer = payload === 'identical answers' ? 'first done' : 'later done';
    writeFileSync(f.transcript, rows([
      user('first', 'first'), answer('a1', 'first done'),
      user('later', 'later'), answer('a2', laterAnswer),
    ]));
    const child = spawnSync(process.execPath, [hook, 'claude', f.sessionFile, f.resultFile, 'auto'], {
      input: JSON.stringify(f.event(payload === 'omitted answer' ? {} : { last_assistant_message: 'first done' })),
      encoding: 'utf8', timeout: 8000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(existsSync(f.resultFile), false, 'the later completed turn still needs its own Stop');
    assert.equal(f.json('.latest').summary, 'first done');
    assert.deepEqual(f.json('.latest').completedInputs, ['first']);
    assert.deepEqual(f.json('.claude-seen.json'), ['first']);
    f.send({ prompt_id: 'later', last_assistant_message: laterAnswer });
    assert.equal(f.json().summary, laterAnswer);
    assert.deepEqual(f.json('.latest').completedInputs, ['first', 'later']);
  });
}

for (const laterAnswer of ['later done', 'first done']) {
  test(`an older Stop cannot claim a later queued_command in the same prompt span (${laterAnswer})`, t => {
    const f = fixture(t);
    writeFileSync(f.transcript, rows([
      user('first', 'first'), answer('a1', 'first done'),
      { type: 'attachment', uuid: 'queued-later', attachment: { type: 'queued_command',
        prompt: 'later', origin: { kind: 'human' }, commandMode: 'prompt' } },
      answer('a2', laterAnswer),
    ]));
    const child = spawnSync(process.execPath, [hook, 'claude', f.sessionFile, f.resultFile, 'auto'], {
      input: JSON.stringify(f.event({ last_assistant_message: 'first done' })), encoding: 'utf8', timeout: 8000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(f.json('.latest').completedInputs, ['first']);
    assert.deepEqual(f.json('.claude-seen.json'), ['first']);
    assert.equal(existsSync(f.resultFile), false);
    const latest = readFileSync(`${f.resultFile}.latest`, 'utf8');
    f.send({ last_assistant_message: laterAnswer });
    assert.equal(readFileSync(`${f.resultFile}.latest`, 'utf8'), latest,
      'an already completed prompt_id remains deduplicated; no speculative acknowledgement');
  });
}

test('summary fallback and acknowledgement reuse the same read when a later turn appears immediately', t => {
  const f = fixture(t);
  writeFileSync(f.transcript, rows([user('first', 'first'), answer('a1', 'first done')]));
  const observer = join(f.dir, 'observer.mjs');
  // Rewrite directly after readFileSync returns its bytes. A second read would
  // recover the wrong turn's inputs even without any OS scheduling assumptions.
  writeFileSync(observer, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original = fs.readFileSync; let reads = 0;
fs.readFileSync = (path, ...args) => {
  const value = original(path, ...args);
  if (path === ${JSON.stringify(f.transcript)}) {
    reads++;
    if (reads === 1) fs.appendFileSync(path, ${JSON.stringify(rows([user('later', 'later'), answer('a2', 'later done')]))});
  }
  return value;
};
process.on('exit', () => process.stdout.write(JSON.stringify({reads})));
syncBuiltinESMExports();`);
  const child = spawnSync(process.execPath, ['--import', observer, hook, 'claude', f.sessionFile, f.resultFile, 'auto'], {
    input: JSON.stringify(f.event()), encoding: 'utf8', timeout: 8000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).reads, 1);
  assert.equal(f.json('.latest').summary, 'first done');
  assert.deepEqual(f.json('.latest').completedInputs, ['first']);
  assert.equal(existsSync(f.resultFile), false);
});

test('a Stop keeps its verified snapshot when a later turn flushes while acquiring the lock', async t => {
  const f = fixture(t);
  writeFileSync(f.transcript, rows([user('first', 'first'), answer('a1', 'done')]));
  mkdirSync(`${f.resultFile}.lock`);
  const observer = join(f.dir, 'observer.mjs');
  writeFileSync(observer, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original = fs.readFileSync;
fs.readFileSync = (path, ...args) => {
  const value = original(path, ...args);
  if (path === ${JSON.stringify(f.transcript)}) process.stdout.write('read\\n');
  return value;
}; syncBuiltinESMExports();`);
  const child = spawn(process.execPath, ['--import', observer, hook, 'claude', f.sessionFile, f.resultFile, 'auto'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let stdout = '', stderr = '', released = false;
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (released) return;
    released = true;
    // Even an identical later answer must not extend the completed snapshot.
    appendFileSync(f.transcript, rows([user('later', 'later'), answer('a2', 'done')]));
    rmdirSync(`${f.resultFile}.lock`);
  });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timeout = setTimeout(() => child.kill(), 8000);
  t.after(() => clearTimeout(timeout));
  child.stdin.end(JSON.stringify(f.event({ last_assistant_message: 'done' })));
  assert.equal(await exited, 0, stderr);
  assert.equal(stdout.trim(), 'read', 'flush verification and acknowledgement must share one transcript read');
  assert.deepEqual(f.json('.latest').completedInputs, ['first']);
  assert.deepEqual(f.json('.claude-seen.json'), ['first']);
  assert.equal(existsSync(f.resultFile), false);
});

test('unchanged transcript polls reuse parsed history until the final record changes', t => {
  const f = fixture(t, ['first']);
  writeFileSync(f.transcript, rows([user('first', 'first')]));
  const observer = join(f.dir, 'observer.mjs');
  writeFileSync(observer, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const originalRead = fs.readFileSync, originalStat = fs.statSync;
let reads = 0, polls = 0;
fs.readFileSync = (path, ...args) => {
  if (path === ${JSON.stringify(f.transcript)}) reads++;
  return originalRead(path, ...args);
};
fs.statSync = (path, ...args) => {
  if (path === ${JSON.stringify(f.transcript)} && ++polls === 5) {
    fs.appendFileSync(path, ${JSON.stringify(rows([answer('a1', 'done')]))});
  }
  return originalStat(path, ...args);
};
process.on('exit', () => process.stdout.write(JSON.stringify({reads, polls})));
syncBuiltinESMExports();`);
  const child = spawnSync(process.execPath, ['--import', observer, hook, 'claude', f.sessionFile, f.resultFile, 'auto'], {
    input: JSON.stringify(f.event({ last_assistant_message: 'done' })), encoding: 'utf8', timeout: 8000,
  });
  assert.equal(child.status, 0, child.stderr);
  const counts = JSON.parse(child.stdout);
  assert.equal(counts.polls, 5);
  assert.equal(counts.reads, 2, 'only initial history and the changed final record require reading/parsing');
  assert.equal(f.json().summary, 'done');
});

test('a sidechain assistant cannot acknowledge the next main-thread input', t => {
  const f = fixture(t);
  writeFileSync(f.transcript, rows([
    user('first', 'first'), answer('a1', 'first done'), user('later', 'later'),
    { ...answer('child', 'child done'), isSidechain: true },
  ]));
  f.send({ prompt_id: undefined, last_assistant_message: 'first done' });
  assert.deepEqual(f.json('.latest').completedInputs, ['first']);
  assert.equal(existsSync(f.resultFile), false);
});

test('complete malformed records stay strict even after the bounded completed turn', t => {
  const f = fixture(t);
  writeFileSync(f.transcript, rows([user('first', 'first'), answer('a1', 'first done')]) + 'invalid JSON\n');
  assert.throws(() => f.send({ last_assistant_message: 'first done' }), SyntaxError);
  assert.equal(existsSync(`${f.resultFile}.latest`), false);
});
