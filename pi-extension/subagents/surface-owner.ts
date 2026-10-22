/** A pipe, not PID polling, ties pane ownership to the actual parent process. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

let owner: { directory: string; child: ChildProcess; ready: Promise<void> } | undefined;

export function surfaceOwnerId(): string {
  if (!owner) {
    const directory = join(tmpdir(), 'pi-surface-owner-' + randomUUID());
    mkdirSync(directory, { mode: 0o700 });
    const child = spawn(process.execPath, [fileURLToPath(new URL('./surface-guardian.ts', import.meta.url)), directory], {
      detached: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Subagent resource guardian exited before startup')));
      child.stdout!.once('data', () => { (child.stdout as Socket).unref(); resolve(); });
    });
    // Surface-only callers need not await startup; agent launches must do so.
    void ready.catch(() => {});
    child.unref();
    (child.stdin as Socket).unref();
    owner = { directory, child, ready };
  }
  return basename(owner.directory);
}

export function surfaceOwnerDirectory(): string {
  surfaceOwnerId();
  return owner!.directory;
}

export function waitForSurfaceOwner(): Promise<void> {
  surfaceOwnerId();
  return owner!.ready;
}

export function disposeSurfaceOwner(): void {
  owner?.child.stdin!.end();
  owner = undefined;
}
