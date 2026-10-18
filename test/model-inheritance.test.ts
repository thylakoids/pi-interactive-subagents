/** Exercise real definition loading, session-model events and launch arguments. */
import { before, after, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension, { __test__ } from '../pi-extension/subagents/index.ts';

let dir: string;
const cwd = process.cwd();
const originalConfig = process.env.PI_CODING_AGENT_DIR;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-model-inheritance-'));
  mkdirSync(join(dir, 'config', 'agents'), { recursive: true });
  mkdirSync(join(dir, '.pi', 'agents'), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(dir, 'config');
  process.chdir(dir);
});
after(() => {
  process.chdir(cwd);
  if (originalConfig === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalConfig;
  rmSync(dir, { recursive: true, force: true });
});

function parent() {
  let model = { provider: 'parent-provider', id: 'first-model' };
  const events = new Map<string, Array<(...args: any[]) => void>>();
  extension({
    on(name: string, handler: (...args: any[]) => void) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler); events.set(name, handlers);
    },
    getThinkingLevel: () => 'off',
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
    getAllTools: () => [],
  } as any);
  for (const handler of events.get('session_start') ?? []) handler({ type: 'session_start' }, { model });
  return {
    clearModel() {
      for (const handler of events.get('session_start') ?? []) handler({ type: 'session_start' }, { model: undefined });
    },
    switchModel() {
      model = { provider: 'other-provider', id: 'second-model' };
      assert.ok(events.get('model_select')?.length, 'Must use the real model-select hook');
      for (const handler of events.get('model_select')!) handler({ model }, { model: { provider: 'stale-provider', id: 'old-model' } });
    },
  };
}

function launchArgs(model: string | undefined) {
  const parts: string[] = [];
  __test__.applySandboxToParts(parts, {
    agent: 'worker', model: model ?? null, thinking: null,
    toolAllowlist: null, systemPromptMode: null, identity: null,
    spawnable: null, autoExit: true, cwd: null, agentDir: null,
  }, { artifactDir: dir, name: 'inheritance' });
  return parts.join(' ');
}

it('all bundled Pi definitions omit model and produce parent-model launch flags', () => {
  parent();
  for (const name of ['worker', 'scout', 'researcher', 'workflow-subagent']) {
    const definition = __test__.loadAgentDefaults(name)!;
    assert.ok(definition, name);
    assert.equal(definition.model, undefined, name + ' must not pin a bundled model');
    const resolved = __test__.resolveAgentModel(undefined, definition.model);
    assert.equal(resolved, 'parent-provider/first-model');
    assert.match(launchArgs(resolved), /--model.*parent-provider\/first-model/);
  }
});

it('new children follow a model switch without overriding explicit models', () => {
  const session = parent();
  assert.equal(__test__.resolveAgentModel(), 'parent-provider/first-model');
  session.switchModel();
  assert.equal(__test__.resolveAgentModel(), 'other-provider/second-model');
  assert.match(launchArgs(__test__.resolveAgentModel()), /--model.*other-provider\/second-model/);
  assert.equal(__test__.resolveAgentModel(undefined, 'user/pinned'), 'user/pinned');
  assert.equal(__test__.resolveAgentModel('call/override', 'user/pinned'), 'call/override');
});

it('user global/project definitions and call overrides retain their precedence without rewriting files', t => {
  const session = parent();
  const global = join(dir, 'config', 'agents', 'worker.md');
  const project = join(dir, '.pi', 'agents', 'worker.md');
  const globalSource = '---\nname: worker\nmodel: user/global-model\n---\nUser global identity.\n';
  const projectSource = '---\nname: worker\nmodel: user/project-model\n---\nUser project identity.\n';
  t.after(() => { rmSync(global, { force: true }); rmSync(project, { force: true }); });
  writeFileSync(global, globalSource);
  let definition = __test__.loadAgentDefaults('worker')!;
  assert.equal(__test__.resolveAgentModel(undefined, definition.model), 'user/global-model');
  writeFileSync(project, projectSource);
  definition = __test__.loadAgentDefaults('worker')!;
  session.switchModel();
  assert.equal(__test__.resolveAgentModel(undefined, definition.model), 'user/project-model');
  const explicit = __test__.resolveAgentModel('call/override', definition.model);
  assert.equal(explicit, 'call/override');
  assert.match(launchArgs(explicit), /--model.*call\/override/);
  assert.equal(readFileSync(global, 'utf8'), globalSource);
  assert.equal(readFileSync(project, 'utf8'), projectSource);
});

it('a user definition that omits model still inherits rather than reviving a bundled pin', t => {
  parent();
  const project = join(dir, '.pi', 'agents', 'worker.md');
  t.after(() => rmSync(project, { force: true }));
  writeFileSync(project, '---\nname: worker\ntools: read\n---\nCustom read-only worker.\n');
  const definition = __test__.loadAgentDefaults('worker')!;
  assert.equal(definition.tools, 'read');
  assert.equal(definition.model, undefined);
  assert.equal(__test__.resolveAgentModel(undefined, definition.model), 'parent-provider/first-model');
});

it('a session without a model never inherits a previous session model', () => {
  const session = parent();
  assert.equal(__test__.resolveAgentModel(), 'parent-provider/first-model');
  session.clearModel();
  assert.equal(__test__.resolveAgentModel(), undefined);
  assert.equal(__test__.resolveAgentModel('call/override'), 'call/override');
});

it('native CLI defaults never receive an incompatible Pi provider model', () => {
  parent();
  assert.equal(__test__.resolveAgentModel(undefined, undefined, false), undefined);
  assert.equal(__test__.resolveAgentModel(undefined, 'native-model', false), 'native-model');
  assert.equal(__test__.resolveAgentModel('native-call', 'native-model', false), 'native-call');
});
