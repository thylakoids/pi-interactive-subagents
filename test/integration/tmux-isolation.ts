/** One config-free server per test file, including when run outside tmux. */
import { before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedTmux } from '../helpers/tmux.ts';

let dir: string | undefined;
let mux: ReturnType<typeof isolatedTmux> | undefined;
const keys = ['TMUX', 'TMUX_PANE', 'TMUX_SOCKET', 'PI_SUBAGENT_TREE'] as const;
let previous: NodeJS.ProcessEnv;
before(() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch { return; }
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  dir = mkdtempSync(join(tmpdir(), 'pi-test-tmux-'));
  const socket = join(dir, 'tmux.sock');
  mux = isolatedTmux(socket);
  const pane = mux('new-session', '-d', '-s', 'test-root', '-x', '160', '-y', '50', '-P', '-F', '#{pane_id}', 'sleep 86400');
  mux('set-option', '-g', 'default-shell', '/bin/sh');
  process.env.TMUX = mux('display-message', '-p', '-t', pane, '#{socket_path},#{pid},0');
  process.env.TMUX_PANE = pane;
  process.env.TMUX_SOCKET = socket;
  process.env.PI_SUBAGENT_TREE = pane;
});
function cleanup() {
  const owned = mux;
  mux = undefined;
  if (!owned) return;
  try { owned('kill-server'); } catch { /* Already stopped by a failed test. */ }
  finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    rmSync(dir!, { recursive: true, force: true });
  }
}
after(cleanup);
process.once('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); });
}
