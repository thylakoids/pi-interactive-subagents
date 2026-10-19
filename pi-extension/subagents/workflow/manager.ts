/**
 * Workflow run manager.
 *
 * Owns one live run at a time per run id: it schedules `agent()` calls onto the
 * interactive subagent service, applies concurrency and count limits, persists
 * every settled call to the journal, and exposes the state the main-window
 * panel renders.
 *
 * Design notes that matter:
 *  - Calls are keyed by content (`callKey`) plus an occurrence ordinal, never by
 *    completion order, so a resume replays the same results no matter how the
 *    previous run interleaved — while three identical calls stay three calls.
 *  - An answer is journaled *before* it is handed to the script, so a crash can
 *    never leave a consumed-but-unrecorded result.
 *  - Skipped and failed calls are journaled but never replayed: resume retries
 *    them on resume.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import { join } from "node:path";
import type { CodemodeHostCall, CodemodeOutcome } from "@earendil-works/pi-codemode";
import {
  acquireLock,
  appendJournal,
  callKey as makeCallKey,
  legacyCallKey as makeLegacyCallKey,
  ensureRunDir,
  journalPath,
  loadJournal,
  listRunDirs,
  loadSnapshot,
  newRunId,
  newSeed,
  occurrenceKey,
  outputPath,
  releaseLock,
  runsRoot,
  scriptPath,
  saveSnapshot,
  sha256,
  writeJsonAtomic,
} from "./journal.ts";
import { defaultConcurrency, runScript } from "./runner.ts";
import { prepareWorkflowWorktree } from "./worktree.ts";
import { workflowResultSchema } from "./structured-output.ts";
import { summarizeSessionStats } from "../session.ts";
import { isCallSettled, summarizeCalls } from "./state.ts";
import { WorkflowScriptError, parseScript, readScriptFile, resolveSavedScriptPath } from "./script.ts";
import type {
  WorkflowAgentOutcome,
  WorkflowAgentResultMeta,
  WorkflowJournalEntry,
  WorkflowMeta,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  WorkflowRunView,
  WorkflowSubagentHandle,
  WorkflowSubagentService,
  WorkflowUsage,
} from "./types.ts";

export const MAX_AGENTS_PER_RUN = 1000;

export const MAX_ITEMS_PER_BATCH = 4096;

/** How many run notes are kept for the panel before the oldest are dropped. */
const MAX_NOTES = 200;

export interface WorkflowManagerOptions {
  /** Artifact dir of the parent session; runs live under `<baseDir>/workflows/`. */
  baseDir: string;
  cwd: string;
  sessionFile: string;
  sessionId: string;
  /** Agent config dir, for locating saved workflows. */
  agentDir: string;
  service: WorkflowSubagentService;
  /** Path of the structured-output extension loaded into schema-driven agents. */
  structuredOutputExtension?: string;
  /** Per-run token budget, when the session has one. */
  budgetTotal?: number | null;
  now?: () => number;
  /** Notified once when a run reaches a terminal state. */
  onSettled?: (view: WorkflowRunView) => void;
  /** Surfaced as a log line for the user. */
}

interface ScriptScope {
  namespace: string;
  agent?: string;
  phase?: string;
  occurrences: Map<string, number>;
  pending: number;
}

interface CachedCall {
  value?: unknown;
  isNull?: boolean;
  entry: WorkflowJournalEntry;
}

interface LiveCall {
  callKey: string;
  label: string;
  phase?: string;
  agentType: string;
  status: WorkflowJournalEntry["status"];
  requestedAt: number;
  /** Kept for the journal, so a call can be audited after the run. */
  prompt: string;
  startedAt?: number;
  finishedAt?: number;
  name?: string;
  sessionFile?: string;
  sessionId?: string;
  model?: string;
  error?: string;
  usage?: WorkflowUsage;
  cached?: boolean;
  /** Borrowed from a predecessor run: shown, never charged to this budget. */
  replayed?: boolean;
  previousUsage?: WorkflowUsage;
}

export class WorkflowLimitError extends Error {}

/** Raised when a run's token budget is spent. Fatal to the run, not to one call. */
export class WorkflowBudgetExceededError extends Error {}

/**
 * One in-flight or finished run. Holds the scheduling state the script's
 * globals mutate, so everything the panel shows is derived from one place.
 */
export class WorkflowRun {
  readonly runId: string;
  readonly meta: WorkflowMeta;
  /** Script body (meta export rewritten) as executed by the sandbox. */
  readonly scriptSource: string;
  /** Script source as the user wrote it, persisted for resume. */
  readonly source: string;
  readonly runDir: string;
  readonly snapshot: WorkflowRunSnapshot;

  status: WorkflowRunStatus = "running";
  phase?: string;
  /** Script-side inactivity budget; overridable for tests. */
  scriptTimeoutMs = 30 * 60 * 1000;
  /**
   * How long one agent call may stay in flight before the run gives up on it.
   * The script watchdog deliberately stays quiet while the host still owes the
   * script an answer, so a wedged agent would otherwise hold the run open
   * forever: this ceiling turns "dead agent" into "failed call" (the script
   * continues with null) instead of a run that never ends. It only has to
   * catch a dead agent, never a slow one, so it is generous.
   */
  callTimeoutMs = callCeilingFromEnv();
  /**
   * How much waiting on an answer stays exempt from the call ceiling. Infinite
   * by default: waiting is the state the run asked for, and a process that
   * exited is settled by its watcher, so the runtime never guesses that a
   * silent wait is a dead one. An explicit budget (env or test hook) trades
   * that safety for a bound.
   */
  waitAllowanceMs = waitAllowanceFromEnv();
  error?: string;
  result?: unknown;

  private readonly manager: WorkflowManagerOptions;
  private readonly journalFile: string;
  private lockPath?: string;
  private readonly abortController = new AbortController();
  private readonly cache: Map<string, CachedCall>;
  private readonly live = new Map<string, LiveCall>();
  private readonly running = new Map<string, WorkflowSubagentHandle>();
  /**
   * Releases a call's scheduling slot the moment the call is decided as
   * abandoned (skipped) while its launch task waits on the agent. The slot is a
   * runtime resource: a watcher that never settles must not hold it until the
   * call ceiling. A skip that lands before the spawn returns is covered too, but
   * the pending spawn is cancelled as well, and any late handle is stopped.
   */
  private readonly abandonment = new Map<string, AbortController>();
  /**
   * True when the seeded cache is this run's own journal (a resume): those
   * tokens were charged to this run's budget. A same-name/same-args start
   * replays a *predecessor* run's calls instead, and charging them again would
   * hand the fresh run a budget that its first call may already have spent.
   */
  private readonly cachedUsageIsSpent: boolean;
  /** Call keys whose borrowed answer is already journaled in this run. */
  private readonly replayedLogged = new Set<string>();
  /**
   * Releases a scheduling slot early. A call holds its slot while its launch
   * task runs, but a call settled before that task returns (skipped, or the run
   * aborted) must not keep the queue waiting on a launcher that is still
   * opening a pane: the slot is a runtime resource, not the launcher's.
   */
  private readonly slotReleases = new Map<string, () => void>();
  /**
   * Names this run has handed out but the service has not seen yet: the service
   * only learns a name once its pane launch resolves, so without a local claim
   * a fan-out of same-label calls reads one taken-set and picks one name.
   */
  private readonly reservedNames = new Set<string>();
  private readonly waiters = new Map<string, Array<(outcome: WorkflowAgentOutcome) => void>>();
  private readonly queue: Array<() => void> = [];
  /**
   * How many times each content key has been issued. Two calls with the same
   * label, prompt, schema and agent are still two calls — the ordinal keeps
   * them apart in the journal, in the panel, and in the cache.
   */
  private readonly occurrences = new Map<string, number>();
  private readonly nestedOccurrences = new Map<string, number>();
  private nestedCalls = 0;
  private activeChildren = 0;
  private historicalSpent = 0;
  private logs: string[] = [];
  /** Notes trimmed off the front of `logs`. */
  private logsDropped = 0;
  private activeAgents = 0;
  /** Every agent this run has actually launched, for the lifetime cap. */
  private launchedAgents = 0;
  private finished = false;
  private settledNotified = false;
  private lastSnapshotAt = 0;
  /** Wall-clock start of this execution; the VM clock is replayed on resume. */
  private executionStartedWall: number;
  private predecessorLogged = false;

