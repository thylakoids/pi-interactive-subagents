/**
 * Shared types for the workflow runtime.
 *
 * A workflow is a saved or inline JavaScript program whose control flow is
 * deterministic host code: it fans out `agent()` calls, optionally in
 * `pipeline()` stages, collects structured results, and returns a value. The
 * script never runs model calls itself — every `agent()` goes through the
 * plugin's interactive subagent service, so each one is a real pi session in
 * its own tmux pane that the user can watch and drive.
 *
 * Terminology mirrors Claude Code's Workflow tool:
 *  - run      one execution of a script, identified by `runId`, persisted under
 *             the workflow runs directory
 *  - call     one `agent()` invocation inside a script, identified by a stable
 *             content hash (`callKey`) so resume can match it after a restart
 *  - agent    one interactive subagent session backing a call
 */

/** Run status as shown in the widget and returned by the workflow tool. */
export type WorkflowRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  /** Launched in a previous process; recoverable with resume. */
  | "interrupted";

/** Per-call status. `skipped` means the user declined it; `failed` means it broke. */
export type WorkflowCallStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "aborted";

export interface WorkflowAgentOptions {
  /** Display-only label. Defaults to the agent type; not part of cache identity. */
  label?: string;
  /** Progress phase this call belongs to. */
  phase?: string;
  /** JSON Schema for the result; the subagent must return it via structured_output. */
  schema?: Record<string, unknown>;
  /** Explicit agent definition name. Defaults to the workflow's `agent` option. */
  agent?: string;
  /** Model override, forwarded to the subagent launch. */
  model?: string;
  /** Reasoning effort override, applied as the child's thinking level. */
  effort?: string;
  /** Enforce read-only tools and OS-sandboxed verification commands. */
  readOnly?: boolean;
  /** Run in a persistent detached Git worktree, based on committed HEAD. */
  isolation?: "worktree";
  /** Explicit extra attempts after failure; default 0. May repeat side effects. */
  retries?: number;
  /** Per-attempt active-time ceiling in ms; omit to keep the default. */
  stallTimeoutMs?: number;
}

export interface WorkflowAgentResultMeta {
  callKey: string;
  label: string;
  phase?: string;
  status: WorkflowCallStatus;
  /** Agent definition used (for display and the session loadout). */
  agentType: string;
  /** Cosmetic subagent name in the registry, usable with subagent_message. */
  name?: string;
  sessionFile?: string;
  sessionId?: string;
  model?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  /** True when the value was replayed from the journal rather than re-run. */
  cached?: boolean;
  /** Provider/agent error text when status is `failed`. */
  error?: string;
  /** Aggregate usage of the backing subagent session, when available. */
  usage?: WorkflowUsage;
  /** Live status of a running backing agent, from the plugin's status machine. */
  live?: WorkflowSubagentLiveStatus;
}

