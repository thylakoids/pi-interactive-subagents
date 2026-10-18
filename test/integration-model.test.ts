import { it } from 'node:test';
import assert from 'node:assert/strict';
import { integrationModel } from './integration/model.ts';
import { integrationRuntime } from './integration/runtime.ts';
import { delimiter } from 'node:path';

it('billed tests require an explicit model rather than a hardcoded provider', () => {
  assert.throws(() => integrationModel(undefined, ''), /Set PI_TEST_MODEL/);
  assert.equal(integrationModel(undefined, ' selected/model '), 'selected/model');
  assert.equal(integrationModel('override/model', 'selected/model'), 'override/model');
});

it('npm integration and direct execution select the same Pi runtime', () => {
  const userPath = ['/user/bin', '/usr/bin'].join(delimiter);
  assert.deepEqual(integrationRuntime({ PATH: ['/repo/node_modules/.bin', userPath].join(delimiter) }),
    integrationRuntime({ PATH: userPath }));
  assert.deepEqual(integrationRuntime({ PATH: userPath, PI_TEST_PI: '/chosen/bin/pi' }),
    { executable: '/chosen/bin/pi', path: ['/chosen/bin', userPath].join(delimiter) });
});
