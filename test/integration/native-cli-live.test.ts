/** Opt-in billed REAL native TUIs. PI_NATIVE_CLI_LIVE=1; optionally
 * PI_NATIVE_CLI_KINDS=claude,codex, PI_NATIVE_CLAUDE_MODEL / PI_NATIVE_CODEX_MODEL.
 * Requirements: tmux, authenticated native CLI(s), and a configured Pi host.
 * PI_TEST_PI selects Pi; PI_CLAUDE_BIN / PI_CODEX_BIN select actual binaries.
 * Complete native onboarding/trust first. PI_NATIVE_CLI_TRUST_TEST_DIR=1
 * explicitly allows test-only trust setup for this owned temporary directory;
 * the native CLI may persist its trust record in its configured home.
 * Codex gets an isolated CODEX_HOME with only a copy of auth.json, removed
 * after the test. Normal Codex configuration and history are never reused.
 * Evidence uses TMPDIR.
 * Run: PI_NATIVE_CLI_LIVE=1 node --test test/integration/native-cli-live.test.ts
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { isolatedCodexHome } from './codex-home.ts';
import { integrationRuntime } from './runtime.ts';
import { shellEscape } from '../../pi-extension/subagents/tmux.ts';

const live = process.env.PI_NATIVE_CLI_LIVE === '1';
const kinds = (process.env.PI_NATIVE_CLI_KINDS ?? 'claude,codex').split(',');
// New child panes inherit the tmux server's environment, not the Pi process's.
const testMux = (socket: string, home: string) => (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], {
  env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

it('isolated Codex home reaches newly created tmux child panes without a model', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-tmux-home-'));
  const codex = isolatedCodexHome(dir);
  const socket = join(dir, 'tmux.sock');
  const mux = testMux(socket, codex.home);
  t.after(() => { try { mux('kill-server'); } catch {} finally { codex.cleanup(); } });
  mux('new-session', '-d', '-s', 'isolation', 'sleep 120');
  assert.equal(mux('show-environment', '-g', 'CODEX_HOME'), `CODEX_HOME=${codex.home}`);
  const output = join(dir, 'child-home');
  mux('new-window', '-d', '-t', 'isolation', `printf '%s' "$CODEX_HOME" > ${shellEscape(output)}; sleep 120`);
  const deadline = Date.now() + 5000;
  while (!existsSync(output)) {
    assert.ok(Date.now() < deadline, 'child shell must start');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(readFileSync(output, 'utf8'), codex.home);
});
for (const kind of ['claude', 'codex']) it(`REAL ${kind} native TUI lifecycle`, {
  skip: !live || !kinds.includes(kind), timeout: 1_200_000,
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), `pi-native-live-${kind}-`));
  const codex = isolatedCodexHome(dir, kind === 'codex'
    ? process.env.PI_NATIVE_CODEX_AUTH_FILE ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
    : undefined);
  const socket = join(dir, 'tmux.sock');
  const root = resolve(import.meta.dirname, '../..');
  console.log(`${kind} retained evidence: ${dir}`);
  const mux = testMux(socket, codex.home);
  t.after(() => { try { mux('kill-server'); } catch {} finally { codex.cleanup(); } });
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  mkdirSync(join(dir, '.pi', 'agents'), { recursive: true });
  for (const [name, auto] of [['native-auto', true], ['native-interactive', false]] as const) {
    const model = process.env[`PI_NATIVE_${kind.toUpperCase()}_MODEL`];
    writeFileSync(join(dir, '.pi', 'agents', name + '.md'), `---\ncli: ${kind}\nauto-exit: ${auto}\n${model ? 'model: ' + model + '\n' : ''}---\nFollow the supplied task exactly.\n`);
  }
  const pane = mux('new-session', '-d', '-s', 'native-live', '-x', '160', '-y', '48', '-P', '-F', '#{pane_id}');
  assert.equal(mux('show-environment', '-g', 'CODEX_HOME'), `CODEX_HOME=${codex.home}`);
  const runtime = integrationRuntime();
  const command = `cd ${shellEscape(dir)} && env CODEX_HOME=${shellEscape(codex.home)} PATH=${shellEscape(runtime.path)} PI_OFFLINE=1 PI_NATIVE_LIVE_DIR=${shellEscape(dir)} PI_NATIVE_LIVE_KIND=${kind} PI_SUBAGENT_SHELL_READY_DELAY_MS=100 ${shellEscape(runtime.executable)} -ne -ns -np -nc --no-mcp --approve -e ${shellEscape(join(root, 'test/integration/fixtures/native-cli-live.ts'))} --session-dir ${shellEscape(join(dir, 'sessions'))} --session ${shellEscape(join(dir, 'sessions', 'parent.jsonl'))} 2>${shellEscape(join(dir, 'parent-stderr.log'))}`;
  mux('respawn-pane', '-k', '-t', pane, command);
  const trustStages = new Map<string, 'down-sent' | 'enter-sent'>();
  const trustOwnedTestDirectory = () => {
    if (process.env.PI_NATIVE_CLI_TRUST_TEST_DIR !== '1') return;
    // This socket belongs exclusively to this test. Never inspect a user server.
    const ownedPanes = mux('list-panes', '-a', '-F', '#{pane_id}').split('\n');
    for (const target of ownedPanes) {
      const previousStage = trustStages.get(target);
      if (previousStage === 'enter-sent') continue;
      let screen: string;
      try { screen = mux('capture-pane', '-p', '-t', target); }
      catch { continue; } // A completed native pane may close between polls.
      if (!screen.includes('Yes, I trust this folder') ||
          ![dir, realpathSync(dir)].some(path => screen.includes(path))) continue;
      // React must render the selection change before receiving confirmation.
      // Never send both keys in one chunk or retry Down on the same prompt.
      const stage = previousStage === undefined ? 'down-sent' : 'enter-sent';
      if (stage === 'enter-sent' && !/❯\s+Yes, I trust/u.test(screen)) continue;
      const key = stage === 'down-sent' ? 'Down' : 'Enter';
      const evidence = `trust-setup-${target.slice(1)}-${stage}.screen.txt`;
      writeFileSync(join(dir, evidence), screen);
      appendFileSync(join(dir, 'setup-events.jsonl'), JSON.stringify({
        at: Date.now(), event: 'trust-owned-test-directory', directory: dir,
        pane: target, stage, evidence, keys: [key],
      }) + '\n');
      trustStages.set(target, stage);
      mux('send-keys', '-t', target, key);
    }
  };
  const until = async (file: string, timeout: number) => {
    const deadline = Date.now() + timeout;
    while (!existsSync(join(dir, file)) && Date.now() < deadline) {
      trustOwnedTestDirectory();
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    try { writeFileSync(join(dir, file + '.screen.txt'), mux('capture-pane', '-p', '-S', '-300', '-t', pane)); }
    catch { writeFileSync(join(dir, file + '.screen.txt'), 'Parent pane unavailable; inspect parent-stderr.log'); }
    assert.ok(existsSync(join(dir, file)), `Timed out waiting for ${file}; evidence: ${dir}`);
  };
  await until('ready.json', 45_000);
  for (const scenario of ['conversation', ...(kind === 'claude' ? ['mid-turn'] : []), 'workflow']) await t.test(scenario, async () => {
    mux('send-keys', '-t', pane, '/native-live ' + scenario, 'Enter');
    await until(scenario + '.json', 540_000);
    const report = JSON.parse(readFileSync(join(dir, scenario + '.json'), 'utf8'));
    assert.equal(report.ok, true, report.error + '; evidence: ' + dir);
    assert.deepEqual(report.checks, scenario === 'conversation'
      ? ['startup', 'message', 'abort', 'native-resume']
      : scenario === 'mid-turn'
      ? ['foreground-shell', 'live-message', 'shared-prompt-id', 'automatic-return', 'pane-cleanup']
      : ['workflow-abort', 'workflow-journal-resume', 'completed-focus']);
  });
});
