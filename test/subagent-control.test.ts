import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePiInbox, createPiInbox, drainPiInbox, piInbox, queuePiMessage, stopPiInbox, type PiInput } from '../pi-extension/subagents/control.ts';
import child from '../pi-extension/subagents/subagent-done.ts';
import { __test__ } from '../pi-extension/subagents/index.ts';

it('bursts preserve exact multiline inputs, repeated tasks, delivery modes and FIFO order', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-inbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  createPiInbox(file, 'launch');
  const expected: PiInput[] = Array.from({ length: 40 }, (_, i) => ({
    message: i < 2 ? 'identical task' : `line ${i}\n\n\`code $x; $(touch never)\`\n  中文🙂`,
    deliverAs: i % 2 ? 'followUp' : 'steer',
  }));
  for (const input of expected) queuePiMessage(file, 'launch', input);
  const actual: PiInput[] = [];
  assert.equal(drainPiInbox(file, 'launch', input => actual.push(input)), 40);
  assert.deepEqual(actual, expected);
  assert.equal(drainPiInbox(file, 'launch', () => assert.fail('inputs must be consumed once')), 0);
});

it('finalization accepts the last batch or rejects a late send, and never reuses an old launch', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-inbox-finish-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  createPiInbox(file, 'old');
  queuePiMessage(file, 'old', { message: 'last follow-up', deliverAs: 'followUp' });
  const inputs: PiInput[] = [];
  assert.equal(drainPiInbox(file, 'old', input => inputs.push(input), true), 1);
  queuePiMessage(file, 'old', { message: 'another turn', deliverAs: 'steer' });
  assert.equal(drainPiInbox(file, 'old', input => inputs.push(input), true), 1);
  assert.equal(drainPiInbox(file, 'old', () => assert.fail(), true), 0);
  assert.throws(() => queuePiMessage(file, 'old', { message: 'too late', deliverAs: 'steer' }), /ENOENT/);
  assert.deepEqual(readdirSync(piInbox(file, 'old')), ['closed']);
  createPiInbox(file, 'new');
  assert.equal(drainPiInbox(file, 'new', () => assert.fail()), 0);
  assert.deepEqual(inputs.map(input => input.message), ['last follow-up', 'another turn']);
});

it('cancelled sends and closed inboxes never submit input', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-inbox-cancel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  createPiInbox(file, 'launch');
  const controller = new AbortController(); controller.abort();
  assert.throws(() => queuePiMessage(file, 'launch', { message: 'cancelled', deliverAs: 'steer' }, controller.signal), /abort/i);
  assert.equal(drainPiInbox(file, 'launch', () => assert.fail()), 0);
  closePiInbox(file, 'launch');
  assert.throws(() => queuePiMessage(file, 'launch', { message: 'late', deliverAs: 'steer' }), /ENOENT/);
});

it('child drains inbox through Pi API at completion before exiting, and closes it on shutdown', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-inbox-child-'));
  const keys = ['PI_SUBAGENT_SESSION', 'PI_SUBAGENT_ID', 'PI_SUBAGENT_AUTO_EXIT'];
  const saved = keys.map(key => process.env[key]);
  t.after(() => {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, 'session.jsonl');
  Object.assign(process.env, { PI_SUBAGENT_SESSION: file, PI_SUBAGENT_ID: 'child', PI_SUBAGENT_AUTO_EXIT: '1' });
  createPiInbox(file, 'child');
  const handlers = new Map<string, Function[]>(), inputs: PiInput[] = [];
  child({ on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    registerTool() {}, registerShortcut() {}, sendUserMessage(message: string, options: any) { inputs.push({ message, ...options }); },
  } as any);
  let exits = 0;
  const finish = () => {
    handlers.get('agent_end')!.forEach(fn => fn({ messages: [{ role: 'assistant', stopReason: 'stop' }] }));
    handlers.get('agent_settled')!.forEach(fn => fn({ aborted: false }, { shutdown() { exits++; } }));
  };
  queuePiMessage(file, 'child', { message: 'next\n  code', deliverAs: 'followUp' });
  finish();
  assert.equal(exits, 0);
  assert.deepEqual(inputs, [{ message: 'next\n  code', deliverAs: 'followUp' }]);
  finish(); assert.equal(exits, 1);
  handlers.get('session_shutdown')!.forEach(fn => fn({ reason: 'quit' }));
  assert.throws(() => queuePiMessage(file, 'child', { message: 'after shutdown', deliverAs: 'steer' }), /ENOENT/);
});

