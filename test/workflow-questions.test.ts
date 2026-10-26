/** Real question tool, notification delivery and reply routing through the Pi inbox. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import extension, { __test__ } from '../pi-extension/subagents/index.ts';
import childExtension from '../pi-extension/subagents/subagent-done.ts';
import { createStatusState } from '../pi-extension/subagents/status.ts';
import { createPiInbox, drainPiInbox } from '../pi-extension/subagents/control.ts';

it('question waits across delegated notifications, retries failed delivery, and resumes on a routed parent reply', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-question-'));
  const sessionFile = join(dir, 'child.jsonl');
  const keys = ['PI_SUBAGENT_SESSION', 'PI_SUBAGENT_NAME', 'PI_SUBAGENT_AGENT', 'PI_SUBAGENT_AUTO_EXIT'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const countKey = Symbol.for('pi-subagents/running-children-count');
  const oldCount = (globalThis as any)[countKey];
  t.after(() => {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    __test__.runningSubagents.delete('question-test');
    (globalThis as any)[countKey] = oldCount;
    rmSync(dir, { recursive: true, force: true });
  });
  const delivered: any[] = [];
  let unavailable = true;
  extension({ on() {}, registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    getAllTools: () => [], getThinkingLevel: () => 'off', sendMessage(message: any, options: any) {
      if (unavailable) throw new Error('Parent temporarily unavailable');
      delivered.push({ message, options });
    },
  } as any);
  (globalThis as any)[countKey] = () => 0;
  Object.assign(process.env, { PI_SUBAGENT_SESSION: sessionFile, PI_SUBAGENT_NAME: 'waiting-worker', PI_SUBAGENT_AGENT: 'worker', PI_SUBAGENT_AUTO_EXIT: '1' });
  const events = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  childExtension({ on(name: string, handler: Function) { events.set(name, [...(events.get(name) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerShortcut() {}, getAllTools: () => [],
  } as any);
  const emit = (name: string, event: any = {}, ctx: any = {}) => (events.get(name) ?? []).map(handler => handler(event, ctx));
  let exits = 0;
  const end = () => emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] }, { shutdown() { exits++; } });
  const running: any = { id: 'question-test', name: 'waiting-worker', agent: 'worker', task: 'task', surface: '%unit-test', startTime: Date.now(), sessionFile, statusState: createStatusState({ source: 'pi', startTimeMs: Date.now() }) };
  __test__.runningSubagents.set(running.id, running);
  emit('agent_start');
  assert.equal(emit('tool_call', {toolName:'ask_question',toolCallId:'ask'})[0], undefined);
  const sibling = emit('tool_call', {toolName:'subagent',toolCallId:'parallel-delegate'})[0];
  assert.equal(sibling?.block, true, 'a sibling tool must be blocked before ask_question execute has started');
  assert.match(sibling.reason, /NOT executed or queued/);
  await tools.get('ask_question').execute('ask', { question: 'Which token?' });
  assert.equal(JSON.parse(readFileSync(sessionFile + '.ask', 'utf8')).question, 'Which token?');
  end(); assert.equal(exits, 0);
  __test__.deliverPendingQuestion(running);
  assert.ok(existsSync(sessionFile + '.ask'), 'Failed notification must remain retryable');
  unavailable = false;
  __test__.deliverPendingQuestion(running);
  __test__.deliverPendingQuestion(running);
  assert.equal(delivered.length, 1, 'One notification per question');
  assert.deepEqual(delivered[0].options, { triggerTurn: true, deliverAs: 'steer' });
  assert.match(delivered[0].message.content, /subagent_message/);
  assert.equal(existsSync(sessionFile + '.ask'), false);
  // A delegated child result can start a turn, but it is not the parent's answer.
  emit('agent_start');
  const blocked = emit('tool_call', { toolName: 'bash' })[0];
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /NOT executed or queued/);
  assert.equal(emit('tool_call', { toolName: 'subagent' })[0]?.block, true);
  end(); assert.equal(exits, 0);
  let reply = '';
  let transformed: any;
  const images = [{ type: 'image', data: 'test-image', mimeType: 'image/png' }];
  createPiInbox(sessionFile, running.id);
  const result = await __test__.handleSubagentSteer({ name: 'waiting-worker', message: 'secret-token' });
  drainPiInbox(sessionFile, running.id, input => {
    reply = input.message; transformed = emit('input', { text: reply, images })[0]; emit('agent_start');
  });
  assert.equal(result.details.status, 'steered');
  assert.equal(reply, 'secret-token');
  assert.ok(transformed, 'reply must explain that blocked tool attempts never executed');
  assert.equal(transformed.action, 'transform');
  assert.ok(transformed.text.startsWith('secret-token'));
  assert.match(transformed.text, /"bash"/);
  assert.match(transformed.text, /"subagent"/);
  assert.match(transformed.text, /no result is pending/i);
  assert.match(transformed.text, /issue them again/);
  assert.equal(transformed.images, images, 'a reply transformation must retain attachments');
  assert.equal(emit('input', { text: 'ordinary follow-up' })[0], undefined, 'the notice is scoped to the pending question');
  assert.notEqual(emit('tool_call', { toolName: 'bash' })[0]?.block, true);
  end(); assert.equal(exits, 1, 'Reply completes the same child rather than leaving it parked');
  emit('tool_call', {toolName:'ask_question',toolCallId:'failed-ask'});
  assert.equal(emit('tool_call', {toolName:'read'})[0]?.block, true);
  emit('tool_result', {toolName:'ask_question',toolCallId:'older-ask',isError:true});
  assert.equal(emit('tool_call', {toolName:'read'})[0]?.block, true, 'an unrelated late error cannot clear a newer wait');
  emit('tool_result', {toolName:'ask_question',toolCallId:'failed-ask',isError:true});
  assert.notEqual(emit('tool_call', {toolName:'read'})[0]?.block, true, 'a failed question must release its reserved wait');
  // A question/reply already queued before Abort must not resurrect the step.
  await tools.get('ask_question').execute('ask-after', { question: 'Another question?' });
  writeFileSync(sessionFile + '.workflow-aborted', 'aborted');
  __test__.deliverPendingQuestion(running);
  assert.equal(delivered.length, 1, 'No stale question notification after Abort');
  const late = await __test__.handleSubagentSteer({ name: 'waiting-worker', message: 'late answer' });
  assert.match(late.details.error!, /aborted/);
});
