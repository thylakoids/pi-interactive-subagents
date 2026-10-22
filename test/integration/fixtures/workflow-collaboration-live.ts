/** Root, worker and delegated scout all use real models and production messaging. */
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import extension, { __test__ } from '../../../pi-extension/subagents/index.ts';
import { WorkflowManager, type WorkflowRun } from '../../../pi-extension/subagents/workflow/manager.ts';
import { getSessionId, readNameRegistry, readSubagentLoadout } from '../../../pi-extension/subagents/session.ts';
import { surfaceExists } from '../../../pi-extension/subagents/tmux.ts';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(100); }
  throw new Error('Timed out: ' + label);
}
const rows = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const calls = (file: string) => rows(file).flatMap(row => row.message?.role === 'assistant' ? row.message.content.filter((p: any) => p.type === 'toolCall') : []);

export default function collaboration(pi: any) {
  extension(pi);
  const dir = process.env.PI_WORKFLOW_LIVE_DIR!;
  const token = randomBytes(12).toString('hex'); // Only the root model receives it.
  const event = (name: string, data: unknown = {}) => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ at: Date.now(), event: name, data }) + '\n');
  const save = (name: string, value: unknown) => writeFileSync(join(dir, name + '.json'), JSON.stringify(value, null, 2));
  let manager: WorkflowManager;
  let run: WorkflowRun;
  let started = false;
  const observed = new Set<string>();
  const replies: any[] = [];
  let lateReplyRejected = false;
  pi.on('session_start', () => writeFileSync(join(dir, 'ready'), 'ready'));
  pi.on('session_shutdown', () => manager?.abortAll('live collaboration cleanup'));
  pi.on('message_end', (e: any) => {
    if (e.message?.customType === 'subagent_question') event('parent-received-question', e.message.details);
  });
  pi.on('tool_result', (e: any) => {
    if (e.toolName === 'subagent_message' && /aborted/i.test(e.details?.error ?? '')) { lateReplyRejected = true; event('late-reply-rejected', e.details); }
  });
  pi.on('tool_call', (e: any) => {
    if (e.toolName === 'subagent_message') { replies.push(e.input); event('parent-reply-tool-call', e.input); }
  });
  pi.registerTool({
    name: 'live_parent_observe', label: 'Observe waiting workflow child',
    description: 'Live test: call before replying to a subagent_question. For ABORT_CASE it aborts the waiting workflow; then attempt one late reply to verify it is rejected.',
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id: string, input: any) {
      const running = [...__test__.runningSubagents.values()].find(child => child.name === input.name);
      assert.ok(running, 'Question must belong to a real running child');
      await until(() => (globalThis as any).__pi_interactive_subagents.workflow.status(input.name)?.kind === 'waiting', 'child parks waiting for parent', 45_000);
      assert.equal(run.view().status, 'running');
      assert.equal(run.view().calls[0].status, 'running');
      assert.equal(surfaceExists(running.surface), true);
      observed.add(input.name);
      save(run.meta.name + '-waiting', run.view());
      event('waiting-proven', { name: input.name, runId: run.runId });
      if (run.meta.name === 'live-question-abort') {
        run.abort('Abort while waiting for parent');
        assert.equal(surfaceExists(running.surface), false);
        event('waiting-abort', { name: input.name, runId: run.runId });
        return { content: [{ type: 'text', text: 'Aborted while waiting. Now attempt exactly one subagent_message to this same name with message late reply. It must be rejected; do not resume, Focus or retry.' }] };
      }
      await until(() => rows(running.sessionFile).some(row => row.message?.role === 'toolResult'
        && row.message.toolName === 'subagent' && JSON.stringify(row.message.content).includes('NOT executed or queued')),
      'early delegation is rejected before the parent replies', 45_000);
      event('blocked-delegation-proven', { name: input.name });
      return { content: [{ type: 'text', text: 'Waiting confirmed. Now use subagent_message to send the secret token from your instructions.' }] };
    },
  });
  const body = (name: string, task: string) => 'export const meta = ' + JSON.stringify({ name, description: 'Live collaborative workflow' }) + '\nreturn await agent(' + JSON.stringify(task) + ', {label:"collaborator"});';
  async function probe(ctx: any) {
    try {
      const options = { baseDir: join(dir, 'artifacts'), cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME!, '.pi', 'agent'), sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId(), service: (globalThis as any).__pi_interactive_subagents.workflow };
      manager = new WorkflowManager(options);
      run = await manager.start({ source: body('live-question-reply', 'First call ask_question with exactly: REPLY_CASE: What is the verification token? You do not know it; do not inspect parent sessions or guess. Immediately after asking, deliberately attempt subagent to delegate to scout named delegate-proof: read fixture.txt and return its exact contents. Include the task context explicitly. This early attempt intentionally probes the runtime waiting gate before the parent reply; it must be rejected. Then stop and wait for the parent response. After receiving the token, follow the runtime notice about blocked calls and obtain the actual scout result; do not do its work yourself. Only after receiving both the parent token and scout result, use bash to write the token to answered.txt, then return the token and the scout result as your final value.'), args: {}, reuse: 'none' });
      event('reply-run-start', { runId: run.runId });
      const replied = await run.execute();
      save('replied', replied);
      assert.equal(replied.status, 'completed', replied.error);
      const call = replied.calls[0];
      assert.ok(observed.has(call.name!));
      assert.ok(replies.some(reply => reply.name === call.name && reply.message.includes(token)), 'Root model must use the real reply tool');
      assert.equal(readFileSync(join(dir, 'answered.txt'), 'utf8').trim(), token);
      assert.match(String(replied.result), new RegExp(token));
      assert.match(String(replied.result), /SCOUT_READ_OK/);
      const workerCalls = calls(call.sessionFile!);
      assert.equal(workerCalls[0].name, 'ask_question', 'No work before asking for the missing token');
      assert.ok(workerCalls.some(part => part.name === 'subagent' && part.arguments.agent === 'scout'));
      const workerEntries = rows(call.sessionFile!);
      assert.ok(workerEntries.some(row => row.message?.role === 'user' && JSON.stringify(row.message.content).includes(token)), 'Reply must enter the same live session');
      const replyIndex = workerEntries.findIndex(row => row.message?.role === 'user'
        && JSON.stringify(row.message.content).includes(token) && JSON.stringify(row.message.content).includes('[Runtime note:'));
      assert.ok(replyIndex >= 0, 'the parent reply must explain that the early delegate was not started');
      assert.ok(workerEntries.slice(replyIndex + 1).some(row => row.message?.role === 'assistant'
        && Array.isArray(row.message.content) && row.message.content.some((part: any) => part.type === 'toolCall' && part.name === 'subagent')),
      'the model must actually reissue delegation after the reply, not wait for a nonexistent child');
      const registry = readNameRegistry(join(dirname(call.sessionFile!), 'artifacts', getSessionId(call.sessionFile!)!));
      const scout = Object.values(registry).find((entry: any) => readSubagentLoadout(entry.sessionFile)?.agent === 'scout') as any;
      assert.ok(scout, 'A real delegated scout session must exist');
      assert.ok(calls(scout.sessionFile).some(part => part.name === 'read'));
      save('delegated', { ...scout, entries: rows(scout.sessionFile).length });
      event('reply-and-delegation-passed');

      run = await manager.start({ source: body('live-question-abort', 'Call ask_question with exactly: ABORT_CASE: May I continue? Then stop and wait for your parent. Do not write forbidden-after-abort.txt, do not delegate, and do not invent an answer.'), args: {}, reuse: 'none' });
      event('abort-run-start', { runId: run.runId });
      const aborted = await run.execute();
      save('aborted', aborted);
      assert.equal(aborted.status, 'aborted');
      assert.equal(aborted.progress, 1);
      assert.equal(aborted.calls[0].status, 'aborted');
      assert.ok(observed.has(aborted.calls[0].name!));
      await until(() => lateReplyRejected, 'real parent late-reply tool is rejected after Abort', 60_000);
      assert.ok(replies.some(reply => reply.name === aborted.calls[0].name));
      assert.equal(existsSync(join(dir, 'forbidden-after-abort.txt')), false);
      await until(() => ![...__test__.runningSubagents.values()].some(child => child.name === aborted.calls[0].name), 'aborted waiter is unregistered');
      const disk = new WorkflowManager(options).inspect(run.runId)!;
      assert.equal(disk.status, 'aborted');
      assert.equal(disk.calls[0].status, 'aborted');
      // Delayed replies cannot resurrect an explicitly cancelled workflow step.
      const late = await (globalThis as any).__pi_interactive_subagents.workflow.steer(aborted.calls[0].name!, 'late reply');
      assert.ok('error' in late);
      const rootCalls = calls(options.sessionFile);
      assert.ok(rootCalls.some(part => part.name === 'live_parent_observe'));
      assert.ok(rootCalls.some(part => part.name === 'subagent_message' && part.arguments.message.includes(token)));
      for (const file of [options.sessionFile, call.sessionFile!, scout.sessionFile, aborted.calls[0].sessionFile!]) {
        assert.ok(rows(file).some(row => row.message?.role === 'assistant' && (row.message.usage?.input > 0 || row.message.usage?.output > 0)), 'Every actor must have real provider responses');
      }
      save('report', { ok: true, token, parentSession: options.sessionFile, workerSession: call.sessionFile, scoutSession: scout.sessionFile, abortedSession: aborted.calls[0].sessionFile, replies, checks: ['real-parent-reply', 'same-session-continuation', 'real-scout-delegation', 'waiting-state', 'abort-while-waiting', 'disk-terminal-state', 'late-reply-rejected', 'blocked-delegation-retry'] });
      event('all-passed');
    } catch (error: any) {
      manager?.abortAll('collaboration test failure');
      save('report', { ok: false, error: error?.stack ?? String(error) });
      event('failed', { error: String(error) });
    }
  }
  pi.registerTool({ name: 'live_begin', label: 'Start live collaboration probe', description: 'Start the requested live workflow test once, then wait for subagent questions.', parameters: Type.Object({}),
    async execute(_id: string, _input: any, _signal: any, _update: any, ctx: any) {
      assert.equal(started, false); started = true;
      void probe(ctx);
      return { content: [{ type: 'text', text: 'Workflow started. End your turn and wait for questions; do not poll.' }] };
    },
  });
  pi.registerCommand('live-collaboration', { description: 'Start real-model collaboration probes', handler: async () => {
    pi.sendUserMessage('Run the live collaboration test. Your secret verification token is ' + token + '. Call live_begin exactly once now, then end your turn. When a subagent_question containing REPLY_CASE arrives, first call live_parent_observe with its exact name, then reply using subagent_message with this secret token. When a question containing ABORT_CASE arrives, call live_parent_observe to Abort it, then attempt exactly one subagent_message to that name with message late reply as a cancellation-safety probe. It must be rejected. Do NOT retry, Focus, resume or create another agent. Do not perform child work, read files, inspect sessions, poll, or call any tools except live_begin, live_parent_observe and subagent_message.');
  } });
}