  constructor(
    managerOptions: WorkflowManagerOptions,
    params: {
      runId: string;
      meta: WorkflowMeta;
      scriptSource: string;
      source: string;
      args: unknown;
      seed: number;
      startedAt: number;
      cache: Map<string, CachedCall>;
      lockPath?: string;
      resumedFrom?: string;
      budgetTotal?: number;
      cachedUsageIsSpent?: boolean;
      priorSpent?: number;
      priorAttempts?: number;
    },
  ) {
    this.manager = managerOptions;
    this.runId = params.runId;
    this.meta = params.meta;
    this.scriptSource = params.scriptSource;
    this.source = params.source;
    this.lockPath = params.lockPath;
    this.cache = params.cache;
    this.cachedUsageIsSpent = params.cachedUsageIsSpent === true;
    this.executionStartedWall = Date.now();

    this.runDir = ensureRunDir(managerOptions.baseDir, params.runId);
    this.journalFile = journalPath(this.runDir);

    this.snapshot = {
      version: 1,
      runId: params.runId,
      meta: params.meta,
      scriptPath: scriptPath(this.runDir),
      scriptHash: sha256(params.source),
      source: params.source,
      args: params.args,
      seed: params.seed,
      startedAt: params.startedAt,
      sessionFile: managerOptions.sessionFile,
      sessionId: managerOptions.sessionId,
      cwd: managerOptions.cwd,
      status: "running",
      createdAt: params.startedAt,
      updatedAt: params.startedAt,
      agentCount: 0,
      ...(params.resumedFrom ? { resumedFrom: params.resumedFrom } : {}),
    };

    // Seed the live view from the journal so a resumed run immediately shows
    // the calls it will not re-run.
    const budgetTotal = params.budgetTotal ?? managerOptions.budgetTotal ?? undefined;
    if (budgetTotal && budgetTotal > 0) this.snapshot.budgetTotal = budgetTotal;

    for (const entry of params.cache.values()) {
      this.live.set(entry.entry.callKey, {
        callKey: entry.entry.callKey,
        label: entry.entry.label,
        phase: entry.entry.phase,
        agentType: entry.entry.agentType,
        status: entry.entry.status,
        requestedAt: entry.entry.startedAt ?? params.startedAt,
        prompt: "",
        startedAt: entry.entry.startedAt,
        finishedAt: entry.entry.finishedAt,
        name: entry.entry.name,
        sessionFile: entry.entry.sessionFile,
        sessionId: entry.entry.sessionId,
        model: entry.entry.model,
        error: entry.entry.error,
        usage: entry.entry.usage,
        cached: true,
        replayed: entry.entry.replayed === true,
      });
    }
    this.historicalSpent = Math.max(0, (params.priorSpent ?? 0) - this.budgetView().spent);
    this.launchedAgents = params.priorAttempts ?? 0;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** The run's lock file, released when the run settles. */
  setLockPath(path: string): void {
    this.lockPath = path;
  }

  /**
   * Override the script's inactivity budget. The default is generous (30 min)
   * because a workflow legitimately waits on agents and humans; tests and
   * callers that want a tighter leash set it before `execute()`.
   */
  setScriptTimeout(ms: number): void {
    this.scriptTimeoutMs = Math.max(100, Math.floor(ms));
  }

  /** Override the per-call ceiling; tests use it to reach the timeout quickly. */
  setCallTimeout(ms: number): void {
    this.callTimeoutMs = ms === Number.POSITIVE_INFINITY ? ms : Math.max(50, Math.floor(ms));
  }

  /** Override the wait allowance; tests use it to bound a parked agent quickly. */
  setWaitAllowance(ms: number): void {
    this.waitAllowanceMs = Math.max(0, Math.floor(ms));
  }

  private get maxConcurrent(): number {
    return defaultConcurrency();
  }

  private now(): number {
    return this.manager.now?.() ?? Date.now();
  }

  // ── script globals ──────────────────────────────────────────────────────

  /** Dispatch one call from the VM. Always answers, so the script never hangs. */
  async dispatch(call: CodemodeHostCall, deliver: (outcome: CodemodeOutcome) => void, scope?: ScriptScope): Promise<void> {
    const scopedAgent = scope && call.name === '__wfBridgeAgent';
    if (scopedAgent) scope.pending++;
    try {
      const answer = await this.handle(call, scope);
      deliver(answer);
    } catch (error: any) {
      const message = error?.message ?? String(error);
      if (error instanceof WorkflowBudgetExceededError) {
        // Fatal, not a rejected call: a budget loop swallows rejections through
        // `parallel`'s null, and would keep issuing calls until the wall clock.
        this.failRun(message);
        deliver({ ok: false, message });
      } else if (error instanceof WorkflowLimitError || error instanceof WorkflowScriptError) {
        // Tagged so the script prelude can tell an author mistake from a thunk's
        // own throw: `parallel`/`pipeline` swallow rejections into null, which
        // would turn "unknown agent" into "no result" and complete the run.
        deliver({ ok: false, message, properties: { workflowAuthorError: true } });
      } else {
        deliver({ ok: false, message: `internal error in ${call.name}(): ${message}` });
      }
    } finally { if (scopedAgent) scope.pending--; }
  }

  private async handle(call: CodemodeHostCall, scope?: ScriptScope): Promise<CodemodeOutcome> {
    const first = firstArg(call);
    switch (call.name) {
      case "__wfBridgeAgent":
        return { ok: true, value: await this.runAgentCall(first, scope) };
      case "__wfBridgePhase":
        if (scope) scope.phase = `${scope.namespace}: ${stringArg(first)}`;
        else this.setPhase(stringArg(first));
        return { ok: true, value: null };
      case "__wfBridgeLog":
        this.note(stringArg(first));
        return { ok: true, value: null };
      case "__wfBridgeBudget": {
        // The script's `budget` object reads through this with a field name:
        // one snapshot for `total`, then a live read per `spent()`/`remaining()`.
        const field = stringArg(first);
        const view = this.budgetView();
        if (field === "spent") return { ok: true, value: view.spent };
        if (field === "remaining") return { ok: true, value: view.remaining };
        return { ok: true, value: { total: view.total, spent: view.spent, remaining: view.remaining } };
      }
      case "__wfBridgeWorkflow":
        if (scope) throw new WorkflowScriptError("Maximum nested workflow depth is one: a child cannot nest another workflow.");
        return { ok: true, value: await this.runNestedCall(first) };
      default:
        return { ok: false, message: `unknown workflow primitive \`${call.name}\`` };
    }
  }

  /** Resolve the script-side handle for `agent(prompt, opts)`. */
  private async runAgentCall(raw: unknown, scope?: ScriptScope): Promise<unknown> {
    const parsed = parseAgentArgs(raw);
    const defined = this.manager.service.allowedAgents();
    const requestedAgent = parsed.opts.agent ?? (scope ? scope.agent : this.meta.agent);
    // Keep user-provided legacy definitions; only the removed bundled name is
    // an alias. Authorization still checks the effective worker definition.
    const legacyAlias = requestedAgent === "workflow-subagent" && defined.unknown(requestedAgent);
    const agentType = legacyAlias ? "worker" : requestedAgent ??
      inferAgentType(defined.allowed, (name) => this.manager.service.agentKind(name));
    if (!agentType) {
      throw new WorkflowScriptError(
        `agent() needs an agent type: none was given and none is configured. Available: ${defined.allowed.join(", ") || "(none)"}.`,
      );
    }
    if (defined.unknown(agentType)) {
      throw new WorkflowScriptError(
        `agent() called with unknown agent "${agentType}". Available: ${defined.allowed.join(", ") || "(none)"}.`,
      );
    }
    if (!parsed.prompt.trim()) {
      throw new WorkflowScriptError("agent() requires a non-empty prompt.");
    }
    if (parsed.opts.readOnly && this.manager.service.agentKind(agentType) === "cli") {
      throw new WorkflowScriptError("readOnly requires a Pi agent; external CLI permissions cannot be enforced.");
    }
    // A `cli:` definition is an external coding agent: it runs its own toolset
    // and cannot answer through a schema sidecar. Say so here rather than
    // letting the child finish and reporting that it never called the tool.
    if (parsed.opts.schema && this.manager.service.agentKind(agentType) === "cli") {
      throw new WorkflowScriptError(
        `agent() asked "${agentType}" for a structured result, but that definition is an external CLI ` +
          "(cli:), which cannot return one. Use a pi agent for schema calls, or drop the schema.",
      );
    }

    let label = parsed.opts.label?.trim() || (legacyAlias ? "workflow-subagent" : agentType);
    const identity = {
      kind: scope ? `agent:${scope.namespace}` : "agent",
      label,
      prompt: parsed.prompt,
      schema: parsed.opts.schema,
      agent: legacyAlias ? "workflow-subagent" : agentType,
      model: parsed.opts.model,
      effort: parsed.opts.effort,
      ...(parsed.opts.readOnly ? { readOnly: true } : {}),
      ...(parsed.opts.isolation ? { isolation: parsed.opts.isolation } : {}),
    };
    let base = makeCallKey(identity);
    const hasNamespace = (prefix: string) => [...this.cache.keys()].some(key => key === prefix || key.startsWith(prefix + "-"));
    // Old journals keyed a call by its cosmetic label. When the current key has
    // no namespace, look under the legacy algorithm before treating this as new
    // work, trying the shapes an older run could have written: its own label,
    // the removed default name, and the worker/workflow-subagent alias. An
    // isolated call never falls back — it must not replay a call that ran in the
    // workspace instead of in its worktree.
    if (!hasNamespace(base)) {
      // The removed default agent was recorded under its own name in current
      // journals too, so try the aliases under this algorithm first — an
      // isolated call included, because the key already carries the isolation.
      const aliasAgents = requestedAgent ? [identity.agent] : [identity.agent, "worker", "workflow-subagent"];
      const alias = aliasAgents
        .map(agent => makeCallKey({ ...identity, agent }))
        .find(candidate => hasNamespace(candidate));
      if (alias) {
        base = alias;
      } else if (parsed.opts.isolation !== "worktree") {
        // Old journals keyed a call by its cosmetic label. Try the shapes an
        // older run could have written; an isolated call never falls back here,
        // because that would replay a call that ran in the workspace.
        const legacyAgents = [identity.agent];
        const legacyLabels = [label];
        if (!requestedAgent) {
          legacyAgents.push("worker", "workflow-subagent");
          legacyLabels.push("workflow-subagent");
        }
        const legacy = legacyAgents
          .flatMap(agent => legacyLabels.map(legacyLabel => ({ agent, legacyLabel })))
          .map(candidate => ({
            ...candidate,
            key: makeLegacyCallKey({ ...identity, agent: candidate.agent, label: candidate.legacyLabel }),
          }))
          .find(candidate => hasNamespace(candidate.key));
        if (legacy) { base = legacy.key; label = legacy.legacyLabel; }
      }
    }
    const occurrences = scope?.occurrences ?? this.occurrences;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const key = occurrenceKey(base, occurrence);

    if (!this.predecessorLogged && this.cache.size > 0) {
      this.predecessorLogged = true;
      this.note(
        `reusing ${this.cache.size} completed call(s) from run ${this.snapshot.resumedFrom ?? "an earlier run"}; only changed calls run`,
      );
    }
    const cached = this.cache.get(key);
    if (cached) {
      const replayed = cached.entry.replayed === true || !this.cachedUsageIsSpent;
      this.live.set(key, {
        callKey: key,
        label,
        phase: parsed.opts.phase ?? scope?.phase ?? this.phase,
        agentType,
        status: cached.entry.status,
        requestedAt: this.now(),
        prompt: parsed.prompt,
        startedAt: cached.entry.startedAt,
        finishedAt: cached.entry.finishedAt,
        name: cached.entry.name,
        sessionFile: cached.entry.sessionFile,
        sessionId: cached.entry.sessionId,
        model: cached.entry.model,
        usage: cached.entry.usage,
        cached: true,
        replayed,
      });
      // A borrowed answer must exist in *this* run's journal: a later resume of
      // this run reads only its own journal, and without the line the call would
      // look unfinished and be re-run — repeating whatever side effects the
      // predecessor's agent already had. The line is marked so budget accounting
      // and a following reuse still treat its tokens as somebody else's.
      if (!this.cachedUsageIsSpent && !this.replayedLogged.has(key)) {
        try {
          appendJournal(this.journalFile, {
            ...cached.entry,
            type: "call",
            callKey: key,
            label,
            prompt: parsed.prompt,
            replayed: true,
          });
          this.replayedLogged.add(key);
        } catch (error: any) {
          throw new WorkflowScriptError(`Could not persist borrowed workflow result: ${error?.message ?? error}`);
        }
      }
      return cached.value ?? null;
    }

    const liveCall: LiveCall = {
      callKey: key,
      label,
      phase: parsed.opts.phase ?? scope?.phase ?? this.phase,
      agentType,
      status: "queued",
      requestedAt: this.now(),
      prompt: parsed.prompt,
    };
    this.live.set(key, liveCall);
    this.launchedAgents++;
    this.assertAgentBudget();
    this.assertBudget();
    this.persistSnapshot(true);

    const promise = new Promise<WorkflowAgentOutcome>((resolve) => {
      const list = this.waiters.get(key) ?? [];
      list.push(resolve);
      this.waiters.set(key, list);
    });

    this.enqueue(key, async () => {
      let outcome: WorkflowAgentOutcome;
      try {
        outcome = await this.launchWithRetries(liveCall, parsed);
      } catch (error) {
        // launchAgent reports its own failures; a rejection here means even that
        // report failed (the same full disk that broke the launch). The waiter
        // must still be resolved — a pending waiter hangs the script forever —
        // and a rejected enqueue task would escape as an unhandled rejection.
        if (error instanceof WorkflowBudgetExceededError || error instanceof WorkflowLimitError) {
          this.failRun(error.message);
          outcome = { ok: false, status: 'aborted', value: null, error: error.message };
        } else outcome = this.settleLaunchFailure(liveCall, error);
      }
      const waiters = this.waiters.get(key) ?? [];
      this.waiters.delete(key);
      for (const resolve of waiters) resolve(outcome);
    });

    const outcome = await promise;
    // A skipped call is a decision and a dead agent is a fact: the script sees
    // null and carries on, which is what `parallel`/`pipeline` already do and
    // what a script written for Claude Code expects from a bare `await`. A
    // *malformed* call (unknown agent, bad opts, over a limit) throws instead —
    // that is the author's mistake and must not read as "no result".
    if (outcome.status === "skipped" || outcome.status === "aborted") return null;
    if (!outcome.ok) {
      this.note(`${label}: ${outcome.error || outcome.status} — the call resolved to null`);
      return null;
    }
    return outcome.value ?? null;
  }

  private async runNestedCall(raw: unknown): Promise<unknown> {
    const name =
      raw && typeof raw === "object" && typeof (raw as { name?: unknown }).name === "string"
        ? ((raw as { name: string }).name)
        : stringArg(raw);
    if (!name.trim()) throw new WorkflowScriptError("workflow() requires a saved workflow name.");
    if (++this.nestedCalls > 64 || this.activeChildren >= 16) {
      throw new WorkflowLimitError("Nested workflow limit: at most 64 child invocations and 16 concurrent child scripts per run.");
    }
    const args = raw && typeof raw === "object" ? (raw as { args?: unknown }).args ?? {} : {};
    const base = sha256(JSON.stringify([name, args])).slice(0, 24);
    const occurrence = this.nestedOccurrences.get(base) ?? 0;
    this.nestedOccurrences.set(base, occurrence + 1);
    const namespace = occurrenceKey(base, occurrence);
    const nestedDir = join(this.runDir, "nested");
    const saved = join(nestedDir, namespace + ".js");
    let source: string;
    if (existsSync(saved)) source = readScriptFile(saved);
    else {
      const path = resolveSavedScriptPath(name, { cwd: this.manager.cwd, agentDir: this.manager.agentDir });
      if (!path) throw new WorkflowScriptError(`No saved child workflow "${name}".`);
      source = readScriptFile(path);
      parseScript(source, path);
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(saved, source, "utf8");
    }
    const parsed = parseScript(source, saved);
    const scope: ScriptScope = { namespace, agent: parsed.meta.agent, phase: parsed.meta.name, occurrences: new Map(), pending: 0 };
    this.activeChildren++;
    try {
      const result = await runScript({
        code: wrapScript(parsed.body), args, startedAt: this.snapshot.startedAt,
        seed: (this.snapshot.seed ^ Number.parseInt(base.slice(0, 8), 16)) >>> 0,
        signal: this.signal, limits: { runTimeoutMs: this.scriptTimeoutMs }, maxItemsPerBatch: MAX_ITEMS_PER_BATCH,
        onCall: (call, deliver) => { void this.dispatch(call, deliver, scope); },
      });
      if (result.ok && scope.pending > 0 && !this.signal.aborted) {
        const message = `Child workflow "${name}" returned with unawaited agent() calls.`;
        this.failRun(message);
        throw new WorkflowScriptError(message);
      }
      if (!result.ok) throw new WorkflowScriptError(`Child workflow "${name}" failed: ${result.error?.message ?? "unknown error"}`);
      return result.value ?? null;
    } finally { this.activeChildren--; }
  }

  private async launchWithRetries(call: LiveCall, parsed: ParsedAgentArgs): Promise<WorkflowAgentOutcome> {
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.launchAgent(call, parsed);
      if (outcome.status !== 'failed' || attempt >= (parsed.opts.retries ?? 0) || this.signal.aborted) return outcome;
      this.assertBudget();
      this.launchedAgents++;
      this.assertAgentBudget();
      this.persistSnapshot(true);
      call.previousUsage = call.usage;
      call.status = 'queued';
      call.error = undefined;
      call.finishedAt = undefined;
      call.sessionFile = undefined;
      call.sessionId = undefined;
      this.note(`${call.label}: retry ${attempt + 1}/${parsed.opts.retries}`);
    }
  }

