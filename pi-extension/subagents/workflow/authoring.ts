/** Cheap discovery in the tool prompt; full guidance is fetched only on demand. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listBundledWorkflows } from "./script.ts";
import { WORKFLOW_GLOBAL_DECLARATIONS } from "./runner.ts";

export type WorkflowSize = "small" | "medium" | "large" | "unrestricted";
export const AUTHORING_SKILL_PATH = fileURLToPath(new URL("../../../skills/workflow-authoring/SKILL.md", import.meta.url));
const AUTHORING_REFERENCE_PATH = fileURLToPath(new URL("../../../skills/workflow-authoring/references/authoring.md", import.meta.url));

export function workflowSize(value: string | undefined): WorkflowSize {
  return value === "small" || value === "large" || value === "unrestricted" ? value : "medium";
}

export function sizeGuideline(size: WorkflowSize): string {
  if (size === "unrestricted") return "";
  const calls = { small: 5, medium: 10, large: 50 }[size];
  return `SIZE GUIDELINE (${size})\nPlan for about ${calls} total agent calls, including verifiers, votes and synthesis. Bound data-dependent fan-out before launching it. This is a planning target, not a runtime cap; do not pad a task to reach it. Runtime concurrency and token limits are separate.`;
}

/** A complete program, also executed by the authoring contract tests. */
export const CANONICAL_WORKFLOW = `export const meta = {
  name: 'inspect-items', description: 'Inspect items and verify flagged results',
  phases: ['Inspect', 'Verify'],
}
const schema = {
  type: 'object',
  properties: { needsCheck: { type: 'boolean' }, evidence: { type: 'string' } },
  required: ['needsCheck', 'evidence'],
}
const results = await pipeline(args.items,
  (item, _, index) => agent('Inspect this item read-only: ' + JSON.stringify(item),
    { label: 'inspect-' + index, phase: 'Inspect', schema }),
  async (finding, item, index) => {
    if (!finding) return { item, status: 'unverified' }
    if (!finding.needsCheck) return { item, finding }
    const verdict = await agent(
      'Independently check this item and evidence; try to refute it. Item: ' +
      JSON.stringify(item) + '\\nEvidence: ' + finding.evidence,
      { label: 'verify-' + index, phase: 'Verify' })
    return { item, finding, verdict }
  })
return results`;

export function buildWorkflowDescription(size: WorkflowSize = "medium"): string {
  return `Run a JavaScript workflow that orchestrates real subagent sessions in tmux. Start returns a run id immediately; completion notifies the parent. Do not poll. The user can watch or interact via /workflow and the agents' panes.

OPT-IN
Start only when the user requested a workflow, orchestration or fan-out, or an applicable skill/command explicitly calls for it. Mere benefit from parallelism is not opt-in. Loading this guide or inspecting templates does not authorize starting agents. A single task or a handful of agents you will manage yourself belongs in subagent.

BEFORE AUTHORING
Load the workflow-authoring skill if available. Otherwise call workflow({ action: 'guide' }) for the same guidance and runtime API, even with skills disabled or no read tool. It covers six composable shapes: fan-out, per-item pipeline, per-finding expansion, adversarial voting, synthesis, and bounded budget loops. Use workflow({ action: 'list' }) to discover project/global/bundled scripts with whenToUse. workflow({ action: 'guide', name: '<name>' }) reads a complete template without executing it. Bundled templates: ${listBundledWorkflows().workflows.map(entry => entry.name).join(", ")}.

SHAPE RULES
Default to pipeline(items, ...stages): each item advances independently. Use parallel(thunks) when a consumer needs ALL previous results (cross-item comparison, voting or synthesis). Both return arrays in input order. Use schema whenever code branches on or extracts fields from agent output; free text is suitable when only passed through. Each prompt must include the task and relevant input: children do not see this conversation. Default agent: worker. Workflow children return direct step results, may ask the parent using ask_question, and may delegate to agents allowed by their definition. Reply via subagent_message; the same session continues. Abort works while waiting. Agent count/concurrency caps cover direct script calls, not nested delegation. Legacy workflow-subagent names work.

COMPLETE EXAMPLE
${CANONICAL_WORKFLOW}

CONTRACT
Plain JavaScript async function body, starting with literal export const meta = { name, description, phases? }. Globals: agent, pipeline, parallel, phase, log, args, budget. Agent options: label, phase, schema, agent/agentType, model, effort, readOnly (boolean), isolation (worktree), retries (0..5, default 0), stallTimeoutMs (active-time ceiling in ms; omit to keep the default). Explicit retries may repeat side effects; never assume rollback. Evidence-only review/plan/verify calls should set readOnly:true: only read tools, ask_question and sandboxed verify_command are allowed; writers, arbitrary extensions and delegation are unavailable for that call. Commands can write only private scratch, with network/IPC denied; unsupported sandbox platforms refuse commands, never fall back to bash. Schema root: object with properties; required fields must exist. No filesystem, network, timers, require or process in the script; agents perform I/O. workflow(name, args) executes a saved child workflow under the parent cancellation and limits. isolation:'worktree' gives an agent a persistent detached Git worktree from committed HEAD; parent dirty files are not copied, and edits/commits are never reset or automatically merged. Phase titles do not schedule work. Date.now()/new Date() are frozen at persisted run.startedAt; performance.now() is 0. Math.random() is seeded, but concurrent scheduling can change consumption order: do not derive call keys from shared randomness.
A failed/dead/skipped agent returns null, including bare await agent(). Guard null before accessing fields. Malformed calls and exhausted budgets fail the run; do not blanket-catch programming errors. Non-isolated writers share cwd: partition edits.

RECOVERY AND LIMITS
start runs fresh by default; explicit reuse:'auto' replays completed calls from the latest same-name, same-args run without charging their historical usage to this new run. resume targets a runId, replays completed calls and retries failed/skipped/unfinished calls. Labels are display-only. Content keys include prompt, schema, agent, model, effort, isolation and readOnly mode; repeated identical calls are separate samples. Resume is result reuse, not filesystem rollback.
budget.spent()/remaining() are synchronous uncached-input-plus-output token counts (cacheRead is recorded separately, not charged; not a cost ceiling), refreshed after agents settle; total is null when unset. Always bound loops even without a token budget. The token ceiling is checked before new calls; in-flight calls can overshoot. Concurrency defaults to max(2,min(16,CPUs-2)); PI_WORKFLOW_MAX_CONCURRENT_AGENTS overrides it. Hard limits: 4096 items per batch, 1000 launched agents per run.

${sizeGuideline(size)}`.trim();
}

/** A shared source for skill users and read-only tool fallback users. */
export function readAuthoringGuide(size: WorkflowSize): string {
  const skill = readFileSync(AUTHORING_SKILL_PATH, "utf8")
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .trimStart();
  return [
    skill,
    readFileSync(AUTHORING_REFERENCE_PATH, "utf8"),
    "## Runtime API\n\n```ts\n" + WORKFLOW_GLOBAL_DECLARATIONS + "\n```",
    sizeGuideline(size),
    "Read full runnable templates without starting agents: workflow({ action: 'guide', name: '<name>' }). Discover names and purposes with workflow({ action: 'list' }).",
  ].filter(Boolean).join("\n\n");
}
