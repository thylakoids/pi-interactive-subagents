# Workflow regression tests

Run from the repository root:

- `npm test`: unit tests and executable workflow contracts.
- `node --test test/integration/workflow-ui.test.ts`: real Pi/tmux UI, confirmations,
  Skip/Abort/Resume against the real manager, and original-session Focus/reuse.
- `node test/mutations/workflow.mjs`: isolated fault injection; every injected
  regression must fail an assertion, not just crash on an import or syntax error.

No provider calls are needed for these commands. The terminal test needs Pi and tmux.

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