it('native CLI followUp is rejected before any terminal input or metadata mutation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-inbox-native-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const cli of ['claude', 'codex']) {
    const running = { cli, sessionFile: join(dir, cli + '.jsonl'), surface: '%not-a-pane' } as any;
    const result = await __test__.steerSubagent(running, 'next', undefined, 'followUp');
    assert.match((result as any).error, /do not support followUp/);
  }
  assert.deepEqual(readdirSync(dir), []);
});

it('reloading a child keeps its launch inbox available; quitting closes it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-inbox-reload-'));
  const keys = ['PI_SUBAGENT_SESSION','PI_SUBAGENT_ID'];
  const saved = keys.map(key=>process.env[key]);
  t.after(()=>{
    keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];});
    rmSync(dir,{recursive:true,force:true});
  });
  const file=join(dir,'session.jsonl');
  Object.assign(process.env,{PI_SUBAGENT_SESSION:file,PI_SUBAGENT_ID:'reload'});
  createPiInbox(file,'reload');
  let shutdown: Function;
  child({on(name:string,fn:Function){if(name==='session_shutdown')shutdown=fn;},registerTool(){},registerShortcut(){}} as any);
  shutdown!({reason:'reload'});
  queuePiMessage(file,'reload',{message:'after reload',deliverAs:'steer'});
  const inputs:PiInput[]=[];
  drainPiInbox(file,'reload',input=>inputs.push(input));
  assert.deepEqual(inputs,[{message:'after reload',deliverAs:'steer'}]);
  shutdown!({reason:'quit'});
  assert.throws(()=>queuePiMessage(file,'reload',{message:'after quit',deliverAs:'steer'}),/ENOENT/);
});

it('durable stop blocks queued continuations before provider access and never reopens its launch inbox', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-inbox-stopped-'));
  const file = join(dir, 'session.jsonl');
  const keys = ['PI_SUBAGENT_SESSION', 'PI_SUBAGENT_ID'];
  const saved = keys.map(key => process.env[key]);
  t.after(() => {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    rmSync(dir, { recursive: true, force: true });
  });
  Object.assign(process.env, { PI_SUBAGENT_SESSION: file, PI_SUBAGENT_ID: 'stopped' });
  const handlers = new Map<string, Function[]>();
  child({ on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    registerTool() {}, registerShortcut() {},
  } as any);
  createPiInbox(file, 'stopped');
  queuePiMessage(file, 'stopped', { message: 'previously accepted follow-up', deliverAs: 'followUp' });
  const queued: PiInput[] = [];
  drainPiInbox(file, 'stopped', input => queued.push(input));
  assert.equal(queued.length, 1, 'simulate a continuation already inside the SDK queue');
  stopPiInbox(file, 'stopped');
  let aborts = 0, shutdowns = 0;
  const ctx = { abort() { aborts++; }, shutdown() { shutdowns++; } };
  for (const name of ['before_agent_start', 'agent_start']) handlers.get(name)!.forEach(fn => fn({}, ctx));
  assert.throws(() => handlers.get('before_provider_request')!.forEach(fn => fn({}, ctx)), /no provider request/);
  assert.equal(aborts, 3);
  assert.equal(shutdowns, 0, 'the child parks until its owner captures and closes the process tree');
  assert.deepEqual(handlers.get('input')![0]({ text: 'late reply' }, ctx), { action: 'handled' });
  assert.equal(drainPiInbox(file, 'stopped', () => assert.fail('stopped inbox cannot deliver')), 0);
  assert.throws(() => createPiInbox(file, 'stopped'), /explicitly stopped/);
  createPiInbox(file, 'new-launch');
  queuePiMessage(file, 'new-launch', { message: 'deliberate new task', deliverAs: 'steer' });
  assert.equal(drainPiInbox(file, 'new-launch', () => {}), 1);
});
