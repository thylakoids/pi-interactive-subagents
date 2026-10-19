import { it } from 'node:test';
import assert from 'node:assert/strict';
import { isStallRecoveryCommand } from './integration/live-evidence.ts';

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