  // ── agent scheduling ────────────────────────────────────────────────────

  private enqueue(callKey: string, task: () => Promise<void>): void {
    let started = false;
    let released = false;
    // Idempotent for both the normal end of the task and an early release.
    const release = () => {
      if (!started || released) return;
      released = true;
      this.slotReleases.delete(callKey);
      this.activeAgents--;
      const next = this.queue.shift();
      if (next) next();
    };
    this.slotReleases.set(callKey, release);
    const start = () => {
      started = true;
      this.activeAgents++;
      void task().finally(release);
    };
    if (this.activeAgents < this.maxConcurrent) start();
    else this.queue.push(start);
  }

  /**
   * The lifetime agent cap. Counted on *launches*, not on distinct keys: a
   * runaway loop that issues the same call over and over reuses one key, so
   * counting keys would never trip the backstop it exists to be.
   */
  private assertAgentBudget(): void {
    if (this.launchedAgents > MAX_AGENTS_PER_RUN) {
      throw new WorkflowLimitError(
        `Workflow exceeded ${MAX_AGENTS_PER_RUN} agents in one run; refusing to start more.`,
      );
    }
  }

  /**
   * The run's token ceiling, when one was configured. Checked before a call is
   * queued, so a loop that scales to `budget.remaining()` stops on its own and
   * a loop that ignores the budget stops here.
   */
  private assertBudget(): void {
    const view = this.budgetView();
    if (view.total === null || view.spent < view.total) return;
    throw new WorkflowBudgetExceededError(
      `Workflow budget exhausted: ${view.spent} of ${view.total} tokens spent. ` +
        "Raise PI_WORKFLOW_TOKEN_BUDGET, or make the script scale its work to budget.remaining().",
    );
  }

