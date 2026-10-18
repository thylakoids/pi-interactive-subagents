# Authoring reference

## Contents

- Script and data contracts
- Shapes and executable templates
- Scale and budgets
- Failure and recovery
- Capability and concurrency boundaries
- Running and observing

## Script and data contracts

Scripts are plain JavaScript async function bodies, not ES modules or TypeScript. The first statement is literal metadata:

```js
export const meta = {
  name: 'my-workflow',
  description: 'What this script accomplishes',
  whenToUse: 'When its dependency shape fits the task',
  phases: ['Inspect', 'Verify'],
}
```

`meta.agent` optionally selects an ordinary agent definition. Without it, `agent()` uses `workflow-subagent`. Phases are display grouping, not scheduling barriers. Use `opts.phase` for per-call grouping in interleaved pipelines. `phase()` only updates the run's displayed stage.

Inputs come from `args` (JSON). The sandbox has no file/network access or timers. Pass paths, task scope, acceptance criteria and source constraints to agents, which perform I/O. Avoid scripts based on wall-clock time or randomness: replay depends on reproducible call content. Every prompt must include enough context to work independently; agents cannot read the parent conversation.

`agent(prompt, opts)` returns final text, or a validated object when `schema` is supplied. Options: `label`, `phase`, `schema`, `agent`/`agentType`, `model`, `effort`. Do not encode provider assumptions in templates. Use an available ordinary agent definition with the tools it needs. `cli:` definitions cannot supply pi's `structured_output`; do not pair them with schemas.

Use schema when branching on a result, extracting fields, counting findings, voting or iterating based on acceptance. Do not parse JSON from model prose. Root schema must be `type:'object'` with `properties`; put needed keys in `required` and declare every required key. Supported primitives include object, array, string, number, integer, boolean, enum and their nested combinations. Do not assume arbitrary JSON Schema keywords are enforced. A child must call `structured_output`; finishing with prose is not a structured result.

## Shapes and executable templates

### 1. Fan-out and a real barrier

Use `parallel([() => agent(...), ...])` for independent branches whose consumer must see all answers. A comparison or cross-source deduplication needs this barrier. A single `await agent(...)` after `parallel` is a reduce/synthesis step: include the original question, all usable answers, and explicit failure/gap information in its prompt.

Read [compare-options.js](../../../examples/workflows/compare-options.js) for a complete example. Inputs: `question`, `options` (nonempty string array), optional `maxCalls` (default 10, includes synthesis). The script inspects each option, then compares all results. It bounds options and reports failures and excluded inputs.

### 2. Per-item stages: the default

`pipeline(items, ...stages)` runs stage signatures `(previous, item, index)`, where the first stage's previous value is the item. Each item advances independently; returned array order matches input order. A fast item can be verifying while a slow one is still planning. Do not insert an all-items `parallel` between stages unless there is a real cross-item dependency.

Read [migrate-files.js](../../../examples/workflows/migrate-files.js). Inputs: `task`, `files`; agent overrides: `planAgent`, `applyAgent`, `verifierAgent`, `quickVerifierAgent`. It demonstrates plan → apply → verify, structured branching on risk, and per-file failure reporting. Partition write targets; overlapping edits require serialization or separate worktrees managed outside this API.

### 3. Per-finding expansion

A discovery agent returns `{findings:[...]}` through a schema. For each finding, start an independent verifier with that one claim, the original task and enough source pointers to re-check it. Do not send the discoverer's hidden reasoning or assume its conclusion is correct. Collect all verdicts only when categorizing confirmed/rejected/unverified findings.

Read [review-changes.js](../../../examples/workflows/review-changes.js). Inputs: optional `target`, `dimensions`, `verifierAgent`. Cap dimensions and findings for the user's chosen scale before launching a large review. Call count is dimensions + findings, not dimensions × 2. Keep failed dimensions and missing verifications in the report.

### 4. Adversarial voting

Give independent refuters the same self-contained claim and source constraints. Ask them to find a counterexample, then return a structured verdict with evidence. Three identical `agent()` calls are three samples; the runtime assigns occurrence keys. Require a complete quorum of usable results. A missing answer is not a rejection and cannot be silently dropped from the denominator. Report disputed claims and evidence gaps. Majority agreement is a triage signal, not proof.

Read [verify-claims.js](../../../examples/workflows/verify-claims.js). Inputs: `claims` (nonempty strings), optional `context`, `maxCalls` (default 10). It launches three refuters per admitted claim and reports supported/rejected/disputed/unverified separately. A fresh run that must resample should use `reuse:'none'`; resume intentionally reuses finished votes.

### 5. Composite research with synthesis

