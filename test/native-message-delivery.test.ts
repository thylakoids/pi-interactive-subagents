import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension, { __test__ } from '../pi-extension/subagents/index.ts';
import { handleCliEvent } from '../pi-extension/subagents/cli-hook.mjs';
import { createStatusState } from '../pi-extension/subagents/status.ts';
import { createWorkflowSubagentService } from '../pi-extension/subagents/wiring.ts';

/** Substitute only filesystem failures and tmux commands, never production functions. */
async function nativeFixture(t: TestContext, cli: 'claude' | 'codex', fault: string, run: (f: any) => Promise<void>) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'pi-message-delivery-'));
  const sessionFile = join(dir, 'session.jsonl'), resultFile = join(dir, 'result.json');
  const inputsFile = resultFile + '.inputs.json';
  const original = { read: fs.readFileSync, write: fs.writeFileSync, append: fs.appendFileSync,
    rename: fs.renameSync, mkdir: fs.mkdirSync, rmdir: fs.rmdirSync };
  const previousTmux = process.env.TMUX;
  const f = { dir, sessionFile, resultFile, inputsFile, fault, writes: 0,
    commands: [] as string[], submitted: [] as string[], payload: '',
    running: { id: dir, name: 'native-delivery', cli, task: 'initial', sessionFile,
      sentinelFile: resultFile, surface: '%delivery-test', startTime: Date.now(),
      statusState: createStatusState({ source: cli, startTimeMs: Date.now() }) },
    ledger: () => JSON.parse(original.read(inputsFile, 'utf8')) as string[],
    ledgerText: () => original.read(inputsFile, 'utf8'),
    send: (message = 'follow-up', signal?: AbortSignal, deliverAs?: 'steer' | 'followUp') =>
      __test__.steerSubagent(f.running as any, message, signal, deliverAs),
    complete(inputs: string[], turn: string) {
      handleCliEvent(cli, sessionFile, resultFile, 'auto', cli === 'codex'
        ? { type: 'agent-turn-complete', 'thread-id': 'native', 'turn-id': turn,
          'input-messages': inputs, 'last-assistant-message': turn }
        : { hook_event_name: 'Stop', session_id: 'native', prompt_id: turn, last_assistant_message: turn },
      { inputs: inputs.map((text, i) => ({ id: turn + '-' + i, text })), summary: turn, flushed: true });
    },
  };
  const eio = () => Object.assign(new Error('injected ' + f.fault), { code: 'EIO' });
  try {
    original.write(sessionFile, JSON.stringify({ type: 'session', id: 'parent' }) + '\n');
    original.write(sessionFile + '.cli.json', JSON.stringify({ kind: cli, nativeId: 'native' }));
    original.write(inputsFile, JSON.stringify(['initial']));
    process.env.TMUX = 'delivery-test-no-real-server';
    t.mock.method(childProcess, 'execFileSync', (command: string, args: string[], options: any) => {
      if (command === 'sh') return '';
      assert.equal(command, 'tmux', 'the fixture must never execute a real subprocess');
      const step = args[0];
      f.commands.push(step);
      if (step === 'load-buffer') {
        if (f.fault === 'load' || f.fault === 'rollback') throw eio();
        f.payload = options.input;
      }
      if (step === 'paste-buffer') {
        assert.ok(fs.existsSync(resultFile + '.lock'), 'the hook cannot complete during delivery');
        assert.equal(f.ledger().at(-1), f.payload, 'persist the actual transport prompt before pane input');
        if (f.fault === 'paste') throw eio();
      }
      if (step === 'send-keys') {
        if (f.fault === 'enter-before') throw eio();
        f.submitted.push(f.payload);
        if (f.fault === 'enter-after') throw eio();
      }
      // paste-buffer -d already deleted the buffer; cleanup cannot mask delivery.
      if (step === 'delete-buffer') throw new Error('buffer already deleted');
      return '';
    });
    t.mock.method(fs, 'readFileSync', (path: any, ...args: any[]) => {
      if (f.fault === 'read' && path === inputsFile) throw eio();
      return (original.read as any)(path, ...args);
    });
    t.mock.method(fs, 'writeFileSync', (path: any, ...args: any[]) => {
      if (typeof path === 'string' && path.startsWith(inputsFile + '.tmp-')) {
        f.writes++;
        if (f.fault === 'write') {
          original.write(path, '["partial');
          throw eio();
        }
      }
      return (original.write as any)(path, ...args);
    });
    t.mock.method(fs, 'renameSync', (from: any, to: any) => {
      if (to === inputsFile && (f.fault === 'rename' || (f.fault === 'rollback' && f.writes === 2))) throw eio();
      return original.rename(from, to);
    });
    t.mock.method(fs, 'appendFileSync', (path: any, ...args: any[]) => {
      if (f.fault === 'append' && path === sessionFile) throw eio();
      return (original.append as any)(path, ...args);
    });
    t.mock.method(fs, 'mkdirSync', (path: any, ...args: any[]) => {
      if (f.fault === 'lock' && path === resultFile + '.lock') throw eio();
      return (original.mkdir as any)(path, ...args);
    });
    t.mock.method(fs, 'rmdirSync', (path: any, ...args: any[]) => {
      if (f.fault === 'unlock' && path === resultFile + '.lock') throw eio();
      return (original.rmdir as any)(path, ...args);
    });
    syncBuiltinESMExports();
    await run(f);
  } finally {
    __test__.runningSubagents.delete(f.running.id);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

it('ledger read, partial write, rename and validation failures never reach the terminal', async t => {
  for (const cli of ['claude', 'codex'] as const) {
    for (const fault of ['read', 'write', 'rename', 'syntax', 'object', 'element']) {
      await nativeFixture(t, cli, fault, async f => {
        if (fault === 'syntax') fs.writeFileSync(f.inputsFile, '{broken');
        if (fault === 'object') fs.writeFileSync(f.inputsFile, '{}');
        if (fault === 'element') fs.writeFileSync(f.inputsFile, '["initial", 1]');
        const before = f.ledgerText();
        const result = await f.send();
        assert.equal(result.delivery, 'not_sent', cli + ' ' + fault);
        assert.equal(result.retrySafe, true);
        assert.deepEqual(f.commands, []);
        assert.equal(f.ledgerText(), before, 'failed reservation preserves the old ledger');
        assert.ok(!fs.readdirSync(f.dir).some((name: string) => name.includes('.tmp-')));
        if (['read', 'write', 'rename'].includes(fault)) {
          f.fault = 'none';
          assert.deepEqual(await f.send(), { ok: true });
          assert.equal(f.submitted.length, 1, 'retry after a confirmed unsent attempt submits exactly once');
        }
      });
    }
  }
});

it('terminal command failures distinguish unsent input from uncertain submission', async t => {
  for (const cli of ['claude', 'codex'] as const) {
    for (const fault of ['load', 'paste', 'enter-before', 'enter-after']) {
      await nativeFixture(t, cli, fault, async f => {
        const result = await f.send();
        const unsent = fault === 'load';
        assert.equal(result.delivery, unsent ? 'not_sent' : 'unknown');
        assert.equal(result.retrySafe, unsent);
        assert.equal(f.ledger().length, unsent ? 1 : 2);
        assert.equal(f.submitted.length, fault === 'enter-after' ? 1 : 0);
        assert.equal(f.commands.includes('send-keys'), fault.startsWith('enter'));
        if (unsent) {
          f.fault = 'none';
          assert.deepEqual(await f.send(), { ok: true });
          assert.equal(f.submitted.length, 1);
        } else assert.match(result.error, /Do not automatically resend/);
      });
    }
  }
});

it('uncertain submissions remain pending until the native hook acknowledges them', async t => {
  for (const cli of ['claude', 'codex'] as const) {
    await nativeFixture(t, cli, 'enter-after', async f => {
      const result = await f.send();
      assert.equal(result.delivery, 'unknown');
      f.fault = 'none';
      f.complete(['initial'], 'initial-turn');
      assert.equal(fs.existsSync(f.resultFile), false, 'an earlier turn cannot close a submitted follow-up');
      f.complete([f.ledger()[1]], 'follow-up-turn');
      assert.equal(JSON.parse(fs.readFileSync(f.resultFile, 'utf8')).summary, 'follow-up-turn');
    });
  }
});

it('transcript and lock-release failures preserve sent evidence and completion tracking', async t => {
  for (const cli of ['claude', 'codex'] as const) {
    for (const fault of ['append', 'unlock']) await nativeFixture(t, cli, fault, async f => {
      const result = await f.send();
      assert.equal(result.delivery, 'sent');
      assert.equal(result.retrySafe, false);
      assert.match(result.error, /Do not automatically resend/);
      assert.equal(f.submitted.length, 1);
      assert.equal(f.ledger().length, 2);
      f.fault = 'none';
      if (fs.existsSync(f.resultFile + '.lock')) fs.rmdirSync(f.resultFile + '.lock');
      f.complete(['initial'], 'initial-turn');
      assert.equal(fs.existsSync(f.resultFile), false);
      f.complete([f.ledger()[1]], 'follow-up-turn');
      assert.equal(JSON.parse(fs.readFileSync(f.resultFile, 'utf8')).summary, 'follow-up-turn');
    });
  }
});

it('failed rollback is unsent but unsafe to retry, and cannot allow premature completion', async t => {
  await nativeFixture(t, 'codex', 'rollback', async f => {
    const result = await f.send();
    assert.equal(result.delivery, 'not_sent');
    assert.equal(result.retrySafe, false);
    assert.match(result.error, /tracking could not be restored.*Do not automatically retry/);
    assert.equal(f.submitted.length, 0);
    assert.equal(f.ledger().length, 2);
    f.fault = 'none';
    f.complete(['initial'], 'initial-turn');
    assert.equal(fs.existsSync(f.resultFile), false);
  });
});

it('completed runs, unsupported delivery, cancellation and lock errors do not mutate inputs', async t => {
  for (const fault of ['completed', 'followUp', 'abort', 'waiting-abort', 'lock', 'no-tmux']) {
    await nativeFixture(t, 'claude', fault, async f => {
      const controller = new AbortController();
      if (fault === 'completed') fs.writeFileSync(f.resultFile, '{}');
      if (fault === 'abort') controller.abort();
      if (fault === 'waiting-abort') {
        fs.mkdirSync(f.resultFile + '.lock');
        setImmediate(() => controller.abort());
      }
      if (fault === 'no-tmux') delete process.env.TMUX;
      const result = await f.send('follow-up', controller.signal, fault === 'followUp' ? 'followUp' : 'steer');
      assert.equal(result.delivery, 'not_sent', fault);
      assert.equal(result.retrySafe, true);
      assert.deepEqual(f.commands, []);
      assert.deepEqual(f.ledger(), ['initial']);
      assert.equal(fs.readFileSync(f.sessionFile, 'utf8').trim().split('\n').length, 1);
    });
  }
});

it('public tool and workflow service preserve error evidence and visible no-retry guidance', async t => {
  for (const cli of ['claude', 'codex'] as const) await nativeFixture(t, cli, 'append', async f => {
    const tools = new Map<string, any>();
    extension({ on() {}, registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {} } as any);
    __test__.runningSubagents.set(f.running.id, f.running as any);
    const result = await tools.get('subagent_message').execute('message', { name: f.running.name, message: 'public-tool' },
      new AbortController().signal, undefined, {});
    assert.equal(result.details.delivery, 'sent');
    assert.equal(result.details.retrySafe, false);
    assert.equal(result.details.id, f.running.id);
    assert.match(result.content[0].text, /Do not automatically resend/);
    const service = createWorkflowSubagentService({ resolveRunning: () => ({ running: f.running }),
      steer: __test__.steerSubagent } as any);
    const workflowResult = await service.steer(f.running.name, 'workflow-service');
    assert.equal((workflowResult as any).delivery, 'sent');
    assert.equal((workflowResult as any).retrySafe, false);
    assert.equal(f.submitted.length, 2, 'two different explicit messages are two submissions');
  });
});

it('successful repeated messages remain distinct and complete only after both acknowledgements', async t => {
  for (const cli of ['claude', 'codex'] as const) await nativeFixture(t, cli, 'none', async f => {
    const message = 'same message\n\n  中文🙂 $x; $(touch never)';
    assert.deepEqual(await f.send(message), { ok: true });
    assert.deepEqual(await f.send(message), { ok: true });
    const inputs = f.ledger();
    assert.equal(f.submitted.length, 2);
    assert.deepEqual(f.submitted, inputs.slice(1));
    if (cli === 'codex') assert.notEqual(inputs[1], inputs[2]);
    else assert.deepEqual(inputs.slice(1), [message, message]);
    const users = fs.readFileSync(f.sessionFile, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line))
      .filter((entry: any) => entry.message?.role === 'user');
    assert.deepEqual(users.map((entry: any) => entry.message.content[0].text), [message, message]);
    f.complete(['initial'], 'initial-turn');
    f.complete([inputs[1]], 'first-repeat');
    assert.equal(fs.existsSync(f.resultFile), false);
    f.complete([inputs[2]], 'second-repeat');
    assert.equal(JSON.parse(fs.readFileSync(f.resultFile, 'utf8')).summary, 'second-repeat');
  });
});
