/** Private tmux client: never load host config or inherit its server identity. */
import { execFileSync } from 'node:child_process';

export function isolatedTmux(socket: string, overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of ['TMUX', 'TMUX_PANE', 'TMUX_SOCKET', 'PI_SUBAGENT_TREE']) delete env[key];
  return (...args: string[]) => execFileSync('tmux', ['-f', '/dev/null', '-S', socket, ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
