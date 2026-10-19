# Workflow validation

Run these against one frozen checkout, after all writers have handed off:

```sh
npm test
node test/mutations/workflow.mjs
PI_TEST_MODEL=provider/model npm run test:integration
PI_WORKFLOW_LIVE=1 PI_WORKFLOW_REVIEW_LIVE=1 PI_TEST_MODEL=provider/model node --test --test-concurrency=1 test/integration/workflow-live.test.ts test/integration/workflow-collaboration-live.test.ts test/integration/workflow-protection-live.test.ts test/integration/workflow-review-live.test.ts
```

Run the integration commands inside tmux; otherwise the legacy lifecycle and
surface suites skip. They require configured provider credentials and
make billed model calls. The four workflow live suites are otherwise skipped.
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
  It also attempts an existing FIFO write against a live outside peer, which
  read-only mounts alone do not prevent on Linux.
  It also aborts after a real verification command has started and checks the
  command's process group, not just the disappearance of its tmux pane.
- The review live suite checks fresh starts, explicit reuse, disk resume after
  borrowing cached calls, label-only edits, free-form structured objects, real
  isolated writes, nested scripts/depth errors, default-no-retry and opt-in
  stall recovery. It requires all feature probes, not optional subtest gates.
- Sandbox lifecycle regressions kill an actual owning process while its command
  is running; direct AbortSignal tests alone cannot prove parent-death cleanup.
- A prompt echoed on screen is not evidence of a tool call. Missing session
  paths must fail tests rather than silently bypass transcript assertions.

Keep full logs and exit codes. Do not pipe a test command into `tail` and report
the pipeline's exit status as the test result. A failed or interrupted run is
not validation of the final tree; fix it and rerun the affected suite.

## Review regressions: test the boundaries, not just the stubs

The issue review exposed gaps in the old coverage, not merely missing happy-path
examples. Scripted subagents returned valid values and successful launches, so
they could not expose a filesystem exception before spawn, a failing journal
write, a pending name collision, or a real provider rejecting a nested schema.
Tests for cache replay did not distinguish a new run's budget from a resumed
run's lifetime spend, and treated display labels as part of execution identity.

- Launch regressions fault the actual call directory and journal, bound the
  wait, assert the script proceeds, and check no unhandled rejection escapes.
- Reservation regressions hold a launch at an observed gate and use the real
  manual naming function; live probes also check the production adapter shares
  the same pending-name set before the child is registered.
- Schema regressions validate the registered tool's parameters, invoke execute,
  and check the bytes written. The parent independently validates sidecars;
  merely creating a result file is not proof of a valid structured answer.
- Cache regressions reload the manager from disk, rename labels, preserve
  independent repeated samples, and exercise old journal keys. Fresh starts,
  explicit cross-run reuse, and same-run resume have separate spend assertions.
- Worktree regressions use real Git repositories and compare the parent dirty
  state before/after; mock cwd propagation alone cannot prove isolation or
  preservation of untracked work and commits.

Mutation checks deliberately restore selected old faults and require a
behavioral assertion failure. A green count alone does not show sensitivity;
inspect what action occurred, what observable state changed, and what would
make each assertion fail.

The bundled code-review and migration verification steps now enforce readOnly
at runtime, not just through prompts. Sandboxed commands require a verified backend - macOS `sandbox-exec`, or
Linux `bubblewrap` as exercised by the Linux image described below - and fail
closed everywhere else. Ordinary writable steps
remain writable. This restriction does not isolate simultaneous writers, bound
CPU/memory, or provide a general hostile-code security boundary.

## Linux end-to-end (real kernel, read-only sandbox)

macOS uses `sandbox-exec`. Linux uses `bubblewrap`, and that backend is only
credible on a real Linux kernel with unprivileged user namespaces. The image in
`test/linux/` provides exactly that, plus tmux, ps and a non-root user:

```sh
PI_TEST_MODEL=provider/model test/linux/run              # build if needed, run everything
PI_TEST_MODEL=provider/model test/linux/run --suite live  # the four billed suites only
test/linux/run --suite unit                               # no model needed
test/linux/run --rebuild --suite-timeout 7200
```

Environment: `PI_SECRET_DIR` (optional directory mounted read-only at
`/run/pi-secret`), `PI_TEST_MODEL`, `PI_LINUX_IMAGE`, `PI_LINUX_PLATFORM`,
`PI_LINUX_LOG_DIR`, `PI_LINUX_SUITE_TIMEOUT`, `PI_CLI_VERSION` (default `latest`).
The platform is not guessed from `uname`: it is derived from the docker daemon's
own architecture (`docker info --format "{{.Architecture}}"`), an explicit
`PI_LINUX_PLATFORM` must match it, and the runner then verifies that the image
platform, the container's `uname -m` and `node -p process.arch` (normalized,
since node says `x64` where docker says `amd64`) all agree with
that value before any suite runs. A mismatch is treated as emulation and fails
the run; `docker-arch.txt`, `container-uname.txt` and `container-arch.txt`
record what was actually exercised.

### Container security posture

The container is never privileged, never gains capabilities, never sees the
docker socket, and still runs as the image's non-root `node` user. It gets three
relaxations, and nothing else:

```sh
--security-opt seccomp=unconfined
--security-opt apparmor=unconfined
--security-opt systempaths=unconfined
```

The first two let a nested bubblewrap create its own namespaces. The third only
lifts Docker's masked `/proc` submounts: without it, bwrap's own `--proc /proc`
fails with EPERM on a default Docker setup.

