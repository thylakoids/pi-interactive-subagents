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
 *    them only when their content changed.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodemodeHostCall, CodemodeOutcome } from "@earendil-works/pi-codemode";
import {
  acquireLock,
  appendJournal,
  callKey as makeCallKey,
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
import { WorkflowScriptError, parseScript } from "./script.ts";
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
  /** Script-side wall clock budget; overridable for tests. */
  scriptTimeoutMs = 30 * 60 * 1000;
  error?: string;
  result?: unknown;

  private readonly manager: WorkflowManagerOptions;
  private readonly journalFile: string;
  private lockPath?: string;
  private readonly abortController = new AbortController();
  private readonly cache: Map<string, CachedCall>;
  private readonly live = new Map<string, LiveCall>();
  private readonly running = new Map<string, WorkflowSubagentHandle>();
  private readonly waiters = new Map<string, Array<(outcome: WorkflowAgentOutcome) => void>>();
  private readonly queue: Array<() => void> = [];
  /**
   * How many times each content key has been issued. Two calls with the same
   * label, prompt, schema and agent are still two calls — the ordinal keeps
   * them apart in the journal, in the panel, and in the cache.
   */
  private readonly occurrences = new Map<string, number>();
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
    },
  ) {
    this.manager = managerOptions;
    this.runId = params.runId;
    this.meta = params.meta;
    this.scriptSource = params.scriptSource;
    this.source = params.source;
    this.lockPath = params.lockPath;
    this.cache = params.cache;
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
      });
    }
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Override the script's wall-clock budget. The default is generous (30 min)
   * because a workflow legitimately waits on humans; tests and callers that
   * want a tighter leash set it before `execute()`.
   */
  /** The run's lock file, released when the run settles. */
  setLockPath(path: string): void {
    this.lockPath = path;
  }

  setScriptTimeout(ms: number): void {
    this.scriptTimeoutMs = Math.max(100, Math.floor(ms));
  }

  private get maxConcurrent(): number {
    return defaultConcurrency();
  }

  private now(): number {
    return this.manager.now?.() ?? Date.now();
  }

  // ── script globals ──────────────────────────────────────────────────────

  /** Dispatch one call from the VM. Always answers, so the script never hangs. */
  async dispatch(call: CodemodeHostCall, deliver: (outcome: CodemodeOutcome) => void): Promise<void> {
    try {
      const answer = await this.handle(call);
      deliver(answer);
    } catch (error: any) {
      const message = error?.message ?? String(error);
      if (error instanceof WorkflowBudgetExceededError) {
        // Fatal, not a rejected call: a budget loop swallows rejections through
        // `parallel`'s null, and would keep issuing calls until the wall clock.
        this.failRun(message);
        deliver({ ok: false, message });
      } else if (error instanceof WorkflowLimitError || error instanceof WorkflowScriptError) {
        deliver({ ok: false, message });
      } else {
        deliver({ ok: false, message: `internal error in ${call.name}(): ${message}` });
      }
    }
  }

  private async handle(call: CodemodeHostCall): Promise<CodemodeOutcome> {
    const first = firstArg(call);
    switch (call.name) {
      case "__wfBridgeAgent":
        return { ok: true, value: await this.runAgentCall(first) };
      case "__wfBridgePhase":
        this.setPhase(stringArg(first));
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
        return { ok: true, value: await this.runNestedCall(first) };
      default:
        return { ok: false, message: `unknown workflow primitive \`${call.name}\`` };
    }
  }

  /** Resolve the script-side handle for `agent(prompt, opts)`. */
  private async runAgentCall(raw: unknown): Promise<unknown> {
    const parsed = parseAgentArgs(raw);
    const defined = this.manager.service.allowedAgents();
    const agentType =
      parsed.opts.agent ??
      this.meta.agent ??
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
    // A `cli:` definition is an external coding agent: it runs its own toolset
    // and cannot answer through a schema sidecar. Say so here rather than
    // letting the child finish and reporting that it never called the tool.
    if (parsed.opts.schema && this.manager.service.agentKind(agentType) === "cli") {
      throw new WorkflowScriptError(
        `agent() asked "${agentType}" for a structured result, but that definition is an external CLI ` +
          "(cli:), which cannot return one. Use a pi agent for schema calls, or drop the schema.",
      );
    }

    const label = parsed.opts.label?.trim() || agentType;
    const base = makeCallKey({
      kind: "agent",
      label,
      prompt: parsed.prompt,
      schema: parsed.opts.schema,
      agent: agentType,
      model: parsed.opts.model,
      effort: parsed.opts.effort,
    });
    const occurrence = this.occurrences.get(base) ?? 0;
    this.occurrences.set(base, occurrence + 1);
    const key = occurrenceKey(base, occurrence);

    if (!this.predecessorLogged && this.cache.size > 0) {
      this.predecessorLogged = true;
      this.note(
        `reusing ${this.cache.size} completed call(s) from run ${this.snapshot.resumedFrom ?? "an earlier run"}; only changed calls run`,
      );
    }
    const cached = this.cache.get(key);
    if (cached) {
      this.live.set(key, {
        callKey: key,
        label,
        phase: parsed.opts.phase ?? this.phase,
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
      });
      return cached.value ?? null;
    }

    const liveCall: LiveCall = {
      callKey: key,
      label,
      phase: parsed.opts.phase ?? this.phase,
      agentType,
      status: "queued",
      requestedAt: this.now(),
      prompt: parsed.prompt,
    };
    this.live.set(key, liveCall);
    this.launchedAgents++;
    this.assertAgentBudget();
    this.assertBudget();

    const promise = new Promise<WorkflowAgentOutcome>((resolve) => {
      const list = this.waiters.get(key) ?? [];
      list.push(resolve);
      this.waiters.set(key, list);
    });

    this.enqueue(async () => {
      const outcome = await this.launchAgent(liveCall, parsed);
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
    throw new WorkflowScriptError(
      `workflow("${name}") is not available: nested workflows are not supported by this build yet. ` +
        "Express the child steps inline in this script instead.",
    );
  }

  // ── agent scheduling ────────────────────────────────────────────────────

  private enqueue(task: () => Promise<void>): void {
    const start = () => {
      this.activeAgents++;
      void task().finally(() => {
        this.activeAgents--;
        const next = this.queue.shift();
        if (next) next();
      });
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
    for (const handle of this.running.values()) this.manager.service.stop(handle.name);
    // Drain rather than clear: a queued task that never starts would leave its
    // caller waiting forever.
    const queue = this.queue.splice(0);
    for (const start of queue) start();
    for (const [key, waiters] of this.waiters) {
      const live = this.live.get(key);
      if (live) live.status = "aborted";
      this.waiters.delete(key);
      for (const resolve of waiters) resolve({ ok: false, status: "aborted", value: null, error: reason });
    }
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

    liveCall.status = "running";
    liveCall.startedAt = this.now();

    // Structured results go through a sidecar: schema file in, result file out,
    // both scoped to this call so parallel calls cannot collide.
    const callDir = join(this.runDir, "calls", liveCall.callKey);
    mkdirSync(callDir, { recursive: true });
    let schemaFile: string | undefined;
    let resultFile: string | undefined;
    if (parsed.opts.schema) {
      schemaFile = join(callDir, "schema.json");
      resultFile = join(callDir, "result.json");
      writeJsonAtomic(schemaFile, parsed.opts.schema);
      // A retry of this call must not inherit the previous attempt's answer: a
      // child that never calls structured_output would otherwise be reported as
      // having returned the old value.
      try {
        unlinkSync(resultFile);
      } catch {
        // No previous result; nothing to clear.
      }
    }

    const task = parsed.opts.schema
      ? `${parsed.prompt}\n\nReturn the result by calling structured_output exactly once with your final answer.`
      : parsed.prompt;

    const name = this.uniqueName(liveCall.label);
    liveCall.name = name;

    try {
      const handle = await this.manager.service.spawn({
        agentType: liveCall.agentType,
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
        cwd: this.manager.cwd,
      });
      liveCall.sessionFile = handle.sessionFile;
      this.running.set(liveCall.callKey, handle);

      const completion = await withRunAbort(handle.completion, this.abortController.signal);
      if (completion.aborted) {
        this.manager.service.stop(handle.name);
        return this.recordOutcome(liveCall, {
          ok: false,
          status: "aborted",
          value: null,
          error: "run aborted while the agent was running",
        });
      }

      const result = completion.value!;
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
      if (result.error && result.exitCode !== 0) {
        return this.recordOutcome(liveCall, {
          ok: false,
          status: "failed",
          value: null,
          error: result.error,
          session: { sessionId: result.sessionId, usage: result.usage, model: result.usage?.model ?? parsed.opts.model },
          completion: result,
        });
      }

      const value = parsed.opts.schema ? structured?.value ?? null : result.summary;
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
      this.running.delete(liveCall.callKey);
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
    liveCall.usage = params.session?.usage;
    liveCall.model = params.session?.model;

    const entry: WorkflowJournalEntry = {
      type: "call",
      callKey: liveCall.callKey,
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
    appendJournal(this.journalFile, entry);
    this.snapshot.agentCount = this.live.size;
    this.persistSnapshot();

    return { ok: params.ok, status: params.status, value: params.value ?? null, error: params.error };
  }

  private uniqueName(base: string): string {
    const taken = this.manager.service.takenNames();
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    const prefix = `${this.meta.name}-${slug}`.slice(0, 48);
    let candidate = prefix;
    let n = 2;
    while (taken.has(candidate)) candidate = `${prefix}-${n++}`;
    taken.add(candidate);
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

    if (this.snapshot.status === "running") {
      if (result.ok) {
        this.status = "completed";
        this.result = result.value;
        this.snapshot.result = result.value ?? null;
        try {
          writeJsonAtomic(outputPath(this.runDir), { ok: true, value: result.value ?? null });
        } catch {
          // The run result is also in the snapshot; a missing output file is not fatal.
        }
      } else {
        const aborted = this.abortController.signal.aborted;
        this.status = aborted ? "aborted" : "failed";
        this.error = aborted && this.abortController.signal.reason instanceof Error
          ? (this.abortController.signal.reason as Error).message
          : result.error?.message ?? "workflow failed";
        this.snapshot.error = this.error;
        // A script that failed on its own (syntax error, thrown error, the
        // watchdog) has not stopped its agents or its queue: they would keep
        // opening panes and spending tokens after the run is already over.
        if (!aborted) this.teardown(this.error);
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
    if (!live) return false;
    const entry: WorkflowJournalEntry = {
      type: "call",
      callKey,
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
    };
    appendJournal(this.journalFile, entry);
    const handle = this.running.get(callKey);
    if (handle) this.manager.service.stop(handle.name);
    const waiters = this.waiters.get(callKey);
    this.waiters.delete(callKey);
    if (waiters) for (const resolve of waiters) resolve({ ok: false, status: "skipped", value: null, error: "skipped by user" });
    live.status = "skipped";
    live.finishedAt = this.now();
    live.error = "skipped by user";
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
    let spent = 0;
    for (const call of this.live.values()) spent += call.usage?.totalTokens ?? 0;
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
    const done = calls.filter((c) => c.status === "completed" || c.status === "failed" || c.status === "skipped").length;
    const failed = calls.filter((c) => c.status === "failed").length;
    const active = calls.filter((c) => c.status === "running").length;
    const usage: WorkflowUsage = {};
    for (const call of calls) {
      if (!call.usage) continue;
      usage.inputTokens = (usage.inputTokens ?? 0) + (call.usage.inputTokens ?? 0);
      usage.outputTokens = (usage.outputTokens ?? 0) + (call.usage.outputTokens ?? 0);
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (call.usage.cacheReadTokens ?? 0);
      usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (call.usage.cacheWriteTokens ?? 0);
      usage.totalTokens = (usage.totalTokens ?? 0) + (call.usage.totalTokens ?? 0);
      usage.cost = (usage.cost ?? 0) + (call.usage.cost ?? 0);
    }
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
      activeCount: active,
      completedCount: calls.filter((c) => c.status === "completed").length,
      failedCount: failed,
      totalCount: total,
      maxConcurrent: this.maxConcurrent,
      progress: total === 0 ? 0 : done / total,
      usage,
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
   * If an earlier run of the *same* workflow with the *same args* exists, its
   * journal seeds this run's cache: unchanged calls replay instantly and only
   * edited calls actually execute. That is what makes iterating on a workflow
   * cheap, and it is why resuming does not require the caller to remember a run
   * id.
   *
   * `reuse: 'none'` opts out. Without it a re-run with different args would
   * silently answer from the previous run — the opposite of the independent
   * sample the caller asked for.
   */
  async start(params: {
    source: string;
    args: unknown;
    budgetTotal?: number | null;
    reuse?: "auto" | "none";
  }): Promise<WorkflowRun> {
    const runId = newRunId();
    const parsed = parseScript(params.source, runId);
    const predecessor =
      params.reuse === "none" ? null : this.findResumablePredecessor(parsed.meta.name, params.args);
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

    const lock = acquireLock(runDir);
    if (!lock.ok) {
      throw new WorkflowScriptError(
        `Run ${runId} is locked by live process ${lock.ownerPid || "unknown"} — it is still executing. ` +
          "Abort it first, or resume after it settles. A lock left by a dead process is reclaimed automatically.",
      );
    }

    // An edited script is persisted so a second resume starts from the edit;
    // the run's own snapshot records it too.
    const parsed = parseScript(source, runId);
    if (edited) writeFileSync(scriptFile, source, "utf8");
    const { entries, skippedLines } = loadJournal(journalPath(runDir));
    const cache = new Map<string, CachedCall>();
    for (const [key, entry] of entries) {
      if (entry.status !== "completed") continue;
      cache.set(key, { value: entry.value, isNull: entry.valueIsNull, entry });
    }
    const args = overrides && "args" in overrides ? overrides.args : snapshot.args;
    const run = new WorkflowRun(this.options, {
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
    });
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
   */
  private findResumablePredecessor(
    workflowName: string,
    args: unknown,
  ): { runId: string; cache: Map<string, CachedCall> } | null {
    const wanted = JSON.stringify(args ?? null);
    const dirs = listRunDirs(this.options.baseDir);
    for (let index = dirs.length - 1; index >= 0; index--) {
      const runId = dirs[index];
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
      return { runId, cache };
    }
    return null;
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
    const completed = calls.filter((c) => c.status === "completed").length;
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
      completedCount: completed,
      failedCount: calls.filter((c) => c.status === "failed").length,
      totalCount: calls.length,
      maxConcurrent: defaultConcurrency(),
      progress: calls.length === 0 ? 0 : completed / calls.length,
      usage: {},
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
const KNOWN_AGENT_OPTS = new Set(["prompt", "label", "phase", "schema", "agent", "agentType", "model", "effort"]);

/** Options that exist in Claude Code but have no pi equivalent yet. */
const UNSUPPORTED_AGENT_OPTS: Record<string, string> = {
  isolation: "worktree isolation is not implemented in pi",
  timeout: "per-call timeouts are not implemented in pi",
};

function normalizeOpts(record: Record<string, unknown>): ParsedAgentArgs["opts"] {
  const opts: ParsedAgentArgs["opts"] = {};
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
const DEFAULT_WORKFLOW_AGENT = "workflow-subagent";

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

/** Await a completion promise, but stop waiting when the run is aborted. */
async function withRunAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (signal.aborted) return { aborted: true };
  return new Promise((resolve) => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ aborted: false, value });
    });
  });
}

/**
 * The sandbox runs an async function body, so the script needs no wrapper for
 * `await` or `return`. This hook exists for the meta statement's rewrite
 * bookkeeping and for future source-level annotations.
 */
function wrapScript(source: string): string {
  return source;
}
