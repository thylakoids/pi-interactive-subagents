# Test maintenance

Keep tests focused on production behavior. Delete a weaker case when a retained
case already asserts the same contract. When several tests repeatedly construct
the same fixture, prefer one coherent lifecycle or a named input table, retaining
each distinct input and assertion. Keep separate scheduling races, durability
failures, sandbox enforcement layers, and platform-specific behavior.

## Cleanup baseline

The comparison starts at `e30886b`. Production sources, coverage filters, Node
version, and platform were held constant. The default offline suite changed as
follows:

| Measurement | Before | After |
| --- | ---: | ---: |
| Registered tests | 584 | 511 |
| Line coverage | 66.31% | 66.31% |
| Function coverage | 58.20% | 58.20% |
| Branch coverage | 80.14% | 80.25% |

The 73-case reduction is 12.5%. It combines deletion of redundant cases with
consolidation of fixture setup; distinct input checks still execute. Previously
covered production lines and functions were also compared by source file, rather
than relying only on rounded global percentages.

Examples of retained coverage:

- Session and loadout tests follow absent, populated, updated, and corrupt files
  through the production readers and writers.
- The copied frontmatter/routing smoke implementation was removed. Existing
  production tests now check system-prompt modes through `loadAgentDefaults` and
  `applySandboxToParts`, including missing and invalid modes and empty identities.
- The exact lifetime agent-cap test replaces a weaker duplicate that also accepted
  an unrelated inactivity error. Cold journal replay replaces the weaker replay
  check; strict budget arithmetic replaces redundant type-only assertions.
- Schema and option tables retain absent versus explicit properties, each invalid
  option, and direct-execution rejection. A rejected result also must leave an
  already recorded valid result unchanged.
- Capacity tables retain every previous terminal dimension and expected result.
  Worktree lifecycle tests retain clean and dirty parent preservation, isolated
  writes, detached commits, and committed/uncommitted reuse while sharing Git setup.
- CLI lifecycle tests retain receipt, transcript, failure, native resume, literal
  prompt, and code-injection checks. Import variants run in independent processes
  so the module cache cannot hide an unresolvable caller executable.

The delayed Claude Stop test waits for an observed failed lock acquisition before
releasing the lock. A transcript-read notification alone can race acquisition and
leave the synchronous wait path untested.

## Inspect and stop validation

Keep evidence readers, owned-process cleanup, and model-driven behavior separate
so a passing fixture does not stand in for a live acceptance run:

- `test/subagent-inspect.test.ts` checks read-only snapshots, session and launch
  identities, historical activity after restart, and requested versus confirmed
  stop evidence. Reads must leave session, activity, question and inbox files
  unchanged.
- `test/integration/owned-surface-stop.test.ts` runs isolated tmux panes and real
  processes. It checks detached tool and delegated pane cleanup, stale ownership
  rejection, unavailable query evidence, and parent/sibling preservation.
- `test/integration/subagent-inspect-stop.test.ts` exercises lifecycle controls
  with real isolated processes and durable files, without a provider. This is
  process integration evidence, not real-model end-to-end acceptance.
- `test/integration/subagent-inspect-stop-live.test.ts` requires actual Pi model
  access and explicit opt-in. It covers production tools with running and
  `ask_question` children, stopping and delayed replies, and deliberate resume.
  A skipped live suite does not establish acceptance for those cases.

Run the targeted process checks with tmux available on `PATH`:

```sh
node --test --test-concurrency=1 \
  test/integration/owned-surface-stop.test.ts \
  test/integration/subagent-inspect-stop.test.ts
```

Run the billed suite only with an existing authorized provider and an explicit
model; do not set up credentials or change global model defaults for a test:

```sh
PI_WORKFLOW_LIVE=1 PI_TEST_MODEL=provider/model \
  node --test test/integration/subagent-inspect-stop-live.test.ts
```

Retain failures and report unsupported backends or unavailable model access
explicitly. Confirmation must come from independent termination evidence;
calling a cleanup helper that suppresses errors is insufficient.

## Worker resource inheritance

`node --test test/integration/worker-inheritance.test.ts` runs real Pi sessions with isolated configuration and tmux, a loopback scripted provider, a global extension and a local mock Computer Use MCP server. It checks fresh tool calls on worker launch and same-session resume with a new launch identity/process, restricted-child exclusion, and workflow worker inheritance with nested workflows excluded. No paid model or actual desktop control is used; this proves resource loading and invocation, not model judgment or desktop permissions.

## Reproduce coverage

Run in each checkout with the same dependencies and environment:

```sh
node --test --experimental-test-coverage \
  --test-coverage-include='pi-extension/**' \
  --test-reporter=lcov --test-reporter-destination=/tmp/coverage.lcov \
  --test-reporter=tap --test-reporter-destination=/tmp/tests.tap \
  test/*.test.ts test/test.ts
node test/mutations/workflow.mjs
```

Preserve separate before/after reports. Compare per-file covered locations and
coverage totals, and keep the mutation runner's passing-control checks. Node
reports separate records for modules imported under different query strings; do
not change that module graph or the coverage filters to improve the percentage.
The fault runner must still detect all 103 faults applicable on macOS. Linux-only
sandbox checks were not exercised in this macOS comparison; those fault cases
and the live-provider and terminal integration suites were left intact.
