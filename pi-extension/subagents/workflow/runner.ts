/**
 * The workflow script runtime.
 *
 * Scripts execute inside a QuickJS VM (`@earendil-works/pi-codemode`) in a
 * worker thread, so a spinning script cannot block the pi UI. The VM has no
 * filesystem, network, timers, `require`, or `process` — its only capability is
 * the globals we inject here.
 *
 * Every `agent()` call reaches the host through `onCall` and is answered with
 * `deliver(seq, now, id, outcome)`. `seq` numbers answers in completion order,
 * independently of the call id, so a slow call cannot hold up another item's
 * pipeline. Resume reuses journal answers by content key, not delivery order.
 */
import type { CodemodeDeclaredGlobal, CodemodeHostCall, CodemodeOutcome, CodemodeRun } from "@earendil-works/pi-codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { availableParallelism } from "node:os";

export type ScriptLimits = {
  /**
   * How long the script may go without progress, in ms. Not an absolute
   * deadline: calls the script is waiting on, and every call/result/idle
   * transition, count as progress.
   */
  runTimeoutMs: number;
  /** VM heap cap. */
  memoryLimitBytes: number;
};

export const DEFAULT_LIMITS: ScriptLimits = {
  runTimeoutMs: 30 * 60 * 1000,
  memoryLimitBytes: 256 * 1024 * 1024,
};

/**
 * Model-facing declarations for the globals. The tool description embeds these
 * so the authoring contract and the runtime cannot drift apart.
 */
export const WORKFLOW_GLOBAL_DECLARATIONS = `declare function agent(prompt: string, opts?: {
  label?: string; phase?: string; schema?: object; agent?: string; agentType?: string; model?: string; effort?: string; readOnly?: boolean; isolation?: 'worktree';
  retries?: number; stallTimeoutMs?: number;
}): Promise<any>;
/** Run every thunk concurrently and resolve with their results (a barrier). Failures resolve to null. */
declare function parallel(thunks: Array<() => Promise<any>>): Promise<any[]>;
/** Run each item through all stages independently; no barrier between stages. */
declare function pipeline(items: any[], ...stages: Array<(prev: any, item: any, index: number) => Promise<any>>): Promise<any[]>;
declare function phase(title: string): Promise<void>;
declare function log(message: string): Promise<void>;
/** Execute a saved child workflow under this run's cancellation and limits. */
declare function workflow(name: string, args?: any): Promise<any>;
/** The args value this run was started with. */
declare const args: any;
/** Token budget for this run. total is null when no budget was set. Synchronous, so
 * \`while (budget.total && budget.remaining() > 50_000)\` compares a number, and refreshed
 * after every settled agent() call. */
declare const budget: { total: number | null; spent(): number; remaining(): number };
`;

/**
 * Script-level prelude, prepended to every workflow script.
 *
 * The sandbox exposes its globals as non-writable, non-configurable properties
 * (`globalThis.agent = …` silently fails), and its call bridge passes exactly
 * one argument per call. So the documented primitives are rebound here with
 * `const` declarations — which shadow the bridge globals in the script's own
 * scope — on top of one-argument bridge calls. `parallel` and `pipeline` are
 * pure Promise orchestration, so they stay in the VM; only `agent` (and the
 * status primitives) cross to the host.
 */
/**
 * The host answers calls by the name in its global declaration list, so the
 * `parallel` / `pipeline` names must remain callable from the script. The
 * sandbox's declared globals are non-writable accessors (`globalThis.agent = …`
 * is silently dropped for them), so routing a *pure* primitive through the host
 * is impossible: the thunks it needs only exist in the VM.
 *
 * The way out is naming. `parallel` and `pipeline` are pure Promise
 * orchestration, so the sandbox does not need to know them at all — the script
 * defines them itself and they simply call `agent()`, which is the single
 * global the host really owns. Runtime-enforced limits live in the manager, so
 * concurrency is unaffected by where the fan-out happens.
 */