  /** Stop a run that cannot continue, with the same teardown as an abort. */
  private failRun(message: string): void {
    if (this.finished) return;
    this.status = "failed";
    this.error = message;
    this.snapshot.status = "failed";
    this.snapshot.error = message;
    this.snapshot.finishedAt = this.now();
    this.teardown(message);
    // Every other snapshot write is throttled to once a second, and execute()
    // only force-persists while it still owns a "running" snapshot — which this
    // method just changed. Without this the run's terminal state never reaches
    // snapshot.json, and a restart shows it as still running.
    this.persistSnapshot(true);
  }

  /**
   * Stop everything the run owns: abort the script, close the panes, and settle
   * every waiting call so the script's `await` cannot hang.
   *
   * Shared by abort and by a fatal failure, because a run that failed on its
   * own must not leave agents running and a queue still launching panes — the
   * script is over, but nothing else knows it.
   */
  private teardown(reason: string): void {
    this.abortController.abort(new Error(reason));
    // Cancel launches that are still opening panes: their children must never
    // start, and their slots must come back without waiting for the launcher.
    for (const controller of this.abandonment.values()) controller.abort();
    for (const handle of this.running.values()) this.manager.service.stop(handle.name);
    // Drain rather than clear: a queued task that never starts would leave its
    // caller waiting forever.
    const queue = this.queue.splice(0);
    for (const start of queue) start();
    for (const live of this.live.values()) {
      if (!isCallSettled(live.status)) {
        try { this.recordOutcome(live, { ok: false, status: "aborted", value: null, error: reason }); }
        catch { live.status = 'aborted'; live.error = reason; live.finishedAt = this.now(); }
      }
    }
    for (const [key, waiters] of this.waiters) {
      this.waiters.delete(key);
      for (const resolve of waiters) resolve({ ok: false, status: "aborted", value: null, error: reason });
    }
    // Release whatever the launch tasks were still holding. Their own
    // finally-handlers no-op afterwards, so nothing is double-counted.
    for (const release of [...this.slotReleases.values()]) release();
  }

  private async launchAgent(liveCall: LiveCall, parsed: ParsedAgentArgs): Promise<WorkflowAgentOutcome> {
    if (this.abortController.signal.aborted) {
      return this.recordOutcome(liveCall, {
        ok: false,
        status: "aborted",
        value: null,
        error: "run aborted",
      });
    }
    // A call the user skipped while it was still queued is settled: the script
    // has already acted on that decision. Launching it now would open a pane
    // nobody waits for and journal a second, "completed" line for the same
    // call — which resume would replay as a real answer.
    if (isCallSettled(liveCall.status)) {
      return { ok: false, status: liveCall.status, value: null, error: liveCall.error };
    }

    liveCall.status = "running";
    liveCall.startedAt = this.now();

    // Structured results go through a sidecar: schema file in, result file out,
    // both scoped to this call so parallel calls cannot collide. The writes are
    // issued inside the try below: a full disk or an unwritable run directory
    // must settle this call like any other launch failure.
    const callDir = join(this.runDir, "calls", liveCall.callKey);
    let schemaFile: string | undefined;
    let resultFile: string | undefined;

    const task = parsed.opts.schema
      ? `${parsed.prompt}\n\nReturn the result by calling structured_output exactly once with your final answer.`
      : parsed.prompt;

    let name = this.uniqueName(liveCall.label);
    liveCall.name = name;

    // Registered before the spawn so a skip that lands while the pane is still
    // launching cancels the launch and releases its slot immediately. A service
    // that ignores cancellation still has its late handle stopped on return.
    const abandonment = new AbortController();
    this.abandonment.set(liveCall.callKey, abandonment);

    try {
      mkdirSync(callDir, { recursive: true });
      if (parsed.opts.schema) {
        schemaFile = join(callDir, "schema.json");
        resultFile = join(callDir, "result.json");
        writeJsonAtomic(schemaFile, parsed.opts.schema);
        // A retry of this call must not inherit the previous attempt's answer:
        // a child that never calls structured_output would otherwise be
        // reported as having returned the old value.
        try {
          unlinkSync(resultFile);
        } catch {
          // No previous result; nothing to clear.
        }
      }

      const cwd = parsed.opts.isolation === 'worktree'
        ? (await prepareWorkflowWorktree({ cwd: this.manager.cwd, runDir: this.runDir, callKey: liveCall.callKey, signal: abandonment.signal })).cwd
        : this.manager.cwd;
      if (abandonment.signal.aborted || this.signal.aborted) {
        return { ok: false, status: liveCall.status, value: null, error: liveCall.error };
      }
      // Worktree preparation yielded: another run may have claimed our proposed
      // display name. Recheck immediately before spawn reserves it synchronously.
      if (this.manager.service.takenNames().has(name)) {
        name = this.uniqueName(liveCall.label);
        liveCall.name = name;
      }
      const handle = await this.manager.service.spawn({
        agentType: liveCall.agentType,
        ...(parsed.opts.readOnly ? { readOnly: true } : {}),
        name,
        task,
        // Model and effort stay separate: the effort applies to whichever model
        // this call resolved to, so `{ effort: 'low' }` on its own works — it
        // lowers the definition's model rather than needing a model of its own.
        ...(parsed.opts.model ? { model: parsed.opts.model } : {}),
        ...(parsed.opts.effort ? { effort: parsed.opts.effort } : {}),
        schemaFile,
        resultFile,
        extraExtensions:
          parsed.opts.schema && this.manager.structuredOutputExtension
            ? [this.manager.structuredOutputExtension]
            : undefined,
        cwd,
        // Cancels a spawn whose call is settled before the pane exists. The
        // launcher closes anything it opened and never starts the child.
        signal: abandonment.signal,
      });
      // Own the completion before any branch can walk away from it. Every path
      // below (a settled call, a timeout, an abort) stops waiting at some point,
      // and a watcher that throws after its pane is closed must not surface as
      // an unhandled rejection. One handler here covers all of them.
      const completion = settleCompletion(handle.completion);
      liveCall.sessionFile = handle.sessionFile;
      // A skip (or an abort) can land while the pane is still launching: the
      // call is then already settled and has no handle to stop, so the handle
      // that arrives late must be closed here. Otherwise a call the user
      // declined keeps a live pane and keeps writing files, and its journal
      // line would be written over the decision that was already acted on.
      if (isCallSettled(liveCall.status)) {
        this.manager.service.stop(handle.name);
        return {
          ok: false,
          status: liveCall.status,
          value: null,
          ...(liveCall.error ? { error: liveCall.error } : {}),
        };
      }
      this.running.set(liveCall.callKey, handle);

      const ended = await withRunAbort(
        completion,
        this.abortController.signal,
        parsed.opts.stallTimeoutMs ?? this.callTimeoutMs,
        () => this.manager.service.status(handle.name)?.kind === "waiting",
        this.waitAllowanceMs,
        abandonment.signal,
      );
      if (ended.ended === "aborted") {
        this.manager.service.stop(handle.name);
        return this.recordOutcome(liveCall, {
          ok: false,
          status: "aborted",
          value: null,
          error: "run aborted while the agent was running",
        });
      }
      if (ended.ended === "abandoned") {
        // skip() already stopped the agent and resolved the script's waiter, so
        // there is nothing to journal and nothing to stop: returning here is
        // what releases the scheduling slot the launch task was holding.
        return {
          ok: false,
          status: liveCall.status,
          value: null,
          ...(liveCall.error ? { error: liveCall.error } : {}),
        };
      }
      if (ended.ended === "rejected") {
        this.manager.service.stop(handle.name);
        throw ended.error;
      }
      if (ended.ended === "timeout") {
        // The run is healthy and every other call is unaffected: stop this one
        // agent, journal the call as failed, and let the script see null.
        // Killing the whole run for one wedged agent is what makes a hung agent
        // look like an infrastructure error.
        this.manager.service.stop(handle.name);
        return this.recordOutcome(liveCall, {
          ok: false,
          status: "failed",
          value: null,
          error:
            `agent ran for ${formatMinutes(parsed.opts.stallTimeoutMs ?? this.callTimeoutMs)} of work without finishing and was stopped` +
            waitBudgetHint(this.waitAllowanceMs) +
            "; the call limit is the run's per-call ceiling, not a script deadline. " +
            "Split the task, raise PI_WORKFLOW_CALL_TIMEOUT_MS, or run it outside the workflow.",
        });
      }

      // The completion never rejects by now: its rejection became this value at
      // the point the handle arrived, so it is reported like any other failure.
      if (!ended.value.ok) {
        this.manager.service.stop(handle.name);
        throw ended.value.error;
      }
      const result = ended.value.value;
      // A non-zero exit is a failure whatever the agent left behind, and the
      // watcher does not always explain it (the "closed" reason path omits the
      // error text). Decide it before reading the sidecar: a stale structured
      // result or a half-finished summary must never turn a dead agent into a
      // successful answer.
      if (result.exitCode !== 0) {
        return this.recordOutcome(liveCall, {
          ok: false,
          status: "failed",
          value: null,
          error: result.error ?? `agent exited with code ${result.exitCode}`,
          session: { sessionId: result.sessionId, usage: result.usage, model: result.usage?.model ?? parsed.opts.model },
          completion: result,
        });
      }
      const structured = parsed.opts.schema ? readStructuredResult(resultFile) : undefined;
      if (parsed.opts.schema && structured?.error) {
        return this.recordOutcome(liveCall, {
          ok: false,
          status: "failed",
          value: null,
          error: structured.error,
          session: { sessionId: result.sessionId, usage: result.usage, model: result.usage?.model ?? parsed.opts.model },
          completion: result,
        });
      }

      const value = parsed.opts.schema ? structured?.value ?? null : result.summary;
      if (parsed.opts.schema && !Value.Check(workflowResultSchema(parsed.opts.schema), value)) {
        return this.recordOutcome(liveCall, {
          ok: false, status: 'failed', value: null, error: 'structured output does not match the schema',
          session: { sessionId: result.sessionId, usage: result.usage, model: result.usage?.model ?? parsed.opts.model },
          completion: result,
        });
      }
      return this.recordOutcome(liveCall, {
        ok: true,
        status: "completed",
        value,
        session: { sessionId: result.sessionId, usage: result.usage, model: result.usage?.model ?? parsed.opts.model },
        completion: result,
      });
    } catch (error: any) {
      return this.recordOutcome(liveCall, {
        ok: false,
        status: "failed",
        value: null,
        error: error?.message ?? String(error),
      });
    } finally {
      this.abandonment.delete(liveCall.callKey);
      this.running.delete(liveCall.callKey);
    }
  }

