/**
 * Host-side resolution of a sandboxed verify command.
 *
 * Under bwrap the command lives in its own PID namespace, so the pid it prints
 * ($$ / process.pid, often 2) is meaningless on the host: ps and kill cannot use
 * it. This helper maps that namespace pid back to a host pid by matching the
 * command's TMPDIR against the exact per-command scratch directory, then
 * confirming /proc/<hostPid>/status NSpid ends with the namespace pid. The host
 * pid's process group is what a test may watch or clean up.
 *
 * On macOS there is no PID namespace, so the marker pid is already the host pid.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SandboxCommandRef {
  /** PID the command saw for itself (its marker file value). */
  namespacePid: number;
  /** PID usable from the host for kill/ps. Equals namespacePid on macOS. */
  hostPid: number;
  /** Process group of hostPid. */
  pgid: number;
  /** True when a PID-namespace translation was needed (Linux/bwrap). */
  namespaced: boolean;
}

/** The per-command scratch directory that already holds the marker file. */
export function findCommandScratchDir(parentScratch: string, markerName = 'group.txt'): string | null {
  for (const entry of readdirSync(parentScratch)) {
    const dir = join(parentScratch, entry);
    if (existsSync(join(dir, markerName))) return dir;
  }
  return null;
}

function readNsPidTail(pid: number): number | null {
  try {
    const status = readFileSync('/proc/' + pid + '/status', 'utf8');
    const line = /^NSpid:\s*(.+)$/m.exec(status);
    if (!line) return null;
    const parts = line[1].trim().split(/\s+/);
    return Number(parts[parts.length - 1]);
  } catch {
    return null;
  }
}

function pgidOfLinux(pid: number): number | null {
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    // comm may contain spaces and parentheses: everything after the last ')' is
    // "state ppid pgrp ...".
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(rest[2]);
  } catch {
    return null;
  }
}

function pgidOfDarwin(pid: number): number | null {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return Number(out) || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the host process behind a namespace pid, by scanning /proc for a
 * process whose environment points at the command's own scratch directory.
 */
export function resolveHostPid(namespacePid: number, commandScratchDir: string): number | null {
  if (process.platform !== 'linux') return namespacePid;
  const needle = 'TMPDIR=' + commandScratchDir;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let environ: string;
    try {
      environ = readFileSync('/proc/' + entry + '/environ', 'utf8');
    } catch {
      continue; // another user's process, or it exited
    }
    if (!environ.split('\u0000').includes(needle)) continue;
    if (readNsPidTail(pid) !== namespacePid) continue;
    return pid;
  }
  return null;
}

export function processGroupOf(pid: number): number | null {
  return process.platform === 'linux' ? pgidOfLinux(pid) : pgidOfDarwin(pid);
}

/**
 * A process group the tests may safely signal: never init (pgid 1 or below) and
 * never the group this very test runner belongs to. A mutant that broke
 * --detached or --new-session could otherwise make a probe resolve to the test
 * process' own group and the "cleanup" would kill the suite.
 */
export function isSafeToSignal(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  return pgid !== ownProcessGroup();
}

let ownGroupCache: number | null = null;
function ownProcessGroup(): number {
  if (ownGroupCache === null) ownGroupCache = processGroupOf(process.pid) ?? -1;
  return ownGroupCache;
}

/** True while any signalable process in the group still exists. */
export function processGroupAlive(pgid: number): boolean {
  if (!isSafeToSignal(pgid)) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killProcessGroup(pgid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!isSafeToSignal(pgid)) return;
  try { process.kill(-pgid, signal); } catch { /* already gone */ }
}

export async function waitForProcessGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pgid)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !processGroupAlive(pgid);
}

/**
 * Host pids whose environment or command line points at this scratch directory.
 * Linux reads /proc (ps may be missing in a slim image); macOS filters ps output.
 * Used to prove nothing survives a command without touching a namespace pid.
 */
export function findProcessesWithScratch(scratchDir: string): number[] {
  if (process.platform === 'linux') {
    // The command's own scratch is a per-command subdirectory of the root the
    // caller passes (scratch/cmd-XXXX), and TMPDIR points there rather than at
    // the root, so match the root itself *and* everything under it. The argv
    // check is the belt-and-braces half: the wrapper and the sandbox carry the
    // same path as arguments even if an environment was scrubbed.
    const root = scratchDir.endsWith('/') ? scratchDir : scratchDir + '/';
    const inScratch = (value: string) => value === scratchDir || value.startsWith(root);
    const found: number[] = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid) continue;
      try {
        const environ = readFileSync('/proc/' + entry + '/environ', 'utf8').split('\u0000');
        if (environ.some(part => part.startsWith('TMPDIR=') && inScratch(part.slice('TMPDIR='.length)))) {
          found.push(pid);
          continue;
        }
        const argv = readFileSync('/proc/' + entry + '/cmdline', 'utf8').split('\u0000');
        if (argv.some(arg => inScratch(arg))) found.push(pid);
      } catch {
        // another user's process, a zombie, or it exited mid-scan
      }
    }
    return found;
  }
  try {
    return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter(line => line.includes(scratchDir))
      .map(line => Number(line.trim().split(/\s+/)[0]))
      .filter(pid => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/**
 * Wait for a running sandboxed command to report its pid, then resolve it.
 * Bounded: a missing marker throws instead of hanging the suite.
 */
export async function waitForSandboxCommand(options: {
  parentScratch: string;
  markerName?: string;
  timeoutMs?: number;
}): Promise<{ ref: SandboxCommandRef; scratchDir: string }> {
  const markerName = options.markerName ?? 'group.txt';
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  let scratchDir: string | null = null;
  let pidText = '';
  while (Date.now() < deadline) {
    scratchDir = findCommandScratchDir(options.parentScratch, markerName);
    if (scratchDir) {
      pidText = readFileSync(join(scratchDir, markerName), 'utf8').trim();
      if (pidText) break;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!scratchDir || !pidText) throw new Error('the sandboxed command never reported its pid');
  const namespacePid = Number(pidText);
  if (!Number.isInteger(namespacePid) || namespacePid <= 0) {
    throw new Error('the sandboxed command reported an unusable pid: ' + JSON.stringify(pidText));
  }
  const hostPid = resolveHostPid(namespacePid, scratchDir);
  if (hostPid === null) {
    throw new Error('could not map namespace pid ' + namespacePid + ' to a host pid (scratch ' + scratchDir + ')');
  }
  const pgid = processGroupOf(hostPid);
  if (pgid === null) throw new Error('could not read the process group of host pid ' + hostPid);
  if (!isSafeToSignal(pgid)) {
    throw new Error(
      'resolved process group ' + pgid + ' (host pid ' + hostPid + ') is not a sandbox group: ' +
      'the sandbox did not detach, so a test must not signal it',
    );
  }
  return { ref: { namespacePid, hostPid, pgid, namespaced: process.platform === 'linux' }, scratchDir };
}
