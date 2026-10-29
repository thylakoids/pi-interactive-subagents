import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string | null;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

function getForkContentLines(parentSessionFile: string): string[] {
  const raw = readFileSync(parentSessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());

  let truncateAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "message" && entry.message?.role === "user") {
        truncateAt = i;
        break;
      }
    } catch {
      // ignore malformed lines
    }
  }

  return lines.slice(0, truncateAt).filter((line) => {
    try {
      return JSON.parse(line).type !== "session";
    } catch {
      return true;
    }
  });
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  const contentLines =
    params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
  const lines = [JSON.stringify(header), ...contentLines];

  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}

/**
 * A snapshot of everything needed to reconstruct a subagent's sandbox when its
 * session is later resumed via `subagent_message({ sessionId })`.
 *
 * Written next to the session file as `<sessionFile>.loadout.json` at spawn
 * time. Resume replays this exact snapshot so the reincarnated process gets the
 * same `--no-extensions` + `--tools` restriction, model, identity, spawn
 * whitelist, cwd, and config dir it originally ran with — instead of falling
 * back to pi's default (all global extensions + full toolset). Storing the
 * resolved loadout (rather than re-deriving from the agent `.md` by name) keeps
 * resume faithful even if the agent definition is later edited, moved, or
 * deleted.
 */
export interface SubagentLoadout {
  /** Persistent execution restriction, also enforced when resumed or focused. */
  readOnly?: boolean;
  /** Agent profile name (for PI_SUBAGENT_AGENT); null for agentless spawns. */
  agent: string | null;
  /** The `--tools` allowlist string, or null when the spawn was unrestricted. */
  toolAllowlist: string | null;
  /** Model id (without thinking suffix), or null to use the session default. */
  model: string | null;
  /** Thinking level appended to the model as `model:level`, or null. */
  thinking: string | null;
  /** How the identity text was applied: append/replace, or null. */
  systemPromptMode: "append" | "replace" | null;
  /** The system-prompt/identity text, only when it lived in the system prompt. */
  identity: string | null;
  /** Agents this subagent was allowed to spawn (for PI_SUBAGENT_ALLOWED). */
  spawnable: string[] | null;
  /** Whether the agent auto-exits (informational; resume forces autonomous). */
  autoExit: boolean;
  /** Working directory the subagent ran in, or null. */
  cwd: string | null;
  /** PI_CODING_AGENT_DIR the subagent resolved config/extensions from, or null. */
  agentDir: string | null;
}

/** Path of the loadout sidecar written next to a subagent session file. */
export function loadoutSidecarPath(sessionFile: string): string {
  return `${sessionFile}.loadout.json`;
}

/** Persist a subagent's resolved sandbox loadout beside its session file. */
export function writeSubagentLoadout(sessionFile: string, loadout: SubagentLoadout): void {
  try {
    writeFileSync(loadoutSidecarPath(sessionFile), JSON.stringify(loadout), "utf8");
  } catch {
    // Best-effort: a missing snapshot only means resume will refuse, never that
    // it launches unrestricted.
  }
}

/** Read a subagent's loadout snapshot, or null if absent/unparseable. */
export function readSubagentLoadout(sessionFile: string): SubagentLoadout | null {
  try {
    const p = loadoutSidecarPath(sessionFile);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SubagentLoadout;
  } catch {
    return null;
  }
}

// ── Name registry ────────────────────────────────────────────────────────────
// Each spawner session (the top-level pi session, or a worker that spawns its
// own children) gets a registry mapping a subagent's display name to the
// session file it ran in. Names are unique per spawner session and persist on
// disk, so `subagent_message({ name })` can steer a running subagent or resume
// a finished one by the same handle — even across a pi restart. The registry
// lives in the spawner's own artifact dir, which is directly addressable from
// the spawner's session id (no sessions-tree scan, so resume stays fast).

export interface NameRegistryEntry {
  /** Absolute path to the subagent's session .jsonl file. */
  sessionFile: string;
  /** Canonical session header id (kept for display/lineage). */
  sessionId: string | null;
  /** Latest launch evidence; old registries without this remain readable. */
  execution?: {
    id: string;
    backend: "pi" | "codex" | "claude";
    startedAt: number;
    activityFile?: string;
    finishedAt?: number;
    stop?: { requestedAt: number; confirmedAt?: number; reason?: string };
  };
}

export type NameRegistry = Record<string, NameRegistryEntry>;

/** Path of the name registry for a given spawner session's artifact dir. */
export function nameRegistryPath(artifactDir: string): string {
  return join(artifactDir, "subagent-registry.json");
}

/** Read a spawner session's name registry, or {} if absent/corrupt. */
export function readNameRegistry(artifactDir: string): NameRegistry {
  try {
    const p = nameRegistryPath(artifactDir);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as NameRegistry;
  } catch {
    return {};
  }
}