  /**
   * Settle a call whose launch threw before it could report an outcome.
   *
   * The normal path records the failure and journals it; here that recording is
   * what threw (an unwritable journal). The call still settles in memory so the
   * script receives its null and the run can finish, and a second throw would
   * leave the waiter pending and surface as another unhandled rejection. A call
   * a skip or abort already decided keeps that decision.
   */
  private settleLaunchFailure(liveCall: LiveCall, error: unknown): WorkflowAgentOutcome {
    const message = error instanceof Error ? error.message : String(error);
    if (liveCall.status === 'skipped' || liveCall.status === 'aborted') {
      return { ok: false, status: liveCall.status, value: null, error: liveCall.error ?? message };
    }
    try {
      return this.recordOutcome(liveCall, { ok: false, status: "failed", value: null, error: message });
    } catch {
      liveCall.status = "failed";
      liveCall.finishedAt = this.now();
      liveCall.error = message;
      return { ok: false, status: "failed", value: null, error: message };
    }
  }

  private recordOutcome(
    liveCall: LiveCall,
    params: {
      ok: boolean;
      status: WorkflowJournalEntry["status"];
      value: unknown;
      error?: string;
      session?: { sessionId?: string; usage?: WorkflowUsage; model?: string };
      completion?: { elapsedMs?: number };
    },
  ): WorkflowAgentOutcome {
    // A call the user skipped (or the run aborted) already settled: the agent
    // may still exit afterwards, and that late result must not overwrite the
    // decision the script has already acted on.
    if (liveCall.status === "skipped" || liveCall.status === "aborted") {
      return { ok: false, status: liveCall.status, value: null, error: liveCall.error };
    }
    const finishedAt = this.now();
    const durationMs = liveCall.startedAt ? finishedAt - liveCall.startedAt : undefined;
    liveCall.status = params.status;
    liveCall.finishedAt = finishedAt;
    liveCall.error = params.error;
    liveCall.sessionId = params.session?.sessionId;
    const observed = params.session?.usage ?? usageFromSession(liveCall.sessionFile);
    if (observed) liveCall.usage = addUsage(liveCall.previousUsage, observed);
    liveCall.model = params.session?.model;

    const entry: WorkflowJournalEntry = {
      type: "call",
      callKey: liveCall.callKey,
      attemptTokens: observed?.totalTokens ?? 0,
      label: liveCall.label,
      phase: liveCall.phase,
      agentType: liveCall.agentType,
      prompt: liveCall.prompt,
      status: params.status,
      name: liveCall.name,
      sessionFile: liveCall.sessionFile,
      sessionId: liveCall.sessionId,
      model: liveCall.model,
      startedAt: liveCall.startedAt,
      finishedAt,
      durationMs,
      ...(params.value === null || params.value === undefined
        ? { valueIsNull: true }
        : { value: params.value }),
      ...(params.error ? { error: params.error } : {}),
      ...(liveCall.usage ? { usage: liveCall.usage } : {}),
    };
    // Write before the script can observe the value: a crash must never leave a
    // result that was consumed but not recorded.
    this.snapshot.agentCount = this.live.size;
    this.snapshot.spentTokens = this.budgetView().spent;
    this.snapshot.agentAttempts = this.launchedAgents;
    appendJournal(this.journalFile, entry);
    this.persistSnapshot();

    return { ok: params.ok, status: params.status, value: params.value ?? null, error: params.error };
  }

  private uniqueName(base: string): string {
    const taken = this.manager.service.takenNames();
    // This run's own claims matter as much as the service's: a same-label
    // fan-out resolves all its names before the first pane launch registers
    // one, and duplicate names make stop/focus/message ambiguous.
    for (const reserved of this.reservedNames) taken.add(reserved);
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    const prefix = `${this.meta.name}-${slug}`.slice(0, 48);
    let candidate = prefix;
    let n = 2;
    while (taken.has(candidate)) candidate = `${prefix}-${n++}`;
    this.reservedNames.add(candidate);
    return candidate;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  async execute(): Promise<WorkflowRunView> {
    this.persistSnapshot();
    const code = wrapScript(this.scriptSource);
    const startedWall = this.now();
    this.executionStartedWall = startedWall;

    const result = await runScript({
      code,
      args: this.snapshot.args,
      startedAt: this.snapshot.startedAt,
      seed: this.snapshot.seed,
      signal: this.abortController.signal,
      limits: { runTimeoutMs: this.scriptTimeoutMs },
      maxItemsPerBatch: MAX_ITEMS_PER_BATCH,
      onCall: (call, deliver) => {
        void this.dispatch(call, deliver);
      },
    });

    if (result.ok && (this.waiters.size > 0 || this.activeChildren > 0) && !this.signal.aborted) {
      this.failRun('Workflow returned with unawaited agent() or workflow() calls; await all child work before returning.');
    }

    if (this.snapshot.status === "running") {
      const aborted = this.abortController.signal.aborted;
      if (aborted) {
        // An abort is a decision, not an outcome. The script can still finish
        // afterwards — an aborted or skipped call resolves to null — and that
        // must not turn a run the user cancelled into a completed one.
        this.status = "aborted";
        this.error = this.abortController.signal.reason instanceof Error
          ? (this.abortController.signal.reason as Error).message
          : this.error ?? "aborted by user";
        this.snapshot.error = this.error;
      } else if (result.ok) {
        this.status = "completed";
        this.result = result.value;
        this.snapshot.result = result.value ?? null;
        try {
          writeJsonAtomic(outputPath(this.runDir), { ok: true, value: result.value ?? null });
        } catch {
          // The run result is also in the snapshot; a missing output file is not fatal.
        }
      } else {
        this.status = "failed";
        this.error = result.error?.message ?? "workflow failed";
        this.snapshot.error = this.error;
        // A script that failed on its own (syntax error, thrown error, the
        // watchdog) has not stopped its agents or its queue: they would keep
        // opening panes and spending tokens after the run is already over.
        this.teardown(this.error);
      }
      this.snapshot.status = this.status;
      this.snapshot.finishedAt = this.now();
      this.persistSnapshot(true);
    }

    this.finish();
    return this.view();
  }

  abort(reason = "aborted by user"): void {
    if (this.finished) return;
    this.status = "aborted";
    this.error = reason;
    this.teardown(reason);
  }

  /** Mark a queued or running call as skipped by the user. */
  skip(callKey: string): boolean {
    const live = this.live.get(callKey);
    if (!live || isCallSettled(live.status)) return false;
    const attemptUsage = usageFromSession(live.sessionFile);
    live.usage = addUsage(live.previousUsage, attemptUsage) ?? live.usage;
    const entry: WorkflowJournalEntry = {
      type: "call",
      callKey,
      attemptTokens: attemptUsage?.totalTokens ?? 0,
      label: live.label,
      phase: live.phase,
      agentType: live.agentType,
      prompt: "",
      status: "skipped",
      name: live.name,
      sessionFile: live.sessionFile,
      sessionId: live.sessionId,
      startedAt: live.startedAt,
      finishedAt: this.now(),
      valueIsNull: true,
      error: "skipped by user",
      ...(live.usage ? { usage: live.usage } : {}),
    };
    appendJournal(this.journalFile, entry);
    const handle = this.running.get(callKey);
    if (handle) this.manager.service.stop(handle.name);
    // Stop the launch task from waiting on a watcher that may never settle: the
    // call is decided, and its slot has to go back to the queue now.
    this.abandonment.get(callKey)?.abort();
    // The spawn may still be opening its pane; the queue must not wait for it.
    this.slotReleases.get(callKey)?.();
    const waiters = this.waiters.get(callKey);
    this.waiters.delete(callKey);
    if (waiters) for (const resolve of waiters) resolve({ ok: false, status: "skipped", value: null, error: "skipped by user" });
    live.status = "skipped";
    live.finishedAt = this.now();
    live.error = "skipped by user";
    this.snapshot.spentTokens = this.budgetView().spent;
    this.snapshot.agentAttempts = this.launchedAgents;
    this.persistSnapshot(true);
    return true;
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.lockPath) releaseLock(this.lockPath);
    const view = this.view();
    if (!this.settledNotified) {
      this.settledNotified = true;
      this.manager.onSettled?.(view);
    }
  }

  isFinished(): boolean {
    return this.finished;
  }

  private setPhase(title: string): void {
    if (!title.trim()) return;
    this.phase = title.trim();
    this.snapshot.phase = this.phase;
  }

