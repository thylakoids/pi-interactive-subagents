/** Native TUI backends. Pi owns the handle; each CLI owns its conversation. */
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, delimiter, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { shellEscape } from "./tmux.ts";

export type ExternalCliKind = "codex" | "claude";
export interface ExternalCliSession {
  version: 1;
  kind: ExternalCliKind;
  nativeId: string | null;
  cwd: string;
  model: string | null;
  thinking: string | null;
  identity: string | null;
  systemPromptMode: "append" | "replace" | null;
  autoExit: boolean;
}
/** A unique receipt makes repeated tasks distinguishable in any notify history. */
export function prepareExternalPrompt(kind: ExternalCliKind, prompt: string): string {
  return kind === "codex" ? `<!-- pi-subagent-input:${randomUUID()} -->\n${prompt}` : prompt;
}
export function readExternalSession(sessionFile: string): ExternalCliSession | null {
  const path = `${sessionFile}.cli.json`;
  let content: string;
  try { content = readFileSync(path, "utf8"); }
  catch (error: any) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot read native CLI session metadata ${path}: ${error.message}`);
  }
  let value: ExternalCliSession;
  try { value = JSON.parse(content); }
  catch (error: any) { throw new Error(`Invalid native CLI session metadata ${path}: ${error.message}`); }
  if (!value || value.version !== 1 || !["codex", "claude"].includes(value.kind) || typeof value.cwd !== "string") {
    throw new Error(`Unsupported or invalid native CLI session metadata: ${path}`);
  }
  return value;
}
export function writeExternalSession(sessionFile: string, session: ExternalCliSession): void {
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(`${sessionFile}.cli.json`, JSON.stringify(session), { mode: 0o600 });
}
export function resolveCliBinary(kind: ExternalCliKind): string {
  const override = process.env[kind === "codex" ? "PI_CODEX_BIN" : "PI_CLAUDE_BIN"]?.trim();
  if (override) return override;
  const dirs = [...(process.env.PATH?.split(delimiter) ?? []), join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  if (kind === "codex") dirs.push("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin");
  return dirs.map(dir => join(dir, kind)).find(path => existsSync(path)) ?? kind;
}

export function buildExternalCommand(params: {
  session: ExternalCliSession;
  sessionFile: string;
  resultFile: string;
  taskFile: string;
  hookFile: string;
  settingsFile: string;
  resume: boolean;
}): string {
  const { session: s } = params;
  const parts = [shellEscape(resolveCliBinary(s.kind))];
  const hookArgs = [process.execPath, params.hookFile, s.kind, params.sessionFile, params.resultFile, s.autoExit ? "auto" : "interactive"];
  if (s.kind === "codex") {
    if (params.resume) {
      if (!s.nativeId) throw new Error("Codex has not reported a thread ID; cannot resume this session.");
      parts.push("resume");
    }
    parts.push("--no-alt-screen", "--dangerously-bypass-approvals-and-sandbox");
    parts.push("-c", shellEscape(`notify=${JSON.stringify(hookArgs)}`));
    let trustedCwd = resolve(s.cwd);
    try { trustedCwd = realpathSync(trustedCwd); } catch {}
    parts.push("-c", shellEscape(`projects={${JSON.stringify(trustedCwd)}={trust_level="trusted"}}`));
    if (s.thinking) parts.push("-c", shellEscape(`model_reasoning_effort=${JSON.stringify(s.thinking)}`));
    if (s.identity && s.systemPromptMode === "replace") {
      const identityFile = `${params.taskFile}.system.md`;
      writeFileSync(identityFile, s.identity, { mode: 0o600 });
      parts.push("-c", shellEscape(`model_instructions_file=${JSON.stringify(identityFile)}`));
    } else if (s.identity && s.systemPromptMode === "append") {
      parts.push("-c", shellEscape(`developer_instructions=${JSON.stringify(s.identity)}`));
    }
    if (s.model) parts.push("-m", shellEscape(s.model));
    parts.push("--");
    if (params.resume) parts.push(shellEscape(s.nativeId!));
  } else {
    const command = hookArgs.map(shellEscape).join(" ");
    writeFileSync(params.settingsFile, JSON.stringify({ skipDangerousModePermissionPrompt: true, hooks: {
      SessionStart: [{ hooks: [{ type: "command", command, timeout: 10 }] }],
      Stop: [{ hooks: [{ type: "command", command, timeout: 10 }] }],
      StopFailure: [{ hooks: [{ type: "command", command, timeout: 10 }] }],
    } }), { mode: 0o600 });
    parts.push("--dangerously-skip-permissions", "--settings", shellEscape(params.settingsFile));
    if (s.model) parts.push("--model", shellEscape(s.model));
    if (s.thinking) parts.push("--effort", shellEscape(s.thinking));
    if (s.identity && s.systemPromptMode) parts.push(s.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", shellEscape(s.identity));
    parts.push(params.resume ? "--resume" : "--session-id", shellEscape(s.nativeId!));
    parts.push("--");
  }
  // Read prompt data from a file. The quoted substitution is never re-evaluated
  // as shell code, including backticks, dollars, quotes, and newlines.
  parts.push(`"$(cat ${shellEscape(params.taskFile)})"`);
  const exitHook = [process.execPath, params.hookFile, "exit", params.sessionFile, params.resultFile].map(shellEscape).join(" ") + ' "$pi_cli_rc"';
  return `cd ${shellEscape(s.cwd)}\npi_cli_rc=$?\nif [ "$pi_cli_rc" -eq 0 ]; then\n${parts.join(" ")}\npi_cli_rc=$?\nfi\n${exitHook}\nexit "$pi_cli_rc"`;
}