/**
 * Register (or overwrite) a name → session mapping for a spawner session.
 * Writes atomically (temp file + rename) so a concurrent reader never sees a
 * partial registry.
 */
export function registerName(
  artifactDir: string,
  name: string,
  entry: NameRegistryEntry,
): void {
  try {
    const registry = readNameRegistry(artifactDir);
    if (!entry.execution && registry[name]?.sessionFile === entry.sessionFile) {
      entry = { ...entry, execution: registry[name].execution };
    }
    registry[name] = entry;
    writeNameRegistry(artifactDir, registry);
  } catch {
    // Best-effort: a failed registration only means resume-by-name won't find
    // this subagent later; it never breaks the spawn itself.
  }
}

function writeNameRegistry(artifactDir: string, registry: NameRegistry): void {
  mkdirSync(artifactDir, { recursive: true });
  const p = nameRegistryPath(artifactDir);
  const tmp = `${p}.tmp-${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
  renameSync(tmp, p);
}

/** A stop intent must persist successfully, and must target this incarnation. */
export function updateRegisteredExecution(
  artifactDir: string, name: string, sessionFile: string, id: string,
  update: (execution: NonNullable<NameRegistryEntry["execution"]>) => void,
): void {
  const registry = readNameRegistry(artifactDir);
  const entry = registry[name];
  if (entry?.sessionFile !== sessionFile || entry.execution?.id !== id) {
    throw new Error(`Saved identity for "${name}" changed or is unavailable; inspect it before retrying.`);
  }
  update(entry.execution);
  writeNameRegistry(artifactDir, registry);
}

/** Resolve a name to its registry entry within a spawner session, or null. */
export function resolveNameInRegistry(
  artifactDir: string,
  name: string,
): NameRegistryEntry | null {
  const entry = readNameRegistry(artifactDir)[name];
  return entry && typeof entry.sessionFile === "string" ? entry : null;
}

/** Keep at most one JSONL record in memory, including records spanning chunks. */
function* sessionLines(sessionFile: string): Generator<string> {
  const fd = openSync(sessionFile, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let parts: Buffer[] = [];
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      let start = 0;
      for (let end = buffer.indexOf(10, start); end >= 0 && end < bytes; end = buffer.indexOf(10, start)) {
        const line = parts.length
          ? Buffer.concat([...parts, buffer.subarray(start, end)]).toString("utf8")
          : buffer.toString("utf8", start, end);
        parts = [];
        if (line.trim()) yield line;
        start = end + 1;
      }
      if (start < bytes) parts.push(Buffer.from(buffer.subarray(start, bytes)));
    }
    const last = Buffer.concat(parts).toString("utf8");
    if (last.trim()) yield last;
  } finally { closeSync(fd); }
}

/** Reverse JSONL iterator; keeps one record, including UTF-8 spanning chunks. */
function* reversedSessionLines(sessionFile: string): Generator<string> {
  const fd = openSync(sessionFile, "r");
  try {
    let offset = fstatSync(fd).size;
    let parts: Buffer[] = [];
    while (offset > 0) {
      const length = Math.min(offset, 4096);
      offset -= length;
      const chunk = Buffer.allocUnsafe(length);
      const bytes = readSync(fd, chunk, 0, length, offset);
      let end = bytes;
      for (let i = bytes - 1; i >= 0; i--) {
        if (chunk[i] !== 10) continue;
        parts.push(chunk.subarray(i + 1, end));
        const line = Buffer.concat(parts.reverse()).toString("utf8").trim();
        parts = [];
        if (line) yield line;
        end = i;
      }
      parts.push(chunk.subarray(0, end));
    }
    const first = Buffer.concat(parts.reverse()).toString("utf8").trim();
    if (first) yield first;
  } finally { closeSync(fd); }
}

/** Return the last entry's id (the current branch leaf). */
export function getLeafId(sessionFile: string): string | null {
  for (const line of reversedSessionLines(sessionFile)) {
    const entry = JSON.parse(line);
    if (entry.type !== "session") return entry.id;
  }
  return null;
}

/**
 * Read only the first line of a file without loading the whole thing into
 * memory. Session files grow to many MB, but the header we need is always the
 * first JSON line, so reading a small prefix keeps header lookups cheap — this
 * is what makes scanning a large session tree fast enough to avoid blocking the
 * event loop. Returns the first line (sans trailing newline), or null.
 */
function readFirstLine(path: string, maxBytes = 65536): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    if (bytes <= 0) return null;
    const nl = buf.indexOf(0x0a); // '\n'
    const end = nl === -1 || nl >= bytes ? bytes : nl;
    return buf.toString("utf8", 0, end);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Read the canonical session id from a session file's header.
 *
 * pi's `--session <id>` flag resolves against this header `id` (exact match,
 * then prefix), NOT the filename — so this is the value to hand back to the
 * orchestrator for follow-ups.
 */
export function getSessionId(sessionFile: string): string | null {
  const firstLine = readFirstLine(sessionFile)?.trim();
  if (!firstLine) return null;
  try {
    const entry = JSON.parse(firstLine) as { type?: string; id?: string };
    return entry.type === "session" && typeof entry.id === "string" ? entry.id : null;
  } catch {
    return null;
  }
}

/**
 * Count the number of entry lines in a session file without parsing each line
 * into an object. Used by the resume path, which only needs the *count* of
 * pre-existing entries (so it can later slice out the new ones). Parsing every
 * line of a large resumed transcript synchronously at resume time would block
 * the UI; counting newlines is dramatically cheaper.
 */
export function countSessionEntryLines(sessionFile: string): number {
  try {
    let count = 0;
    for (const _line of sessionLines(sessionFile)) count++;
    return count;
  } catch {
    return 0;
  }
}

/**
 * Iterate entries after `afterLine` (the count of existing non-blank records).
 */
export function* getNewEntries(sessionFile: string, afterLine: number): Generator<SessionEntry> {
  let line = 0;
  for (const text of sessionLines(sessionFile)) {
    if (line++ >= afterLine) yield JSON.parse(text) as SessionEntry;
  }
}

/**
 * Extract usable text from one assistant entry.
 *
 * Falls back to the `errorMessage` field when the last assistant message has
 * `stopReason: "error"` and no usable text content — this happens when
 * auto-retry exhausts on a provider overload / rate limit / server error, and
 * without this fallback the parent would silently see a stale earlier message.
 */
function assistantMessageText(entry: SessionEntry): string | null {
  if (entry.type !== "message") return null;
  const msg = entry as MessageEntry;
  if (msg.message.role !== "assistant") return null;

  const texts = msg.message.content
    .filter(block => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "")
    .map(block => block.text as string);
  if (texts.length > 0) return texts.join("\n");

  const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
  const errorMessage = (msg.message as { errorMessage?: unknown }).errorMessage;
  if (stopReason === "error" && typeof errorMessage === "string" && errorMessage.trim() !== "") {
    return `Subagent error: ${errorMessage.trim()}`;
  }
  return null;
}

export interface SessionStats {
  model: string | null;
  toolCount: number;
  /** Cumulative token usage across all assistant turns. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Current context size: the last assistant turn's totalTokens. */
  contextTokens: number;
  /** Cumulative cost in USD across all assistant turns. */
  cost: number;
}

/**
 * Parse a completed subagent session JSONL into aggregate stats for display:
 * model, tool-call count, cumulative token usage + cost, and current context
 * size. Cumulative usage fields are summed across every assistant turn; the
 * context size is taken from the last assistant turn's `totalTokens` (the live
 * context window occupancy). Usage streams once; the active branch is traced
 * backwards without retaining historical message payloads or a parent-id index.
 */
export function summarizeSession(sessionFile: string, afterLine = 0): { summary: string | null; stats: SessionStats } {
  let lines = 0;
  const stats: SessionStats = {
    model: null,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    cost: 0,
  };

  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  for (const entry of getNewEntries(sessionFile, 0)) {
    lines++;
    if (entry.type !== "message") continue;
    const msg = (entry as MessageEntry).message;
    if (msg.role !== "assistant") continue;

    for (const block of msg.content) {
      if (block.type === "toolCall") stats.toolCount++;
    }

    const usage = (msg as { usage?: Record<string, unknown> }).usage;
    if (usage && typeof usage === "object") {
      stats.inputTokens += num(usage.input);
      stats.outputTokens += num(usage.output);
      stats.cacheReadTokens += num(usage.cacheRead);
      stats.cacheWriteTokens += num(usage.cacheWrite);
      const cost = usage.cost;
      if (cost && typeof cost === "object") stats.cost += num((cost as Record<string, unknown>).total);
    }
  }

  let summary: string | null = null;
  let parent: string | null | undefined;
  let model: string | undefined;
  let contextTokens: number | undefined;
  for (const line of reversedSessionLines(sessionFile)) {
    const index = --lines;
    const entry = JSON.parse(line);
    if (entry.type === "session") break;
    if (parent !== undefined && entry.id !== parent) continue;
    if (entry.type === "model_change" && model === undefined && typeof entry.modelId === "string" && entry.modelId) model = entry.modelId;
    if (entry.type === "message" && entry.message.role === "assistant") {
      if (model === undefined && typeof entry.message.model === "string" && entry.message.model) model = entry.message.model;
      const total = num(entry.message.usage?.totalTokens);
      if (total > 0) contextTokens ??= total;
      if (index >= afterLine && summary === null) summary = assistantMessageText(entry);
    }
    if ((summary !== null || index < afterLine) && model !== undefined && contextTokens !== undefined) break;
    parent = entry.parentId;
    if (parent === null) break;
  }
  stats.model = model ?? null;
  stats.contextTokens = contextTokens ?? 0;
  return { summary, stats };
}