Every suite container also runs with `--init`: the owner-SIGKILL and watchdog
tests deliberately orphan process groups, and without a PID 1 that reaps them
the leftovers would sit as zombies and make a later `kill -0 <pgid>` report the
group as alive. The process-group assertions are meant to fail on a live process,
never to be satisfied by ignoring zombies. These flags apply to the test
container only. Production runtime behaviour is unchanged: each verification
command is still isolated by read-only bwrap mounts, mandatory user/PID/network
namespaces, no capabilities, a private read-only `/dev` and `/proc`, and a
seccomp program denying external socket creation (including the io_uring path).
`/tmp` is not shadowed, so projects stored there remain readable. Python 3 applies
Landlock WRITE_FILE restrictions before exec: existing host FIFOs and devices
cannot be opened for writing either. Only the fresh command scratch and
`/dev/null` are writable. Local socketpairs remain available for `node --test`.

On a native Debian/Ubuntu host, install `bubblewrap`, `procps` and `python3`.
The kernel must enable unprivileged user namespaces, seccomp and Landlock ABI 1
or newer (Linux 5.13+). Missing dependencies or a denied namespace/Landlock setup
produce an explicit error and never an unsandboxed command. No host security
settings are changed automatically.

The entrypoint checks backend startup and filesystem protection before any suite
starts, through the same code path the suites use. IPC and process-lifecycle
probes run in the suites. The preflight calls `runVerifyCommand()` with `true` and requires
`ok`, `executed` and exit code 0, then repeats it with a write to an existing
workspace file (`package.json`). The read-only bind plus DAC must reject that
write while the file stays byte-identical. Spawning bwrap directly would skip the
extra file descriptors the launcher wires in and fail for the wrong reason, so
the probe never does that. It also refuses uid 0, refuses
`uname -s` other than Linux, and refuses to run without
`PI_REQUIRE_READONLY_SANDBOX=1`.

### Credentials

Nothing credential-shaped is baked into the image or the build context:
`test/linux/Dockerfile.dockerignore` whitelists only `package.json`,
`package-lock.json` and `test/linux/entrypoint.sh`. Provider auth is supplied at
run time as a read-only mount:

```sh
PI_SECRET_DIR=/path/to/agent-config PI_TEST_MODEL=provider/model test/linux/run
```

The mount is `/run/pi-secret:ro`. The entrypoint copies only `auth.json` and
`models.json` into the container's private `$HOME/.pi/agent` (directory mode
0700, files 0600), never sessions, settings or executable extensions. The mount
is left untouched. Use a minimal provider-only directory outside the repository;
its files must be readable by the container user. A readable subdirectory under
a private host directory avoids making credentials accessible to other host users.

### What runs, and what may skip

`--suite all` runs, in order: `npm test`, `node test/mutations/workflow.mjs`,
`npm run test:integration`, and the three billed suites with
`PI_WORKFLOW_LIVE=1` (`workflow-live`, `workflow-collaboration-live`,
`workflow-protection-live`).

Unit and mutation suites run directly in the container. The terminal and live
suites need a real pane, so the entrypoint creates a tmux session it owns and
runs the suite inside it, waiting for the suite's own exit sentinel with
`PI_LINUX_SUITE_TIMEOUT` as the deadline (default one hour). A timeout kills only
that owned session and exits 124.

Skipping is treated as a failure:

- `unit`: no `# SKIP` at all - the read-only sandbox suites must really run on Linux.
- `terminal`: exactly the three live suites may skip (they run separately with
  `PI_WORKFLOW_LIVE=1`). `subagent-lifecycle`, `tmux-surface` or
  `workflow tree terminal` skipping is an environment fault, not a pass.
- `live`: no skip; a billed suite that skipped is a failure.

Every suite also has to leave a real summary in its log (TAP `# tests` for the
node suites, the baseline/fault line for the mutation runner).

### Evidence and exit codes

Each suite gets `<log dir>/<suite>/` on the host, mounted into the container:

- `logs/suite.log` - the suite's own output (the TAP/skip checks read this file);
- `console.log` - the container's stdout/stderr stream;
- `exit` - the suite exit code;
- `tmp/` - mounted at `/evidence/tmp` and exported as `TMPDIR`, so every
  `mkdtemp` fixture and worktree survives the container;
- `sessions/` - mounted at `/home/node/.pi/agent/sessions`, so child pi sessions
  survive the container too. Credentials are not part of this tree: they live in
  `$HOME/.pi/agent` (outside the evidence mounts) for the duration of the run.

The log root is created mode 0700 and each per-suite directory is 0777, because
the container user (uid 1000) is not the host user: the parent still keeps other
host users out, while the container can write its evidence. `summary.txt`, the
image id and the resolved pi version sit at the log root. The runner exits
non-zero if any suite failed or a forbidden skip appeared.

### Troubleshooting

- `bwrap rejected the production flags` / `bwrap cannot create a user namespace`:
  the kernel or the container profile blocks unprivileged user namespaces. Keep
  all three `--security-opt` flags; on a Linux host also check
  `kernel.unprivileged_userns_clone=1` (older Debian/Ubuntu) or
  `kernel.apparmor_restrict_unprivileged_userns=0` (Ubuntu 24.04+).
- `the read-only backend refused to run on this host`: the product's
  `resolveVerifyBackend()` did not select `bwrap`; the image or the runtime
  change is incomplete.
- `missing required binary`: the image was built from an unexpected base.
- Live suites fail with auth errors: `PI_SECRET_DIR` is missing or does not
  contain a pi agent config; `PI_TEST_MODEL` must name a provider/model the
  mounted credentials can reach.