Read [deep-research.js](../../../examples/workflows/deep-research.js). Inputs: `question`; optional `context`, `maxCalls` (default 10), `researchAgent` (default `researcher`). Scope → Search → Fetch → Verify → Synthesize. Search/Fetch are per-query pipeline stages. Verification expands only admitted claims and uses three independent votes each; synthesis needs all evidence and thus follows a barrier. The script reserves a synthesis call and reports omissions and unverified claims instead of inventing missing evidence.

Research requires an available agent definition with search/fetch capabilities. This template does not install tools, bypass allowlists or create a special research agent. For codebase research, adapt the source constraints and select an ordinary read-capable definition. Never claim a source was fetched or verified solely because an earlier agent said so.

### 6. Bounded refinement

Read [iterative-refinement.js](../../../examples/workflows/iterative-refinement.js). Inputs: `task`, `initial` (draft text), optional `maxRounds` (default 3), `maxCalls` (default 10), `minRemainingTokens`. Each iteration critiques the current draft through a schema, stops on acceptance, or asks another agent to revise it. It returns the last draft and why it stopped. No filesystem mutations are needed by this example.

Always use both an iteration bound and budget checks. `budget.total === null` means no configured budget and `remaining()` is Infinity, so `while(budget.remaining() > 0)` alone can run indefinitely. Do not automatically restart a failed workflow until it passes.

## Scale and budgets

Planning defaults: small ~5 calls, medium ~10, large ~50. `PI_WORKFLOW_SIZE=small|medium|large|unrestricted` chooses the tool's planning guideline (reload after changing it); unrestricted omits the numerical suffix, not runtime limits. These are planning targets, not enforced quotas or minimums. Honor the user's explicit scope and avoid allocating extra calls merely to reach a target.

Count total calls before launching: `items × stages`, or `discovery + admitted findings × votes + synthesis`. Dynamic fan-out needs an admission limit; reserve calls for mandatory final work. Concurrency controls how many run simultaneously, not how many calls exist. Several templates accept `args.maxCalls`; when adapting one, align that argument with the requested scope. The original review/migration templates expose their input lists instead: bound those lists and any discovered findings explicitly.

`budget.total` is configured by `PI_WORKFLOW_TOKEN_BUDGET`; `spent()` and `remaining()` return synchronous numbers refreshed after agents settle. Count total tokens (input + output), not only output tokens. Budget checks happen before calls are accepted; already in-flight calls can overshoot the ceiling. Leave room for synthesis and uncertain token use rather than treating the ceiling as a reservation system. A hard budget failure aborts the run; graceful completion requires the script to stop issuing work first.

Runtime backstops: at most 4096 items in one batch, 1000 launched agents in a run, and configurable per-run concurrency. They are not recommended workflow sizes.

## Failure and recovery

A dead, failed, skipped or missing-structured-result agent resolves to `null`, including bare `await agent(...)`. Guard before field access. A throwing pipeline item becomes null without stopping other items. Malformed options, unknown agents, invalid schemas and exhausted budgets fail the run; avoid broad catches that hide these authoring errors. Record failures separately from legitimate empty findings. Do not return "all clear" when discovery or verification failed.

`start` automatically reuses completed calls from the latest same-name, same-args run. A call's content key includes label, prompt, schema, agent, model and effort, plus occurrence number for repeated identical samples. Use stable meaningful labels; do not bake random IDs or timestamps into prompts. Changed inputs/calls run again. `reuse:'none'` disables prior-run result reuse for a fresh sample.

`resume` replays the saved script with completed calls cached; failed/skipped/unfinished calls retry. It is not a filesystem rollback or a transaction. Do not assume cached agents will repeat edits, regenerate deleted files, or apply results to changed repository state. Changed external state requires deliberate new inputs or `reuse:'none'`. Different independent branches need not finish in the same order after resume; use input-indexed results rather than shared completion-order side effects.

## Capability and concurrency boundaries

Nested `workflow()` and `isolation:'worktree'` are unsupported. Inline child control flow in the same script. Agents are normal definitions from `agents/`; workflow roles live in prompts and scripts, not in a special orchestration-only agent definition. Respect the caller's allowlist.

Parallel agents share the current directory. Separate write ownership by file or serialize edits; a readonly verifier can overlap independent work. Do not ask multiple agents to patch the same file concurrently. Scope validation commands so tests do not compete for the same mutable fixtures or external environment.

## Running and observing

Use `workflow({action:'start', name:'<template>', args:{...}})` for a bundled/saved script, or `script` for adapted source. Lookup order: project `.pi/workflows`, global workflows, bundled examples. Explicit paths are also accepted. `list` and `guide` are readonly, work without tmux or a persistent session, and never launch agents.

Start returns immediately; wait for the completion notification instead of polling. The main Subagents widget shows progress and usage. `/workflow` or Ctrl+Alt+W opens/toggles the tree; Focus opens original agent sessions, including completed sessions. Skip returns null to the script. Abort stops the run; Resume replays completed results and retries the rest. Read `output.json`/journal for full results if the completion message is truncated.