  /** Append a run-level note to the log list (bounded, like the script's `log()`). */
  note(message: string): void {
    this.logs.push(message);
    if (this.logs.length > MAX_NOTES) {
      // Trimmed, not silently: a panel showing the tail of a long log without
      // saying so reads as the whole story.
      this.logsDropped += this.logs.length - MAX_NOTES;
      this.logs = this.logs.slice(-MAX_NOTES);
    }
  }

  private persistSnapshot(force = false): void {
    this.snapshot.spentTokens = this.budgetView().spent;
    this.snapshot.agentAttempts = this.launchedAgents;
    const now = this.now();
    if (!force && now - this.lastSnapshotAt < 1_000) return;
    this.lastSnapshotAt = now;
    this.snapshot.updatedAt = now;
    this.snapshot.phase = this.phase;
    this.snapshot.status = this.snapshot.status === "running" && this.finished ? this.status : this.snapshot.status;
    try {
      saveSnapshot(this.runDir, this.snapshot);
    } catch {
      // Snapshots are best-effort; the journal is the durable record.
    }
  }

  // ── views ───────────────────────────────────────────────────────────────

  /** Token budget snapshot: shared state the script reads through `budget`. */
  budgetView(): { total: number | null; spent: number; remaining: number } {
    let spent = this.historicalSpent;
    for (const call of this.live.values()) {
      // Borrowed tokens were spent by the run that produced the answer: a
      // replayed entry stays out of this budget, including after a resume of the
      // run that borrowed it.
      if (call.replayed) continue;
      if (call.cached && !this.cachedUsageIsSpent) continue; // legacy journals
      spent += call.usage?.totalTokens ?? 0;
    }
    const total = this.snapshot.budgetTotal ?? null;
    return {
      total,
      spent,
      remaining: total === null ? Number.POSITIVE_INFINITY : Math.max(0, total - spent),
    };
  }

  private viewFor(callKey: string): WorkflowAgentResultMeta | undefined {
    const live = this.live.get(callKey);
    if (!live) return undefined;
    const status = this.manager.service.status(live.name ?? "");
    return {
      callKey: live.callKey,
      label: live.label,
      phase: live.phase,
      status: live.status,
      agentType: live.agentType,
      name: live.name,
      sessionFile: live.sessionFile,
      sessionId: live.sessionId,
      model: live.model,
      startedAt: live.startedAt,
      finishedAt: live.finishedAt,
      durationMs: live.startedAt ? (live.finishedAt ?? this.now()) - live.startedAt : undefined,
      cached: live.cached,
      error: live.error,
      usage: live.usage,
      ...(status ? { live: status } : {}),
    };
  }

  view(): WorkflowRunView {
    const calls = [...this.live.keys()].map((key) => this.viewFor(key)!).filter(Boolean);
    const total = calls.length;
    const stats = summarizeCalls(calls);
    return {
      runId: this.runId,
      meta: this.meta,
      status: this.status,
      phase: this.phase,
      createdAt: this.snapshot.createdAt,
      updatedAt: this.now(),
      startedAtWall: this.executionStartedWall,
      finishedAt: this.snapshot.finishedAt,
      agentCount: calls.length,
      activeCount: stats.active,
      completedCount: stats.completed,
      failedCount: stats.failed,
      totalCount: total,
      maxConcurrent: this.maxConcurrent,
      progress: stats.progress,
      usage: stats.usage,
      budgetTotal: this.snapshot.budgetTotal,
      scriptPath: this.snapshot.scriptPath,
      runDir: this.runDir,
      sessionFile: this.snapshot.sessionFile,
      cwd: this.snapshot.cwd,
      error: this.error,
      ...(this.result === undefined ? {} : { result: this.result }),
      ...(this.snapshot.resumedFrom ? { resumedFrom: this.snapshot.resumedFrom } : {}),
      calls,
      logs: this.logs,
      logsDropped: this.logsDropped,
    };
  }
}

/** The manager: one map of live runs, plus start/resume/abort. */
export class WorkflowManager {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly options: WorkflowManagerOptions;

  constructor(options: WorkflowManagerOptions) {
    this.options = options;
  }

  list(): WorkflowRunView[] {
    return [...this.runs.values()].map((run) => run.view());
  }

  running(): WorkflowRun[] {
    return [...this.runs.values()].filter((run) => !run.isFinished());
  }