export interface WorkflowUsage {
  /** Model that produced the usage, when known. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
}

/** One journal line: a call's identity, its outcome, and when it settled. */
export interface WorkflowJournalEntry {
  type: "call";
  callKey: string;
  /** This settlement's uncached tokens (usage may be cumulative across retries). */
  attemptTokens?: number;
  label: string;
  phase?: string;
  agentType: string;
  prompt: string;
  schema?: Record<string, unknown>;
  status: WorkflowCallStatus;
  /** The script-visible value (text or structured object). Absent when null. */
  value?: unknown;
  valueIsNull?: boolean;
  /** Subagent session identity, so a resumed run can point at the same session. */
  name?: string;
  sessionFile?: string;
  sessionId?: string;
  model?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
  usage?: WorkflowUsage;
  /**
   * True when this line was written by replaying a *predecessor* run's answer
   * (a same-name/same-args start). The value is this run's result, but the
   * tokens were spent by the run that produced it, so budget accounting must
   * not charge them again.
   */
  replayed?: boolean;
}

/** One phase entry. A bare string is accepted and read as `{ title }`. */
export interface WorkflowPhase {
  title: string;
  detail?: string;
  /** Display-only here; a per-phase model override is not implemented. */
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: Array<string | WorkflowPhase>;
  /** When to reach for this workflow, for a listing. */
  whenToUse?: string;
  /** Default agent definition for `agent()` calls that do not name one. */
  agent?: string;
}

/** Snapshot describing everything needed to resume a run. */
export interface WorkflowRunSnapshot {
  version: 1;
  runId: string;
  meta: WorkflowMeta;
  /** Absolute path of the persisted script copy. */
  scriptPath: string;
  /** Hash of the script source, used to detect edits between runs. */
  scriptHash: string;
  /** The script as the user wrote it (meta export included). Resume runs this. */
  source: string;
  args: unknown;
  /** Deterministic seed handed to the QuickJS VM. */
  seed: number;
  /** VM clock start, reused on resume so script-visible time replays. */
  startedAt: number;
  sessionFile: string;
  sessionId: string;
  cwd: string;
  /** Optional per-run token budget in tokens. */
  budgetTotal?: number;
  status: WorkflowRunStatus;
  phase?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** Final script return value, when the run completed. */
  result?: unknown;
  error?: string;
  agentCount: number;
  /** Lifetime uncached-input + output spend, including failed attempts. */
  spentTokens?: number;
  /** Lifetime admitted attempts; preserved by resume. */
  agentAttempts?: number;
  /** Set on resume, pointing back at the run being continued. */
  resumedFrom?: string;
}

export interface WorkflowRunView {
  runId: string;
  meta: WorkflowMeta;
  status: WorkflowRunStatus;
  phase?: string;
  createdAt: number;
  updatedAt: number;
  startedAtWall: number;
  /** Wall-clock time the run settled; absent while it is still running. */
  finishedAt?: number;
  agentCount: number;
  activeCount: number;
  completedCount: number;
  failedCount: number;
  totalCount: number;
  maxConcurrent: number;
  /** 0..1 progress over the calls the script has issued so far. */
  progress: number;
  usage: WorkflowUsage;
  budgetTotal?: number;
  scriptPath: string;
  runDir: string;
  sessionFile: string;
  cwd: string;
  error?: string;
  /** Final script return value, once the run completed. */
  result?: unknown;
  /** Set when this run replayed calls from an earlier run of the same workflow. */
  resumedFrom?: string;
  calls: WorkflowAgentResultMeta[];
  /** The run's notes: the script's `log()` lines and the runtime's own. */
  logs: string[];
  /** Notes dropped from the front of `logs`, so a trimmed list says so. */
  logsDropped: number;
}

/** Result of one `agent()` call as seen by the script. */
export interface WorkflowAgentOutcome {
  ok: boolean;
  value?: unknown;
  status: WorkflowCallStatus;
  error?: string;
}

/**
 * Service the runtime uses to spawn and observe interactive subagents.
 * Implemented by index.ts on top of the existing launch/watch/steer path so
 * workflow agents share the plugin's panes, registry, status machine and
 * permission checks instead of getting a second, parallel execution path.
 */
export interface WorkflowSubagentRequest {
  /** Enforce evidence-only tools and sandboxed local verification commands. */
  readOnly?: boolean;
  agentType: string;
  name: string;
  task: string;
  model?: string;
  /**
   * Reasoning effort, applied to whatever model this call resolved to.
   * Separate from `model` so `{ effort: 'low' }` works on its own — the child's
   * definition supplies the model and only the level changes.
   */
  effort?: string;
  /** Absolute path of a JSON Schema file the child must satisfy via structured_output. */
  schemaFile?: string;
  /** Sidecar file the child writes the structured result to. */
  resultFile?: string;
  /** Extra extension paths the child must load (structured_output). */
  extraExtensions?: string[];
  cwd?: string;
  /**
   * The child's final message is a *value* the script consumes, not a report to
   * a human, so it is told to return raw data rather than a summary.
   */
  outputIsData?: boolean;
  /**
   * Force a terminating child. A workflow agent is never interactive: a child
   * that waits for a human would stall the run until the script's watchdog.
   */
  nonInteractive?: boolean;
  /**
   * Cancels this spawn before the child starts. The launcher checks it before
   * it creates a pane, while it waits for the pane's shell, and again before it
   * sends the command: once aborted it closes any surface it opened and never
   * starts the child. An already-aborted signal means "do not spawn at all".
   *
   * This does not stop a child that already started — that is `stop()`, which
   * the runtime calls when a call is skipped or the run is aborted.
   */
  signal?: AbortSignal;
}

export interface WorkflowSubagentHandle {
  id: string;
  name: string;
  sessionFile: string;
  /** Resolves when the subagent exits; never rejects. */
  completion: Promise<WorkflowSubagentCompletion>;
}

export interface WorkflowSubagentCompletion {
  exitCode: number;
  /** Final assistant text. */
  summary: string;
  sessionId?: string;
  elapsedMs: number;
  error?: string;
  usage?: WorkflowUsage;
  /** Parsed structured result, when the run was launched with a schema. */
  structured?: unknown;
  structuredError?: string;
}

export interface WorkflowSubagentService {
  ownership?: { current(): string; reap(owner: string): void };
  isAvailable(): { ok: true } | { ok: false; reason: string };
  spawn(request: WorkflowSubagentRequest): Promise<WorkflowSubagentHandle>;
  steer(name: string, message: string): Promise<{ ok: true } | { error: string }>;
  /** Stop a running agent by its display name (closes its pane). */
  stop(name: string): void;
  /** Bring the agent's pane into view, running or finished. */
  focus(name: string, sessionFile?: string): { ok: true } | { error: string } | Promise<{ ok: true } | { error: string }>;
  /** Live status line for a running agent, for the observability panel. */
  status(name: string): WorkflowSubagentLiveStatus | undefined;
  /** Names already taken in this session, so workflow names never collide. */
  takenNames(): Set<string>;
  /** Agent definitions the caller is allowed to spawn, and their kinds. */
  allowedAgents(): { allowed: string[]; unknown: (name: string) => boolean };
  /**
   * How an agent definition runs. A `cli:` definition is an external coding
   * agent in a pane, which cannot carry a schema or a workflow's data contract.
   */
  agentKind(name: string): "pi" | "cli" | undefined;
  /**
   * The parent session's resolved model and thinking level, used only when
   * neither the call nor the definition names one. Never preferred over a
   * definition's own pinned model.
   */
  sessionDefaults(): { model?: string; thinking?: string };
}

export interface WorkflowSubagentLiveStatus {
  kind: "starting" | "active" | "waiting" | "stalled" | "running";
  /** Phase detail, phrased exactly like the subagent widget's status label. */
  detail: string;
}
