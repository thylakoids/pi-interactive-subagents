# Workflow regression tests

Run from the repository root:

- `npm test`: unit tests and executable workflow contracts.
- `node --test test/integration/workflow-ui.test.ts`: real Pi/tmux UI, confirmations,
  Skip/Abort/Resume against the real manager, and original-session Focus/reuse.
- `node test/mutations/workflow.mjs`: isolated fault injection; every injected
  regression must fail an assertion, not just crash on an import or syntax error.

No provider calls are needed for these commands. The terminal test needs Pi and tmux.
Each test file owns a private tmux server with an empty configuration and clean tmux
identity variables, including when invoked directly. The caller need not be inside
tmux. Ordinary exit or interruption closes only the test server.

## What the tests actually prove

`workflow-contract.test.ts` runs the real VM and persistence layer. It checks clock
aliases across host responses and a manager reload, cache reuse with time-dependent
prompts, terminal accounting across live/disk/UI views, persisted aborts, and late
completion protection. Controlled host time and deferred responses avoid sleep-based
race guesses.

`workflow-templates.test.ts` executes all six shipped scripts. Assertions cover
result content and downstream inputs, failed stages, risky-file routing, rejected
and missing verdicts, evidence gaps, admission limits and real refinement rounds.
The scripted service substitutes only the model boundary. Missing structured replies
and assertions inside that boundary fail the test; they cannot silently become a
tolerated null agent result.

The terminal fixture uses a real WorkflowManager and QuickJS VM. Skip/Abort/Resume
must change the journal, not just a synthetic view. Focus reopens a real Pi session
and repeated Focus must reuse its pane without submitting a prompt. Cleanup waits
for terminal descendants before deleting artifacts.

These are not live model quality evaluations. Source fetching, reasoning quality,
and whether an LLM chooses an appropriate workflow require separate provider runs.

See [test maintenance](../docs/test-maintenance.md) for fixture consolidation and
coverage-comparison rules.

`native-message-delivery.test.ts` calls the actual steering, tmux transport and
native hook functions. Filesystem and command fault injection covers atomic ledger
reservation, unsent rollback, uncertain input, post-submit recording and lock errors,
public result propagation and repeated-message acknowledgement. The external-CLI
integration suite uses an isolated real tmux server and stand-in TUIs to verify that
a recording failure cannot close a queued native follow-up early. Neither test calls
a model provider or proves real Claude/Codex receipt.

## Avoid false confidence

- Parsing a template proves syntax/discovery, not executable behavior.
- Call counts alone do not prove correct evidence, outcomes or failure propagation.
- An immediately accepted critique does not exercise refinement.
- Unanimous successful voters do not prove quorum handling when a voter fails.
- A render fixture cannot prove manager actions, persistence or resume.
- A successful first run does not prove replay; reload the manager and change time
  or completion order, then assert the result and absence of new agent launches.
- Preserve focused smoke tests for diagnosis, but use behavioral assertions for
  correctness claims. Add a failing fault-injection case for critical regressions.

## Live-provider end-to-end checks (billed, explicit opt-in)

```sh
PI_WORKFLOW_LIVE=1 PI_TEST_MODEL=provider/model \
  node --test test/integration/workflow-live.test.ts
```

Without the opt-in variable this test skips, including during normal integration
runs. It uses the production subagent service and real provider-backed Pi sessions,
not a replacement service. Temporary project-local definitions select the requested
parent model through ordinary bundled agent definitions (with reduced thinking for
the billed test); both old template scripts run unchanged. Every child loadout is
checked for the runtime workflow contract, question tools, definition-based spawning
grants, and automatic exit after completion. The recovery probe uses the legacy workflow-subagent
name and verifies that it launches worker and reuses its completed result.

The suite independently checks:
- Review finds an injected boundary bug and a separate model verifies it.
- Migration plans, edits and verifies two actual files; Node acceptance tests pass.
- Fast Verify executes its real tool while slow Recon is blocked on a file gate.
  The host releases that gate only after observing the next-stage side effect.
- Abort stops a real blocked child. A new manager resumes from disk, reuses the
  completed session without repeating its side effect, and retries the interrupted
  call in a new session exactly once.

A child session must contain actual provider usage and tool calls; a successful
workflow status alone is insufficient. The test prints its temporary artifact
directory and retains session files, snapshots, journals, marker files and events,
on both success and failure. Its tmux session is stopped during teardown.

`workflow-worker.test.ts` covers default worker selection, legacy script aliases,
user legacy definitions, old journal replay (including repeated calls whose first
occurrence failed), authorization, mandatory workflow adapter flags and execution
policy. Model inheritance tests also ensure native CLI profiles do not pin models.

## Live model collaboration

```sh
PI_WORKFLOW_LIVE=1 PI_TEST_MODEL=provider/model \
  node --test test/integration/workflow-collaboration-live.test.ts
```

This billed test uses a real root model, real workflow workers and a delegated scout.
Only the root receives a random token. A worker asks for it, the real root model
observes the waiting state and invokes subagent_message, and the same worker
continues, delegates file reading, consumes the scout result and writes the token.
A second real worker asks another question, parks, and is aborted while waiting;
its pane closes and its journal/disk state is terminal. Delayed replies are rejected.
Artifacts and transcripts are retained and their directory is printed.

workflow-questions.test.ts exercises the actual question tool, retryable parent
notification and reply router. Delegated notifications cannot clear an outstanding
question, and tools remain blocked until a real parent input arrives.
workflow-descendants.test.ts checks real tmux cancellation ancestry without model
calls, including preservation of unrelated sibling/parent panes.