  get(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * Start a new run from script text.
   *
   * Fresh unless reuse:auto explicitly asks for the latest same-name, same-args
   * completed results. Resume continues one specific run instead.
   */
  async start(params: {
    source: string;
    args: unknown;
    budgetTotal?: number | null;
    reuse?: "auto" | "none";
  }): Promise<WorkflowRun> {
    const runId = newRunId();
    const parsed = parseScript(params.source, runId);
    // Fresh by default: a start is a new run unless the caller explicitly asks
    // for the previous answers with reuse: 'auto'.
    const predecessor =
      params.reuse === "auto" ? this.findResumablePredecessor(parsed.meta.name, params.args) : null;
    const run = new WorkflowRun(this.options, {
      runId,
      meta: parsed.meta,
      scriptSource: parsed.body,
      source: params.source,
      args: params.args,
      seed: newSeed(),
      startedAt: Date.now(),
      cache: predecessor?.cache ?? new Map(),
      lockPath: undefined,
      ...(predecessor ? { resumedFrom: predecessor.runId } : {}),
      ...(params.budgetTotal ? { budgetTotal: params.budgetTotal } : {}),
    });
    // A brand-new run id owns its directory, so this always succeeds; the lock
    // still matters because it is what blocks a second process from resuming
    // the run while this one is live.
    const lock = acquireLock(run.runDir);
    if (lock.ok) run.setLockPath(lock.path);
    writeFileSync(scriptPath(run.runDir), params.source, "utf8");
    this.runs.set(runId, run);
    return run;
  }

  /**
   * Resume a run by re-executing its script and replaying journaled calls.
   * Refuses a run that is still live in this process or locked by another.
   *
   * `source` replaces the stored script (an edit-and-continue, so the cache key
   * of every unchanged call still matches); `args` replaces the recorded inputs.
   * Both are persisted, so a second resume starts from the edited version.
   */
  async resume(runId: string, overrides?: { args?: unknown; source?: string }): Promise<WorkflowRun> {
    const existing = this.runs.get(runId);
    if (existing && !existing.isFinished()) {
      throw new WorkflowScriptError(`Run ${runId} is still running in this session.`);
    }

    const runDir = ensureRunDir(this.options.baseDir, runId);
    const snapshot = loadSnapshot(runDir);
    if (!snapshot) {
      throw new WorkflowScriptError(`No snapshot for run ${runId}.`);
    }
    const scriptFile = scriptPath(runDir);
    const edited = overrides?.source?.trim() ? overrides.source : undefined;
    if (!edited && !existsSync(scriptFile)) {
      throw new WorkflowScriptError(`Run ${runId} has no stored script; cannot resume.`);
    }
    const source = edited ?? readFileSync(scriptFile, "utf8");

    // Parse before taking the lock: a syntax error is an author mistake, and a
    // lock taken before it would strand the run as permanently unresumable.
    const parsed = parseScript(source, runId);

    const lock = acquireLock(runDir);
    if (!lock.ok) {
      throw new WorkflowScriptError(
        `Run ${runId} is locked by live process ${lock.ownerPid || "unknown"} — it is still executing. ` +
          "Abort it first, or resume after it settles. A lock left by a dead process is reclaimed automatically.",
      );
    }

    // An edited script is persisted so a second resume starts from the edit;
    // the run's own snapshot records it too. Everything below holds the lock:
    // it either ends in a running run that owns it (finish() releases it) or
    // releases it in the catch. A failure in between must not strand the lock,
    // or the same process could never resume this run again.
    let skippedLines = 0;
    let run: WorkflowRun;
    try {
      if (edited) writeFileSync(scriptFile, source, "utf8");
      const journal = loadJournal(journalPath(runDir));
      skippedLines = journal.skippedLines;
      const cache = new Map<string, CachedCall>();
      for (const [key, entry] of journal.entries) {
        if (entry.status !== "completed") continue;
        cache.set(key, { value: entry.value, isNull: entry.valueIsNull, entry });
      }
      const args = overrides && "args" in overrides ? overrides.args : snapshot.args;
      run = new WorkflowRun(this.options, {
        runId,
        meta: snapshot.meta,
        scriptSource: parsed.body,
        source,
        args,
        seed: snapshot.seed,
        startedAt: snapshot.startedAt,
        cache,
        lockPath: lock.path,
        resumedFrom: snapshot.resumedFrom,
        // A run's budget is part of what it is: resuming must not silently
        // upgrade an unbounded run to one that stops, nor drop a ceiling.
        budgetTotal: snapshot.budgetTotal ?? this.options.budgetTotal,
        // The cache came from this run's own journal, so its tokens are already
        // spent from this budget.
        cachedUsageIsSpent: true,
        priorSpent: Math.max(snapshot.spentTokens ?? 0, journal.records.reduce((total, entry) => total + (entry.replayed ? 0 : entry.attemptTokens ?? entry.usage?.totalTokens ?? 0), 0)),
        priorAttempts: Math.max(snapshot.agentAttempts ?? 0, journal.records.filter(entry => !entry.replayed).length),
      });
    } catch (error) {
      releaseLock(lock.path);
      throw error;
    }
    if (skippedLines > 0) {
      run.note(`ignored ${skippedLines} incomplete journal line(s) from the previous run`);
    }
    run.status = "running";
    this.runs.set(runId, run);
    return run;
  }

  abort(runId: string, reason?: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.abort(reason);
    return true;
  }

  abortAll(reason = "session ended"): void {
    for (const run of this.runs.values()) run.abort(reason);
  }

  /**
   * Newest completed/interrupted run of the given workflow, with reusable call
   * results and the same args, if any. Only `completed` journal entries replay;
   * failures, skips and aborts are deliberately left out so a retry retries.
   *
   * Args must match because the cache key does not include them: replaying a run
   * whose inputs changed would return answers to a different question.
   *
   * Age comes from the snapshot, not from the run ids: those are random, so
   * directory order is unrelated to when a run happened.
   */
  private findResumablePredecessor(
    workflowName: string,
    args: unknown,
  ): { runId: string; cache: Map<string, CachedCall> } | null {
    const wanted = JSON.stringify(args ?? null);
    const candidates: Array<{ runId: string; createdAt: number; cache: Map<string, CachedCall> }> = [];
    for (const runId of listRunDirs(this.options.baseDir)) {
      if (this.runs.get(runId) && !this.runs.get(runId)!.isFinished()) continue;
      const runDir = join(runsRoot(this.options.baseDir), runId);
      const snapshot = loadSnapshot(runDir);
      if (!snapshot || snapshot.meta.name !== workflowName) continue;
      if (JSON.stringify(snapshot.args ?? null) !== wanted) continue;
      const { entries } = loadJournal(journalPath(runDir));
      const cache = new Map<string, CachedCall>();
      for (const [key, entry] of entries) {
        if (entry.status !== "completed") continue;
        cache.set(key, { value: entry.value, isNull: entry.valueIsNull, entry });
      }
      if (cache.size === 0) continue;
      candidates.push({ runId, createdAt: snapshot.createdAt ?? snapshot.startedAt ?? 0, cache });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.createdAt - a.createdAt || a.runId.localeCompare(b.runId));
    const { runId, cache } = candidates[0];
    return { runId, cache };
  }

  /** Recover the call history of an interrupted run for display without resuming. */
  inspect(runId: string): WorkflowRunView | null {
    const live = this.runs.get(runId);
    if (live) return live.view();
    const runDir = ensureRunDir(this.options.baseDir, runId);
    const snapshot = loadSnapshot(runDir);
    if (!snapshot) return null;
    const { entries } = loadJournal(journalPath(runDir));
    const calls = [...entries.values()].map((entry) => ({
      callKey: entry.callKey,
      label: entry.label,
      phase: entry.phase,
      status: entry.status,
      agentType: entry.agentType,
      name: entry.name,
      sessionFile: entry.sessionFile,
      sessionId: entry.sessionId,
      model: entry.model,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      durationMs: entry.durationMs,
      error: entry.error,
      usage: entry.usage,
    }));
    const stats = summarizeCalls(calls);
    return {
      runId,
      meta: snapshot.meta,
      status: snapshot.status === "running" ? "interrupted" : snapshot.status,
      phase: snapshot.phase,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      startedAtWall: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
      agentCount: calls.length,
      activeCount: 0,
      completedCount: stats.completed,
      failedCount: stats.failed,
      totalCount: calls.length,
      maxConcurrent: defaultConcurrency(),
      progress: stats.progress,
      usage: stats.usage,
      budgetTotal: snapshot.budgetTotal,
      scriptPath: snapshot.scriptPath,
      runDir,
      sessionFile: snapshot.sessionFile,
      cwd: snapshot.cwd,
      error: snapshot.error,
      ...(snapshot.result === undefined ? {} : { result: snapshot.result }),
      calls,
      logs: [],
      logsDropped: 0,
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

interface ParsedAgentArgs {
  prompt: string;
  opts: {
    label?: string;
    phase?: string;
    schema?: Record<string, unknown>;
    agent?: string;
    model?: string;
    effort?: string;
    readOnly?: boolean;
    /** Run this call in its own git worktree. */
    isolation?: "worktree";
    /** Extra attempts after the first one fails; 0 (the default) never retries. */
    retries?: number;
    /** Busy-time ceiling for one attempt; 0 (the default) uses the run's limit. */
    stallTimeoutMs?: number;
  };
}

function firstArg(call: CodemodeHostCall): unknown {
  const args = call.args;
  if (Array.isArray(args)) return args[0];
  return args;
}

/**
 * Thinking levels pi accepts as a `model:<level>` suffix (the runtime's
 * VALID_THINKING_LEVELS). An unknown suffix would not be stripped, so the
 * child would look for a model literally named `…:xyz` and fail there;
 * rejecting it here instead gives the script author a real message.
 */
const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function parseAgentArgs(raw: unknown): ParsedAgentArgs {
  if (typeof raw === "string") return { prompt: raw, opts: {} };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    // The script prelude sends `{ prompt, opts }`; the object-spread form below
    // also accepts `{ prompt, label, schema, ... }` so a hand-written call that
    // reaches the bridge directly still works.
    const opts = record.opts;
    if (typeof record.prompt === "string") {
      if (opts && typeof opts === "object" && !Array.isArray(opts)) {
        return { prompt: record.prompt, opts: normalizeOpts(opts as Record<string, unknown>) };
      }
      return { prompt: record.prompt, opts: normalizeOpts(record) };
    }
  }
  throw new WorkflowScriptError("agent() requires a prompt string as its first argument.");
}

/**
 * Options `agent()` understands. Anything else is a mistake worth reporting:
 * a typo like `schemas:` or `modle:` would otherwise be dropped in silence and
 * the call would run with defaults the author did not ask for.
 */
const KNOWN_AGENT_OPTS = new Set([
  "prompt", "label", "phase", "schema", "agent", "agentType", "model", "effort", "readOnly",
  "isolation", "retries", "stallTimeoutMs",
]);

/** Bounds for the opt-in retry policy; anything outside is an author mistake. */
export const MAX_AGENT_RETRIES = 5;
export const MIN_STALL_TIMEOUT_MS = 1_000;
export const MAX_STALL_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** Options that exist in Claude Code but have no pi equivalent yet. */
const UNSUPPORTED_AGENT_OPTS: Record<string, string> = {
  timeout: "use stallTimeoutMs for a per-call ceiling",
};

function normalizeOpts(record: Record<string, unknown>): ParsedAgentArgs["opts"] {
  const opts: ParsedAgentArgs["opts"] = {};
  if (record.readOnly !== undefined) {
    if (typeof record.readOnly !== "boolean") throw new WorkflowScriptError("agent() readOnly must be a boolean.");
    opts.readOnly = record.readOnly;
  }
  if (record.isolation !== undefined) {
    if (record.isolation !== "worktree") {
      throw new WorkflowScriptError(
        "agent() isolation must be \'worktree\' when set; got " + JSON.stringify(record.isolation) + ".",
      );
    }
    opts.isolation = "worktree";
  }
  if (record.retries !== undefined) {
    const retries = record.retries;
    if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0 || retries > MAX_AGENT_RETRIES) {
      throw new WorkflowScriptError(
        "agent() retries must be an integer between 0 and " + MAX_AGENT_RETRIES + "; got " + JSON.stringify(retries) + ".",
      );
    }
    opts.retries = retries;
  }
  if (record.stallTimeoutMs !== undefined) {
    const stall = record.stallTimeoutMs;
    if (typeof stall !== "number" || !Number.isFinite(stall) || stall < MIN_STALL_TIMEOUT_MS || stall > MAX_STALL_TIMEOUT_MS) {
      throw new WorkflowScriptError(
        "agent() stallTimeoutMs must be between " + MIN_STALL_TIMEOUT_MS + " and " + MAX_STALL_TIMEOUT_MS + " ms; got " +
          JSON.stringify(stall) + ". Omit it to use the run's per-call ceiling.",
      );
    }
    opts.stallTimeoutMs = stall;
  }
  if (typeof record.label === "string") opts.label = record.label;
  if (typeof record.phase === "string") opts.phase = record.phase;
  if (record.schema && typeof record.schema === "object") {
    opts.schema = record.schema as Record<string, unknown>;
    assertSatisfiableSchema(opts.schema);
  }
  const agent = readAgentOpt(record);
  if (agent) opts.agent = agent;
  if (typeof record.model === "string") opts.model = record.model;
  if (typeof record.effort === "string") {
    if (!EFFORT_LEVELS.includes(record.effort)) {
      throw new WorkflowScriptError(
        `agent() got effort "${record.effort}"; expected one of ${EFFORT_LEVELS.join(", ")}.`,
      );
    }
    opts.effort = record.effort;
  }
  assertNoUnknownOpts(record);
  return opts;
}

/**
 * The agent type, under either name. `agentType` is Claude Code's spelling and
 * `agent` is pi's; accepting both is the point — a ported script that pins a
 * read-only reviewer must not silently run the default agent instead.
 */
function readAgentOpt(record: Record<string, unknown>): string | undefined {
  const agent = typeof record.agent === "string" ? record.agent : undefined;
  const agentType = typeof record.agentType === "string" ? record.agentType : undefined;
  if (agent && agentType && agent !== agentType) {
    throw new WorkflowScriptError(
      `agent() got both agent "${agent}" and agentType "${agentType}"; they are the same option — pass one.`,
    );
  }
  return agent ?? agentType;
}

function assertNoUnknownOpts(record: Record<string, unknown>): void {
  const unknown = Object.keys(record).filter((key) => !KNOWN_AGENT_OPTS.has(key));
  if (unknown.length === 0) return;
  const unsupported = unknown.filter((key) => key in UNSUPPORTED_AGENT_OPTS);
  const detail = unsupported.length
    ? unsupported.map((key) => `\`${key}\` (${UNSUPPORTED_AGENT_OPTS[key]})`).join(", ")
    : `\`${unknown.join("`, `")}\``;
  throw new WorkflowScriptError(
    `agent() got unknown option${unknown.length === 1 ? "" : "s"} ${detail}. ` +
      `Supported: ${[...KNOWN_AGENT_OPTS].filter((key) => key !== "prompt").join(", ")}.`,
  );
}

/**
 * Reject a schema the child could never satisfy, before the run spends model
 * calls on it. The child's tool layer validates the *answer*; this checks the
 * *question* — a root that is not an object, or a `required` field that is not
 * in `properties`, can never validate.
 */
function assertSatisfiableSchema(schema: Record<string, unknown>): void {
  if (Array.isArray(schema)) {
    throw new WorkflowScriptError("agent() schema must be an object with `type: 'object'` and `properties`.");
  }
  if (schema.type !== "object") {
    throw new WorkflowScriptError(
      `agent() schema must have \`type: 'object'\` at the root (got ${JSON.stringify(schema.type ?? null)}); ` +
        "a structured result is an object with named fields.",
    );
  }
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    throw new WorkflowScriptError("agent() schema needs a `properties` object listing the fields to return.");
  }
  const required = schema.required;
  if (required === undefined) return;
  if (!Array.isArray(required) || required.some((key) => typeof key !== "string")) {
    throw new WorkflowScriptError("agent() schema `required` must be an array of field names.");
  }
  const properties = schema.properties as Record<string, unknown>;
  const missing = (required as string[]).filter((key) => !(key in properties));
  if (missing.length > 0) {
    throw new WorkflowScriptError(
      `agent() schema requires ${missing.map((key) => `\`${key}\``).join(", ")}, which ` +
        `${missing.length === 1 ? "is" : "are"} not in \`properties\`. The agent could never satisfy it.`,
    );
  }
}

