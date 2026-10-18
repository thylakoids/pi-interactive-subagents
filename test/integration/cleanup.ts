/** Wait for terminal descendants to stop before removing their working directory. */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export async function cleanupSession(session: string, dir: string, options: { preserveArtifacts?: boolean } = {}) {
  const pids = new Set<number>();
  try {
    const roots = execFileSync('tmux', ['list-panes', '-s', '-t', session, '-F', '#{pane_pid}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const pid of roots.trim().split(/\s+/)) pids.add(Number(pid));
    const processes = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
      .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of processes) {
        if (pids.has(parent) && !pids.has(pid)) { pids.add(pid); changed = true; }
      }
    }
  } catch {}
  try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' }); } catch {}
  const alive = () => [...pids].filter(pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  const deadline = Date.now() + 10_000;
  while (alive().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  const remaining = alive();
  if (remaining.length) throw new Error('Terminal processes did not exit; preserving test artifacts at ' + dir + ': ' + remaining.join(', '));
  if (!options.preserveArtifacts) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
