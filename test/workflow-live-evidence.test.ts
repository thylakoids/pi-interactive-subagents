import { it } from 'node:test';
import assert from 'node:assert/strict';
import { findVerificationProbeResult, hasPassingGuardOutput, isCacheEffectCommand, isSkipIoCommand, isStallRecoveryCommand } from './integration/live-evidence.ts';

const command = 'if test -f first.pid; then printf recovered >> recovered; else printf "%s" "$$" > first.pid; sleep 90; printf leaked > leaked; fi';

it('live evidence counts the blocking recovery command rather than a preliminary marker inspection', () => {
  const observation = { type: 'toolCall', name: 'bash', arguments: { command: 'ls -la; cat first.pid 2>/dev/null; cat recovered 2>/dev/null' } };
  const blocking = { type: 'toolCall', name: 'bash', arguments: { command } };
  assert.equal(isStallRecoveryCommand(observation), false);
  assert.equal(isStallRecoveryCommand(blocking), true);
  assert.equal([observation, blocking].filter(isStallRecoveryCommand).length, 1);
});

it('live evidence never counts prose, system descriptions or other tool types as bash execution', () => {
  for (const value of [undefined, {}, { type: 'text', text: command }, { type: 'text', name: 'bash', arguments: { command } }, { type: 'toolCall', name: 'read', arguments: { command } }]) {
    assert.equal(isStallRecoveryCommand(value), false);
  }
});

it('cache evidence counts actual appends rather than inspections of cache-effects', () => {
  const tool = (command: string) => ({type:'toolCall',name:'bash',arguments:{command}});
  const inspection = tool('ls -la; cat cache-effects 2>/dev/null');
  const append = tool("printf 'effect\\n' >> cache-effects; echo exit=$?; od -c cache-effects");
  assert.equal(isCacheEffectCommand(inspection), false);
  assert.equal(isCacheEffectCommand(append), true);
  assert.equal(isCacheEffectCommand(tool("printf 'effect\\\\n' >> cache-effects")), true);
  assert.equal([inspection, append].filter(isCacheEffectCommand).length, 1);
});

it('cache evidence rejects prose and unrelated writes even when they mention the marker', () => {
  for (const call of [undefined, {}, {type:'text',name:'bash',arguments:{command:"printf 'effect\\n' >> cache-effects"}},
    {type:'toolCall',name:'read',arguments:{command:"printf 'effect\\n' >> cache-effects"}},
    {type:'toolCall',name:'bash',arguments:{command:'echo cache-effects'}},
    {type:'toolCall',name:'bash',arguments:{command:"printf 'effect\\n' >> cache-effects-copy"}}]) {
    assert.equal(isCacheEffectCommand(call), false);
  }
});

it('Skip evidence requires the complete foreground wait sequence but permits trailing inspections', () => {
  const tool = (command: string) => ({type:'toolCall',name:'bash',arguments:{command}});
  const command = 'echo STARTED > skip-io-started; sleep 5; echo ESCAPED > skip-io-escaped';
  assert.equal(isSkipIoCommand(tool(command)), true);
  assert.equal(isSkipIoCommand(tool(command + '; ls -l skip-io-started skip-io-escaped')), true);
  assert.equal(isSkipIoCommand(tool(command.replaceAll('; ', '\n'))), true);
  for (const value of [undefined, {}, {type:'text',text:command}, {type:'toolCall',name:'read',arguments:{command}},
    tool('echo STARTED > skip-io-started'), tool(command.replace('sleep 5;', 'sleep 5 &;')), tool(command + ' &')]) {
    assert.equal(isSkipIoCommand(value), false);
  }
});

it('sandbox evidence selects the actual probe result rather than an unrelated successful inspection', () => {
  const call = (id: string, command: string) => ({type:'toolCall',name:'verify_command',id,arguments:{command}});
  const result = (id: string, exitCode: number, extra = {}) => ({message:{role:'toolResult',toolName:'verify_command',toolCallId:id,
    details:{ok:true,exitCode,timedOut:false,cancelled:false,...extra}}});
  const calls = [call('inspect', 'ls -la; cat guard.test.cjs'), call('test', 'node --test guard.test.cjs'),
    call('write', `node -e "require('node:fs').writeFileSync('protected.txt','tampered')"`),
    call('fifo-inspect', 'ls -l restricted.fifo'), call('fifo', 'printf unexpected > restricted.fifo')];
  const inspection = result('inspect', 0), passed = result('test', 0), denied = result('write', 1), fifo = result('fifo', 2);
  const results = [inspection, denied, result('fifo-inspect', 0), fifo, passed];
  assert.equal(findVerificationProbeResult(calls, results, 'test'), passed);
  assert.equal(findVerificationProbeResult(calls, results, 'write'), denied);
  assert.equal(findVerificationProbeResult(calls, results, 'fifo'), fifo);
  assert.equal(findVerificationProbeResult(calls, [inspection], 'test'), undefined);
  for (const extra of [{ok:false}, {timedOut:true}, {cancelled:true}]) {
    assert.equal(findVerificationProbeResult(calls, [result('write', 1, extra)], 'write'), undefined);
  }
});

it('sandbox TAP evidence never treats not ok or a mixed failing run as a pass', () => {
  assert.equal(hasPassingGuardOutput('TAP version 13\nok 1 - guard\n# pass 1\n# fail 0\n'), true);
  assert.equal(hasPassingGuardOutput('not ok 1 - guard\n# pass 0\n# fail 1\n'), false);
  assert.equal(hasPassingGuardOutput('ok 1 - guard\nnot ok 2 - extra\n# pass 1\n# fail 1\n'), false);
  assert.equal(hasPassingGuardOutput('echo "# pass 1"'), false);
});