/** The bundled definition a call runs as when nothing names one. */
const DEFAULT_WORKFLOW_AGENT = "worker";

/**
 * The agent a call runs as when neither the call nor the meta names one.
 *
 * It has to be a pi subagent. A `cli:` definition would open an external coding
 * agent in the pane — a different tool, with its own model and no pi tool layer
 * — which is never what "just run this prompt" means.
 */
function inferAgentType(
  allowed: string[],
  kindOf: (name: string) => "pi" | "cli" | undefined,
): string | undefined {
  if (allowed.includes(DEFAULT_WORKFLOW_AGENT)) return DEFAULT_WORKFLOW_AGENT;
  return allowed.find((name) => kindOf(name) !== "cli") ?? allowed[0];
}

function addUsage(previous?: WorkflowUsage, current?: WorkflowUsage): WorkflowUsage | undefined {
  if (!previous && !current) return undefined;
  const combined: WorkflowUsage = { ...previous, ...current };
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'cost'] as const) {
    if (previous?.[key] !== undefined || current?.[key] !== undefined) combined[key] = (previous?.[key] ?? 0) + (current?.[key] ?? 0);
  }
  return combined;
}

function usageFromSession(path?: string): WorkflowUsage | undefined {
  if (!path) return undefined;
  let stats;
  try { stats = summarizeSessionStats(path); } catch { return undefined; }
  if (!stats) return undefined;
  return {
    ...(stats.model ? { model: stats.model } : {}), inputTokens: stats.inputTokens, outputTokens: stats.outputTokens,
    cacheReadTokens: stats.cacheReadTokens, cacheWriteTokens: stats.cacheWriteTokens,
    totalTokens: stats.inputTokens + stats.outputTokens, cost: stats.cost,
  };
}

function readStructuredResult(path?: string): { value?: unknown; error?: string } | undefined {
  if (!path) return undefined;
  if (!existsSync(path)) {
    return { error: "the agent finished without calling structured_output" };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { ok?: boolean; value?: unknown; error?: string };
    if (parsed?.ok === false) return { error: parsed.error ?? "structured output failed" };
    return { value: parsed?.value };
  } catch (error: any) {
    return { error: `unreadable structured result: ${error?.message ?? String(error)}` };
  }
}

/** A completion whose rejection has already been turned into a value. */
type SettledCompletion<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Take ownership of a subagent completion the moment its handle exists.
 *
 * Every branch afterwards may stop waiting (a settled call, a timeout, an
 * abort, a closed pane), and a watcher that throws when its pane disappears
 * must not become an unhandled rejection. This is the only place that turns a
 * completion rejection into a value; the caller still decides whether it is
 * reported as a failed call, so no error is swallowed silently.
 */
function settleCompletion<T>(promise: Promise<T>): Promise<SettledCompletion<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/**
 * Await a completion promise, but stop waiting when the run is aborted or the
 * call spends too long *working*. Whichever happens first wins; the other
 * callback is detached, so a later exit cannot resolve twice or keep a timer
 * alive.
 *
 * `isLegitimateWait` marks the time that must not count against the ceiling: a
 * step parked on ask_question, or idling at its own prompt waiting for the
 * orchestrator, is doing exactly what the run asked of it. The ceiling is a
 * dead-agent detector, so it measures work, never wall clock.
 */
async function withRunAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  isLegitimateWait: () => boolean = () => false,
  waitAllowanceMs: number = Number.POSITIVE_INFINITY,
  abandonSignal?: AbortSignal,
): Promise<
  | { ended: "aborted" }
  | { ended: "timeout" }
  | { ended: "rejected"; error: unknown }
  | { ended: "abandoned" }
  | { ended: "done"; value: T }
> {
  if (signal.aborted) return { ended: "aborted" };
  if (abandonSignal?.aborted) return { ended: "abandoned" };
  type CallEnd =
    | { ended: "aborted" }
    | { ended: "timeout" }
    | { ended: "rejected"; error: unknown }
    | { ended: "abandoned" }
    | { ended: "done"; value: T };
  return new Promise<CallEnd>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let busyMs = 0;
    let waitedMs = 0;
    const settle = (result: CallEnd) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      abandonSignal?.removeEventListener("abort", onAbandon);
      resolve(result);
    };
    const onAbort = () => settle({ ended: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    const onAbandon = () => settle({ ended: "abandoned" });
    abandonSignal?.addEventListener("abort", onAbandon, { once: true });
    // The interface says the completion never rejects, but a watcher that
    // throws would otherwise leave this promise pending forever *and* surface
    // as an unhandled rejection. Settle it as a call failure instead.
    promise.then(
      (value) => settle({ ended: "done", value }),
      (error: unknown) => settle({ ended: "rejected", error }),
    );
    // setTimeout turns an infinite delay into ~1 ms, so "no ceiling" must skip
    // the timer rather than pass it through.
    if (!Number.isFinite(timeoutMs)) return;
    // Fine enough to notice a question being answered, coarse enough to stay
    // free on the hour-long default.
    const tickMs = Math.max(25, Math.min(timeoutMs / 20, 15_000));
    const tick = () => {
      if (finished) return;
      let waiting = false;
      try {
        waiting = isLegitimateWait();
      } catch {
        // An unreadable status is not evidence of a wait.
      }
      // Waiting is exempt only while the allowance lasts: a parked agent that
      // never gets an answer must eventually be treated as stuck.
      if (waiting && waitedMs < waitAllowanceMs) waitedMs += tickMs;
      else busyMs += tickMs;
      if (busyMs >= timeoutMs) {
        settle({ ended: "timeout" });
        return;
      }
      timer = setTimeout(tick, tickMs);
      timer.unref?.();
    };
    timer = setTimeout(tick, tickMs);
    timer.unref?.();
  });
}

/**
 * The per-call ceiling, overridable at runtime. A step that waits on a human
 * answer (ask_question) can legitimately take longer than the default, and an
 * operator may prefer a different bound; `0` or a non-positive value disables
 * the ceiling entirely.
 */
function callCeilingFromEnv(): number {
  const raw = process.env.PI_WORKFLOW_CALL_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 60 * 60 * 1000;
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return 60 * 60 * 1000;
  return ms <= 0 ? Number.POSITIVE_INFINITY : Math.floor(ms);
}

/**
 * How long waiting on an answer stays exempt, from the environment. Waiting is
 * a state the run asked for, so by default it is exempt without limit: a step
 * blocked on its orchestrator is not a dead agent, and without proof that the
 * agent is gone the runtime must not guess. An operator who wants a bound sets
 * `PI_WORKFLOW_WAIT_TIMEOUT_MS`; `0` turns that bound off, the same way `0`
 * turns off the call ceiling.
 */
function waitAllowanceFromEnv(): number {
  const raw = process.env.PI_WORKFLOW_WAIT_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return Number.POSITIVE_INFINITY;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(ms);
}

/** Names the wait budget only when it could have mattered. */
function waitBudgetHint(waitAllowanceMs: number): string {
  if (waitAllowanceMs === Number.POSITIVE_INFINITY) return " (waiting on an answer is exempt)";
  if (waitAllowanceMs <= 0) return "";
  return ` (waiting on an answer is exempt for ${formatMinutes(waitAllowanceMs)}, then it counts)`;
}

/** A limit named in an error message, in the unit a reader expects. */
function formatMinutes(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  return minutes === 1 ? "1 min" : `${minutes} min`;
}

/**
 * The sandbox runs an async function body, so the script needs no wrapper for
 * `await` or `return`. This hook exists for the meta statement's rewrite
 * bookkeeping and for future source-level annotations.
 */
function wrapScript(source: string): string {
  return source;
}