const scriptPrelude = (maxItemsPerBatch: number): string => `// \`budget.spent()\` and \`remaining()\` are NUMBERS, not promises: the documented
// idiom \`while (budget.total && budget.remaining() > 50_000)\` compares them to a
// number, and a promise would make that comparison false forever — a loop that
// silently does nothing. The values are as fresh as the last settled call.
const __wfBudgetSnapshot = await __wfBridgeBudget("snapshot");
// \`Infinity\` does not survive the JSON bridge (it arrives as null), so an
// unbounded run has to be read back as Infinity here: the documented
// \`budget.total === null\` case means "no ceiling", not "zero left".
const __wfBudgetRemaining = (value) => (value == null ? Infinity : value);
const __wfBudgetState = {
  total: __wfBudgetSnapshot && typeof __wfBudgetSnapshot === "object" ? __wfBudgetSnapshot.total : null,
  spent: __wfBudgetSnapshot && typeof __wfBudgetSnapshot === "object" ? __wfBudgetSnapshot.spent : 0,
  remaining: __wfBudgetSnapshot && typeof __wfBudgetSnapshot === "object"
    ? __wfBudgetRemaining(__wfBudgetSnapshot.remaining)
    : Infinity,
};
const __wfRefreshBudget = async () => {
  const fresh = await __wfBridgeBudget("snapshot");
  if (fresh && typeof fresh === "object") {
    __wfBudgetState.spent = fresh.spent;
    __wfBudgetState.remaining = __wfBudgetRemaining(fresh.remaining);
  }
};
// \`agent(prompt, opts)\` is the documented form. A single object is passed
// through unchanged — the host reads its \`prompt\` and treats the rest as opts —
// because the object form reads naturally and would otherwise fail as a null
// inside parallel(), which hides the mistake rather than reporting it.
//
// The host answers a dead agent with \`null\` and a malformed call with a thrown
// error, so there is nothing to unwrap here: both reach the script as ordinary
// Promise semantics. The budget is refreshed on the way out, so the next
// \`remaining()\` accounts for the call that just finished.
const agent = (prompt, opts) => {
  const call = __wfBridgeAgent(typeof prompt === "string" ? { prompt: prompt, opts: opts } : prompt);
  return call.then(async (value) => {
    await __wfRefreshBudget();
    return value;
  });
};
const __wfSettled = (promise) => Promise.resolve(promise).then(
  (value) => value,
  (error) => {
    // A thunk's own throw means "this branch did not produce a result" and
    // becomes null. An author error (unknown agent, typo'd option, schema that
    // can never validate, a cap) is a mistake in the script itself: rethrowing
    // fails the run instead of quietly dropping the call through filter(Boolean).
    if (error && error.workflowAuthorError) throw error;
    return null;
  },
);
const __wfCheckBatch = (count, what) => {
  if (typeof count !== "number" || count < 0) throw new Error(what + " expects an array");
  if (count > ${maxItemsPerBatch}) throw new Error(what + " accepts at most ${maxItemsPerBatch} items, got " + count);
};
const parallel = (thunks) => {
  __wfCheckBatch(thunks.length, "parallel()");
  return Promise.all(thunks.map((runThunk) => __wfSettled(Promise.resolve().then(() => runThunk()))));
};
const pipeline = (items, ...stages) => {
  __wfCheckBatch(items.length, "pipeline()");
  return Promise.all(items.map((item, index) => {
    let chain = Promise.resolve(item);
    for (const stage of stages) chain = chain.then((previous) => stage(previous, item, index));
    // A failing item resolves to null on its own; the others keep going.
    return __wfSettled(chain);
  }));
};
const phase = (title) => __wfBridgePhase(title);
const log = (message) => __wfBridgeLog(message);
const workflow = (name, runArgs) => __wfBridgeWorkflow({ name: name, args: runArgs }).then(async (value) => {
  await __wfRefreshBudget();
  return value;
});
const args = __WF_ARGS__;
const budget = {
  total: __wfBudgetState.total,
  spent: () => __wfBudgetState.spent,
  remaining: () => __wfBudgetState.remaining,
};
`;

/**
 * Bridge globals, declared to the sandbox under names the script's own `const`
 * bindings can shadow. The documented script API keeps its exact names
 * (`agent`, `parallel`, …); the shadowing bindings redefine `agent`, `phase`,
 * `log` and `workflow` in terms of these, and answer every call with the single
 * argument the sandbox's call bridge can carry.
 */
export const WORKFLOW_GLOBALS: CodemodeDeclaredGlobal[] = [
  { name: "__wfBridgeAgent" },
  { name: "__wfBridgePhase" },
  { name: "__wfBridgeLog" },
  { name: "__wfBridgeWorkflow" },
  { name: "__wfBridgeBudget" },
];

