/** A snapshot of this parent's children, using Pi's own selector and Focus path. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type { RunningSubagent } from "./index.ts";
import { readNameRegistry, readSubagentLoadout } from "./session.ts";
import { classifyStatus } from "./status.ts";

export async function openSubagentPicker(
  ctx: ExtensionContext,
  artifactDir: string,
  running: RunningSubagent[],
  focus: (name: string, sessionFile: string) => Promise<{ ok: true } | { error: string }>,
): Promise<void> {
  const entries = new Map<string, { name: string; sessionFile: string; state: string }>();
  for (const child of running) entries.set(resolve(child.sessionFile), {
    name: child.name, sessionFile: child.sessionFile, state: classifyStatus(child.statusState).kind,
  });
  for (const [name, saved] of Object.entries(readNameRegistry(artifactDir)).reverse()) {
    const path = resolve(saved.sessionFile);
    if (!entries.has(path)) entries.set(path, { name, sessionFile: saved.sessionFile, state: "saved" });
  }
  const items = [...entries.values()].map(entry => {
    const model = readSubagentLoadout(entry.sessionFile)?.model;
    return { ...entry, label: `${entry.name} · ${entry.state}${model ? ` · ${model}` : ""}` };
  });
  if (!items.length) { ctx.ui.notify("No subagents in this session.", "info"); return; }
  if (!ctx.hasUI) { ctx.ui.notify(items.map(item => item.label).join("\n"), "info"); return; }
  const selected = await ctx.ui.select("Focus subagent", items.map(item => item.label));
  const item = items.find(item => item.label === selected);
  if (!item) return;
  const result = await focus(item.name, item.sessionFile);
  if ("error" in result) ctx.ui.notify(result.error, "error");
}
