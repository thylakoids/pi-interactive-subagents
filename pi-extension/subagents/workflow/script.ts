/**
 * Workflow script source handling.
 *
 * A workflow script is plain JavaScript whose first statement is a literal meta
 * object:
 *
 *   export const meta = { name: 'find-flaky-tests', description: '...', phases: ['Scan', 'Fix'] }
 *   phase('Scan')
 *   const flaky = await agent('grep for retries', { schema: FLAKY })
 *   return flaky
 *
 * The `export` form is what the model writes (it mirrors Claude Code's
 * Workflow scripts); the QuickJS sandbox runs an async function body, so the
 * export is rewritten to a plain const before execution. Everything else about
 * the source is left byte-identical so line numbers in errors still match the
 * script the user wrote.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidMeta } from "./journal.ts";
import type { WorkflowMeta } from "./types.ts";

export class WorkflowScriptError extends Error {}

export const BUNDLED_WORKFLOWS_DIR = fileURLToPath(new URL("../../../examples/workflows/", import.meta.url));

export interface SavedWorkflow {
  name: string;
  meta: WorkflowMeta;
  path: string;
  source: "project" | "global" | "bundled";
}

/** Use the same precedence as name resolution, including invalid local overrides. */
export function listSavedWorkflows(opts: { cwd: string; agentDir: string }): {
  workflows: SavedWorkflow[];
  errors: Array<{ path: string; error: string }>;
} {
  const workflows: SavedWorkflow[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const seen = new Set<string>();
  const roots = [
    { dir: join(opts.cwd, ".pi", "workflows"), source: "project" as const },
    { dir: join(opts.agentDir, "workflows"), source: "global" as const },
    { dir: BUNDLED_WORKFLOWS_DIR, source: "bundled" as const },
  ];
  for (const { dir, source } of roots) {
    let names: string[];
    try { names = readdirSync(dir).sort(); }
    catch (error: any) {
      if (error.code !== "ENOENT") errors.push({ path: dir, error: error.message });
      continue;
    }
    for (const filename of names) {
      if (!/^[A-Za-z0-9._-]{1,64}\.js$/.test(filename)) continue;
      const name = filename.slice(0, -3);
      if (seen.has(name)) continue;
      seen.add(name);
      const path = join(dir, filename);
      try {
        const { meta } = parseScript(readScriptFile(path), path);
        workflows.push({ name, meta, path, source });
      } catch (error: any) {
        errors.push({ path, error: error.message });
      }
    }
  }
  return { workflows, errors };
}

export interface ParsedScript {
  /** Script text with the meta export rewritten; safe to run in the sandbox. */
  body: string;
  meta: WorkflowMeta;
  /** Slash/named form as written, for error messages. */
  origin: string;
}

/**
 * Locate a saved workflow by name.
 *
 * Search order: an explicit absolute/relative path, then
 * `<cwd>/.pi/workflows/<name>.js`, then `<agentDir>/workflows/<name>.js`.
 * Names are validated before they touch the filesystem.
 */
export function resolveSavedScriptPath(
  name: string,
  opts: { cwd: string; agentDir: string },
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.endsWith(".js") || trimmed.includes("/")) {
    const candidate = isAbsolute(trimmed) ? trimmed : resolve(opts.cwd, trimmed);
    return existsSync(candidate) ? candidate : null;
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) return null;
  const candidates = [
    join(opts.cwd, ".pi", "workflows", `${trimmed}.js`),
    join(opts.agentDir, "workflows", `${trimmed}.js`),
    join(BUNDLED_WORKFLOWS_DIR, `${trimmed}.js`),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/**
 * Extract and validate the meta literal, then rewrite the source for the
 * sandbox. The meta object must be a literal: no spreads, calls, or template
 * interpolation, so the run's identity is knowable before it executes.
 */
export function parseScript(source: string, origin: string): ParsedScript {
  if (!source.trim()) {
    throw new WorkflowScriptError("Workflow script is empty.");
  }

  const match = /(^|\n)\s*export\s+const\s+meta\s*=\s*\{/.exec(source);
  if (!match) {
    throw new WorkflowScriptError(
      "Workflow script must start with a meta literal, e.g. " +
        "`export const meta = { name: 'my-workflow', description: 'what it does' }`.",
    );
  }

  const literalStart = source.indexOf("{", match.index + match[0].length - 1);
  const literalEnd = findMatchingBrace(source, literalStart);
  if (literalEnd === -1) {
    throw new WorkflowScriptError("Workflow meta literal is not closed.");
  }

  const literal = source.slice(literalStart, literalEnd + 1);
  if (/\$\{|`/.test(literal) && /[`]/.test(literal)) {
    throw new WorkflowScriptError("Workflow meta must be a pure literal (no template strings).");
  }

  let meta: unknown;
  try {
    meta = JSON.parse(toJsonLiteral(literal));
  } catch (error: any) {
    throw new WorkflowScriptError(
      `Workflow meta must be a pure literal of JSON values: ${error?.message ?? String(error)}`,
    );
  }
  if (!isValidMeta(meta)) {
    throw new WorkflowScriptError(
      "Workflow meta needs a 1-64 char slug `name`, a non-empty `description`, " +
        "optional `phases` (array of strings) and optional `agent` (default subagent type).",
    );
  }

  const before = source.slice(0, match.index + match[1].length);
  const after = source.slice(literalEnd + 1);
  const body = `${before}const meta = ${literal};${after}`;

  return { body, meta, origin };
}

/**
 * Convert a JS object literal holding only JSON values into JSON text.
 *
 * Unquoted keys and single-quoted strings are accepted (they are what a model
 * writes by habit); anything else — identifiers as values, calls, spreads —
 * fails, which is the point: the meta must not depend on execution.
 */
function toJsonLiteral(literal: string): string {
  let out = "";
  let i = 0;
  const isKeyPosition = (text: string): boolean => /[{\s,]$/.test(text);

  while (i < literal.length) {
    const ch = literal[i];
    if (ch === "'" || ch === '"') {
      const { value, next } = readString(literal, i);
      out += JSON.stringify(value);
      i = next;
      continue;
    }
    if (ch === "`") {
      throw new Error("template strings are not allowed");
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (i < literal.length && /[A-Za-z0-9_$]/.test(literal[i])) i++;
      const word = literal.slice(start, i);
      if (word === "true" || word === "false" || word === "null") {
        out += word;
      } else if (isKeyPosition(out)) {
        out += JSON.stringify(word);
      } else {
        throw new Error(`identifier \`${word}\` is not a literal value`);
      }
      continue;
    }
    if (ch === "." || ch === "(" || ch === ")" || ch === "+" || ch === "=") {
      throw new Error(`\`${ch}\` is not allowed in meta`);
    }
    out += ch;
    i++;
  }

  // Trailing commas are valid JS but not JSON.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function readString(text: string, start: number): { value: string; next: number } {
  const quote = text[start];
  let i = start + 1;
  let value = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      value += next === "n" ? "\n" : next === "t" ? "\t" : next ?? "";
      i += 2;
      continue;
    }
    if (ch === quote) return { value, next: i + 1 };
    value += ch;
    i++;
  }
  throw new Error("unterminated string");
}

function findMatchingBrace(source: string, start: number): number {
  let depth = 0;
  let i = start;
  let mode: "code" | "single" | "double" | "tick" | "line" | "block" = "code";

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (mode === "code") {
      if (ch === "'") mode = "single";
      else if (ch === '"') mode = "double";
      else if (ch === "`") mode = "tick";
      else if (ch === "/" && next === "/") { mode = "line"; i++; }
      else if (ch === "/" && next === "*") { mode = "block"; i++; }
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return i;
      }
    } else if (mode === "single" || mode === "double" || mode === "tick") {
      const quote = mode === "single" ? "'" : mode === "double" ? '"' : "`";
      if (ch === "\\") i++;
      else if (ch === quote) mode = "code";
    } else if (mode === "line") {
      if (ch === "\n") mode = "code";
    } else if (mode === "block") {
      if (ch === "*" && next === "/") { mode = "code"; i++; }
    }
    i++;
  }
  return -1;
}

export function readScriptFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error: any) {
    throw new WorkflowScriptError(`Cannot read workflow script ${path}: ${error?.message ?? String(error)}`);
  }
}