/**
 * Wrap a script for execution: prelude, then the author's source.
 *
 * The run's `args` are inlined into the prelude as a literal, so the script
 * reads `args` as plain data. Passing them through a host global instead would
 * force every property read to cross the bridge.
 */
export function prepareScriptSource(source: string, args: unknown, maxItemsPerBatch = 4096): string {
  const literal = JSON.stringify(args ?? null) ?? "null";
  // U+2028/2029 are literal separators in JavaScript string syntax.
  const safe = literal.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const prelude = scriptPrelude(maxItemsPerBatch).replaceAll("__WF_ARGS__", safe);
  return `${prelude}\n${source}`;
}

/** No filesystem, network, timers, require or process. Date is frozen at run.startedAt and Math.random is seeded. */

/**
 * How many agents may run at once.
 *
 * Each one is a real pi session in its own pane, so the ceiling is about the
 * machine, not the model: a busy laptop wants fewer. Overridable because the
 * right number depends on what else the user has running.
 */
export function defaultConcurrency(): number {
  const override = readConcurrencyOverride();
  if (override !== null) return override;
  let detected = 8;
  try {
    detected = availableParallelism();
  } catch {
    detected = 8;
  }
  return Math.max(2, Math.min(16, detected - 2));
}

/** `PI_WORKFLOW_MAX_CONCURRENT_AGENTS`, or Claude Code's name for the same knob. */
function readConcurrencyOverride(): number | null {
  for (const name of ["PI_WORKFLOW_MAX_CONCURRENT_AGENTS", "CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS"]) {
    const raw = process.env[name];
    if (!raw) continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value) && value >= 1) return Math.min(value, 64);
  }
  return null;
}

export interface StartScriptOptions {
  code: string;
  filename?: string;
  /** Parse the actual sandbox program without executing user code or bridges. */
  compileOnly?: boolean;
  /** Inlined into the script's `args` binding. */
  args: unknown;
  startedAt: number;
  seed: number;
  signal: AbortSignal;
  limits?: Partial<ScriptLimits>;
  /** Hard cap on items per parallel/pipeline call. */
  maxItemsPerBatch?: number;
  /** Handle one script call. Must eventually invoke `deliver` exactly once. */
  onCall(call: CodemodeHostCall, deliver: (outcome: CodemodeOutcome) => void): void;
  onIdle?(seq: number, issued: number): void;
  onStarted?(fingerprint: string): void;
}

export interface ScriptResult {
  ok: boolean;
  value?: unknown;
  error?: { kind: string; message: string };
  /** `text()`/`console.*` output the script produced, in order. */
  output: string[];
  fingerprint?: string;
  /** Calls the script issued, for reporting when a run fails early. */
  issuedCalls: number;
}

/**
 * Run one workflow script to completion.
 *
 * The VM wants a contiguous 1..N result sequence, not call-issuance order.
 * Assign the sequence when an answer arrives, including budget/status calls:
 * reserving it at issuance would make a slow agent block unrelated results
 * and their budget refreshes. Buffer only while the VM is starting.
 */
