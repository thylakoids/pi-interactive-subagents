/** Pi messages use an inbox, never the terminal editor. One inbox per launch. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PiDelivery = "steer" | "followUp";
export interface PiInput { message: string; deliverAs: PiDelivery }

export function piInbox(sessionFile: string, id: string): string {
  return `${sessionFile}.control-${id}`;
}

export function createPiInbox(sessionFile: string, id: string): string {
  const root = piInbox(sessionFile, id);
  mkdirSync(join(root, "inbox"), { recursive: true, mode: 0o700 });
  return root;
}

export function queuePiMessage(sessionFile: string, id: string, input: PiInput, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  const root = piInbox(sessionFile, id);
  const name = `${process.hrtime.bigint().toString().padStart(24, "0")}-${randomUUID()}.json`;
  const temporary = join(root, name + ".tmp");
  try {
    writeFileSync(temporary, JSON.stringify(input), { mode: 0o600 });
    signal?.throwIfAborted();
    // Finalization renames the inbox directory before inspecting its contents.
    // A send either enters that batch, or fails explicitly after the gate closes.
    renameSync(temporary, join(root, "inbox", name));
  } finally { rmSync(temporary, { force: true }); }
}

export function drainPiInbox(sessionFile: string, id: string, send: (input: PiInput) => void, closing = false): number {
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
