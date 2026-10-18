# Workflow validation

Run these against one frozen checkout, after all writers have handed off:

```sh
npm test
node test/mutations/workflow.mjs
PI_TEST_MODEL=provider/model npm run test:integration
PI_WORKFLOW_LIVE=1 PI_TEST_MODEL=provider/model node --test --test-concurrency=1 test/integration/workflow-live.test.ts test/integration/workflow-collaboration-live.test.ts test/integration/workflow-protection-live.test.ts
```

Run the integration commands inside tmux; otherwise the legacy lifecycle and
surface suites skip. They require configured provider credentials and
make billed model calls. The three workflow live suites are otherwise skipped.
Test agent definitions inherit the selected parent model; they must not pin a
different provider behind `PI_TEST_MODEL`.
`PI_TEST_PI` can select an absolute Pi executable. Test launchers remove npm's
temporary binary directories from PATH so `npm run` cannot silently substitute
the package's peer Pi binary for the user's installed runtime.

## Evidence requirements

- Template tests execute the shipped script through the VM, scheduler and
  journal. Their agent responses are controlled: they test branching, not model
  compliance or tool availability.
- Race tests use launch gates and observed states before issuing Skip or Abort.
  A sleep alone does not prove the intended race happened.
- Mutation tests must fail a behavioral assertion, not crash on syntax or
  imports. They check selected known faults, not general correctness.
- The workflow live suite checks both old templates, overlapping pipeline
  stages, and disk-based Abort/Resume against retained transcripts and files.
- The collaboration live suite checks actual parent replies, child delegation,
  waiting-state Abort, and rejection of a late reply. All actors use real models.
- The protection live suite observes actual panes before worker startup, cancels
  with Skip/Abort, and checks a real successor and disk Resume. A real model must
  attempt a denied write through verify_command and then run passing tests;
  transcript results and unchanged file bytes are checked independently.
  It also aborts after a real verification command has started and checks the
  command's process group, not just the disappearance of its tmux pane.
- Sandbox lifecycle regressions kill an actual owning process while its command
  is running; direct AbortSignal tests alone cannot prove parent-death cleanup.
- A prompt echoed on screen is not evidence of a tool call. Missing session
  paths must fail tests rather than silently bypass transcript assertions.

Keep full logs and exit codes. Do not pipe a test command into `tail` and report
the pipeline's exit status as the test result. A failed or interrupted run is
not validation of the final tree; fix it and rerun the affected suite.

The bundled code-review and migration verification steps now enforce readOnly
at runtime, not just through prompts. Sandboxed commands currently require
macOS sandbox-exec; unsupported platforms fail closed. Ordinary writable steps
remain writable. This restriction does not isolate simultaneous writers, bound
CPU/memory, or provide a general hostile-code security boundary.