export async function runScript(options: StartScriptOptions): Promise<ScriptResult> {
  const prefix = options.compileOnly ? "return;\n" : "";
  const code = prefix + prepareScriptSource(options.code, options.args, options.maxItemsPerBatch);
  const sourceOffset = code.split("\n").length - options.code.split("\n").length;
  const limits: ScriptLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const sandbox = new CodemodeSandbox({ memoryLimitBytes: limits.memoryLimitBytes });

  /** Answers received synchronously while sandbox.start() is still returning. */
  const pending: Array<{ id: number; outcome: CodemodeOutcome }> = [];
  let nextResultSeq = 1;
  let issuedCalls = 0;
  let fingerprint: string | undefined;

  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  if (options.signal.aborted) abort();
  else options.signal.addEventListener("abort", abort, { once: true });

  // The VM's clock is frozen at the persisted run epoch, so a script waiting on
  // an answer nobody sends would hang invisibly. The watchdog is host-side and
  // resets on any call, result, or idle transition.
  let lastActivity = Date.now();
  /**
   * Calls the script is still waiting on. The sandbox has no deadline of its
   * own, so this is what keeps the watchdog honest: while the host owes the
   * script an answer it is not stuck, and one healthy agent is allowed to
   * outlast the whole inactivity budget.
   */
  let outstanding = 0;
  // The interval only needs to be fine enough to notice a stuck script
  // promptly; the budget itself is `runTimeoutMs`.
  const watchdog = setInterval(() => {
    if (outstanding > 0) return;
    if (Date.now() - lastActivity >= limits.runTimeoutMs) {
      controller.abort(
        new Error(`workflow script made no progress for ${Math.round(limits.runTimeoutMs / 1000)}s`),
      );
    }
  }, 250);
  watchdog.unref?.();

  /** Set once `start()` returns; before that, answers wait in `pending`. */
  let run: CodemodeRun | undefined;

  const answer = (item: { id: number; outcome: CodemodeOutcome }) => {
    if (!run) { pending.push(item); return; }
    if (run.finished) return;
    // Host wall time is for the watchdog and UI only. Every VM clock read,
    // including globalThis.Date and performance, uses the persisted epoch.
    run.deliver(nextResultSeq++, options.startedAt, item.id, item.outcome);
  };

  try {
    run = sandbox.start(code, {
      startedAt: options.startedAt,
      seed: options.seed,
      globals: WORKFLOW_GLOBALS,
      signal: controller.signal,
      // No absolute deadline: `runTimeoutMs` is an inactivity budget (see the
      // watchdog above), and a single agent session legitimately runs longer
      // than any fixed cap. A script that computes without yielding is still
      // bounded by the VM's interrupt budget.
      timeoutMs: Number.POSITIVE_INFINITY,
      onStarted: (value) => {
        fingerprint = value;
        options.onStarted?.(value);
      },
      onIdle: (seq, issued) => {
        lastActivity = Date.now();
        options.onIdle?.(seq, issued);
      },
      onCall: (call) => {
        lastActivity = Date.now();
        issuedCalls++;
        outstanding++;
        let answered = false;
        // Single answer path: the host calls this at most once per call, but
        // the guard keeps a late second answer from overwriting the first.
        const deliver = (outcome: CodemodeOutcome) => {
          if (answered) return;
          answered = true;
          outstanding--;
          lastActivity = Date.now();
          answer({ id: call.id, outcome });
        };
        options.onCall(call, deliver);
      },
    });
    // Answers that arrived while the VM was still starting up are delivered now.
    for (const item of pending.splice(0)) answer(item);

    const result = await run.result;
    const output = result.output
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text);

    if (result.ok === true) {
      return { ok: true, value: result.value, output, fingerprint, issuedCalls };
    }
    return {
      ok: false,
      output,
      fingerprint,
      issuedCalls,
      error: {
        kind: result.error.kind,
        message: formatScriptError(result.error, options, sourceOffset),
      },
    };
  } finally {
    clearInterval(watchdog);
    options.signal.removeEventListener("abort", abort);
    await sandbox.close().catch(() => {});
  }
}

function formatScriptError(error: { name?: string; message?: string; stack?: string }, options: StartScriptOptions, offset: number): string {
  const message = error.message || error.name || "workflow script failed";
  const position = /\bat codemode\.js:(\d+)(?::(\d+))?/.exec(error.stack ?? "");
  if (!position) return message;
  const reportedLine = Number(position[1]) - offset;
  const lines = options.code.split("\n");
  if (reportedLine < 1 || reportedLine > lines.length + 1) return message;
  // QuickJS may point at the SDK's closing wrapper for an unfinished source.
  const line = Math.min(reportedLine, lines.length);
  const column = reportedLine > lines.length ? lines.at(-1)!.length + 1 : position[2] ? Number(position[2]) : undefined;
  const context = lines.slice(Math.max(0, line - 2), line + 1)
    .map((text, i) => {
      const number = Math.max(1, line - 1) + i;
      const start = number === line && column ? Math.max(0, column - 101) : 0;
      const excerpt = (start ? "..." : "") + text.slice(start, start + 240) + (text.length > start + 240 ? "..." : "");
      return `${number === line ? ">" : " "} ${number} | ${excerpt}`;
    });
  return `${error.name ?? "Error"}: ${message}\n${options.filename ?? "workflow.js"}:${line}${column ? ":" + column : ""}\n${context.join("\n")}`;
}

/** Same QuickJS compiler and prelude as execution; no agent or host calls. */
export function validateScript(code: string, filename = "workflow.js", signal = new AbortController().signal): Promise<ScriptResult> {
  return runScript({ code, filename, compileOnly: true, args: {}, startedAt: 0, seed: 1,
    signal,
    onCall() { throw new Error("Compilation must not execute host calls"); },
  });
}
