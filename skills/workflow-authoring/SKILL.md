---
name: workflow-authoring
description: Write or adapt JavaScript workflows for pi-interactive-subagents, choosing pipeline, barriers, per-finding fan-out, voting, synthesis or bounded iteration. Use when authoring a workflow or explicitly asked to orchestrate agents; ordinary tasks do not authorize a workflow.
---

# Workflow authoring

Turn the user's opted-in task into a small program with explicit data dependencies. A workflow request authorizes orchestration within its scope; merely loading this skill, listing templates, or finding a task parallelizable does not. For one task or a few manually managed agents, use `subagent` instead.

Before writing a script, read [the authoring reference](references/authoring.md). It explains the API contract, failure/recovery rules, input requirements and runnable examples. If skills or file reads are unavailable, `workflow({ action: 'guide' })` returns this skill, the reference and current runtime declarations.

Choose the nearest skeleton, then adapt its prompts and inputs:

| Dependency | Shape | Runnable starting point |
| --- | --- | --- |
| Independent investigations, then compare all answers | Fan-out + barrier + synthesis | `compare-options` |
| Each item can advance as soon as its own previous step finishes | Per-item pipeline (default) | `migrate-files` |
| A result discovers a variable number of findings | Per-finding fan-out | `review-changes` |
| Several independent checks of the same claim | Adversarial voting | `verify-claims` |
| Scope, find evidence, check claims, write a sourced report | Composite pipeline + voting + synthesis | `deep-research` |
| Improve an artifact until accepted or bounded resources run out | Budget-aware iteration | `iterative-refinement` |

Use `workflow({ action: 'list' })` to discover available names, descriptions, `whenToUse`, phases and paths. A project or global script can override a bundled name. Read the actual selected script before adapting it: `workflow({ action: 'guide', name: '<name>' })` returns it without execution. Templates are ordinary scripts, not agent definitions.

Plan total calls, not just the initial fan-out: include verifiers, votes, retries and synthesis. Size targets are small ~5, medium ~10 (default), large ~50; choose less whenever sufficient. These are guidance, not hard execution caps. Honor an explicit requested scope. Limit discovered findings before expanding them, reserve synthesis capacity, and bound all loops even when no token budget is configured.

Pass only self-contained prompts. Require structured output when code inspects fields. Report failed, skipped, rejected and unverified outcomes separately. Verify evidence independently; agreement among agents alone does not make a claim true. Preserve gaps in the final result.
