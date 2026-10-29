/** Pi messages use an inbox, never the terminal editor. One inbox per launch. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PiDelivery = "steer" | "followUp";
export interface PiInput { message: string; deliverAs: PiDelivery }

export function piInbox(sessionFile: string, id: string): string {
  return `${sessionFile}.control-${id}`;
}

/** Launch-scoped intent survives inbox removal and later session resumes. */
export function isPiLaunchStopped(sessionFile: string, id: string): boolean {
  return existsSync(`${piInbox(sessionFile, id)}.stop`);
}

export function stopPiInbox(sessionFile: string, id: string): void {
  writeFileSync(`${piInbox(sessionFile, id)}.stop`, String(Date.now()), { mode: 0o600 });
  closePiInbox(sessionFile, id);
}

function assertNotStopped(sessionFile: string, id: string): void {
  if (isPiLaunchStopped(sessionFile, id)) throw new Error("Subagent launch was explicitly stopped; deliberate resume requires a new launch.");
}

export function createPiInbox(sessionFile: string, id: string): string {
  assertNotStopped(sessionFile, id);
  const root = piInbox(sessionFile, id);
  mkdirSync(join(root, "inbox"), { recursive: true, mode: 0o700 });
  return root;
}

export function queuePiMessage(sessionFile: string, id: string, input: PiInput, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  assertNotStopped(sessionFile, id);
  const root = piInbox(sessionFile, id);
  const name = `${process.hrtime.bigint().toString().padStart(24, "0")}-${randomUUID()}.json`;
  const temporary = join(root, name + ".tmp");
  try {
    writeFileSync(temporary, JSON.stringify(input), { mode: 0o600 });
    signal?.throwIfAborted();
    assertNotStopped(sessionFile, id);
    // Finalization renames the inbox directory before inspecting its contents.
    // A send either enters that batch, or fails explicitly after the gate closes.
    renameSync(temporary, join(root, "inbox", name));
  } finally { rmSync(temporary, { force: true }); }
}

export function drainPiInbox(sessionFile: string, id: string, send: (input: PiInput) => void, closing = false): number {
  if (isPiLaunchStopped(sessionFile, id)) return 0;
  const root = piInbox(sessionFile, id);
  const directory = join(root, closing ? "closed" : "inbox");
  let files: string[];
  try {
    if (closing) renameSync(join(root, "inbox"), directory);
    files = readdirSync(directory).filter(name => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  for (const name of files) {
    if (isPiLaunchStopped(sessionFile, id)) return 0;
    const file = join(directory, name);
    const input = JSON.parse(readFileSync(file, "utf8")) as PiInput;
    send(input);
    unlinkSync(file);
  }
  if (closing && files.length) renameSync(directory, join(root, "inbox"));
  return files.length;
}

export function closePiInbox(sessionFile: string, id: string): void {
  try { renameSync(join(piInbox(sessionFile, id), "inbox"), join(piInbox(sessionFile, id), "closed")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
