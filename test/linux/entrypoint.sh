#!/usr/bin/env bash
# Container entry point: prove the platform, stage the repository, then run the
# requested suite. Terminal and live suites run inside a tmux session this script
# owns, because the lifecycle/surface tests need a real pane; unit and mutation
# suites run directly, unchanged.
#
# Credentials: only what a caller explicitly mounted read-only at /run/pi-secret
# is touched. It is copied into the container's own HOME and never written to the
# evidence mounts.
set -Eeuo pipefail

log() { printf '[pi-linux] %s\n' "$*"; }
die() { printf '[pi-linux] ERROR: %s\n' "$*" >&2; exit 2; }

EVIDENCE=${PI_LINUX_EVIDENCE:-/evidence}
COMMAND=${PI_LINUX_COMMAND:-npm test}
SUITE=${PI_LINUX_SUITE:-}
TIMEOUT=${PI_LINUX_SUITE_TIMEOUT:-3600}
SUITE_LOG="$EVIDENCE/logs/suite.log"

# -- platform contract -------------------------------------------------------
[[ "$(uname -s)" == Linux ]] || die "a real Linux kernel is required (uname -s = $(uname -s)); this image must not run under emulation"
[[ "$(id -u)" -ne 0 ]] || die "tests must run as a non-root user, not uid 0"
[[ "${PI_REQUIRE_READONLY_SANDBOX:-0}" == 1 ]] || die "PI_REQUIRE_READONLY_SANDBOX=1 is required: a run whose sandbox silently skips is not acceptance evidence"
[[ -f /src/package.json ]] || die "the repository must be mounted read-only at /src"
[[ -d /opt/pi-deps/node_modules ]] || die "workspace dependencies are missing from the image"
[[ -d "$EVIDENCE" ]] || die "the evidence directory must be mounted at $EVIDENCE"

for binary in bwrap python3 tmux ps git pi node rsync; do
  command -v "$binary" >/dev/null 2>&1 || die "missing required binary: $binary"
done

# A Linux kernel alone does not prove the run is native: the kernel arch and
# the node arch must both equal the docker server architecture the runner
# recorded. A mismatch means the container platform is emulated.
if [ -n "${PI_LINUX_EXPECT_ARCH:-}" ]; then
  case "$(uname -m)" in
    aarch64|arm64) kernel_arch=arm64 ;;
    x86_64|amd64)  kernel_arch=amd64 ;;
    *)             kernel_arch=$(uname -m) ;;
  esac
  node_arch=$(node -p "process.arch")
  # node reports x64 where the docker daemon reports amd64.
  case "$node_arch" in
    x64|amd64)     node_arch=amd64 ;;
    arm64|aarch64) node_arch=arm64 ;;
  esac
  [ "$kernel_arch" = "$PI_LINUX_EXPECT_ARCH" ] || die "kernel arch $kernel_arch does not match the expected $PI_LINUX_EXPECT_ARCH: the container platform is emulated"
  [ "$node_arch" = "$PI_LINUX_EXPECT_ARCH" ] || die "node arch $node_arch does not match the expected $PI_LINUX_EXPECT_ARCH: the image was built for another architecture"
  log "arch: kernel $kernel_arch | node $node_arch | expected $PI_LINUX_EXPECT_ARCH (docker server)"
fi

log "kernel: $(uname -sr) | machine: $(uname -m) | user: $(id -un) (uid $(id -u))"
log "node: $(node --version) | npm: $(npm --version) | bwrap: $(bwrap --version | head -1)"
resolved_pi=$(cat /usr/local/share/pi-cli/version.txt 2>/dev/null || echo "unknown")
log "pi: $resolved_pi (resolved from the image; see /usr/local/share/pi-cli/version.txt)"

# -- stage the repository into a writable worktree --------------------------
# /src is read-only on purpose: the tests must never write into the host tree.
# node_modules comes from the image, so the host's macOS binaries cannot leak in.
# Everything below runs from /work so imports resolve against the image's deps.
mkdir -p /work
rsync -a --delete --exclude node_modules --exclude .git /src/ /work/
ln -sfn /opt/pi-deps/node_modules /work/node_modules
cd /work
log "workspace: /src staged into /work (node_modules from the image)"

# -- production sandbox smoke, through the real tool path -------------------
# Preflight through the production tool path:
#   runVerifyCommand is exactly what verify_command calls, including the extra
#   file descriptors the launcher wires in. Spawning bwrap directly would skip
#   them and fail for the wrong reason.
#   The write probe targets an existing workspace file (package.json): the
#   read-only bind plus DAC must reject it, and the bytes must stay identical.
#   Nothing here reads or prints credentials.
node --input-type=module -e '
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runVerifyCommand } from "/work/pi-extension/subagents/workflow/readonly.ts";

const root = mkdtempSync(join(process.env.TMPDIR || "/tmp", "pi-linux-probe-"));
const scratch = join(root, "scratch");
mkdirSync(scratch, { recursive: true });
const fail = (message) => { console.error("[pi-linux] " + message); process.exit(1); };

try {
  const okRun = await runVerifyCommand({ command: "true", scratchDir: scratch, cwd: scratch });
  if (!okRun.ok) fail("verify_command could not run under the sandbox: " + (okRun.error || "unknown error"));
  if (!okRun.executed) fail("the sandbox refused to execute the probe command");
  if (okRun.exitCode !== 0) fail("the probe command exited " + okRun.exitCode + ": " + okRun.output);

  const target = "/work/package.json";
  const before = readFileSync(target);
  const denied = await runVerifyCommand({ command: "printf x >> /work/package.json", scratchDir: scratch, cwd: "/work" });
  if (!denied.ok || !denied.executed) fail("the write probe did not run: " + (denied.error || "unknown error"));
  if (denied.exitCode === 0) fail("the sandbox let a command write to the workspace; refusing to call this read-only");
  if (!readFileSync(target).equals(before)) fail("the workspace file changed during the denied write probe");

  console.log("preflight: verify_command ran under bwrap (exit 0), workspace write denied, package.json byte-identical");
} finally {
  rmSync(root, { recursive: true, force: true });
}
' || die "the workflow read-only backend is not usable in this image. The container needs --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined: the last one only lifts Docker's masked /proc submounts so the nested bwrap can mount its own /proc; production runs are unaffected. See docs/workflow-testing.md"
# -- credentials: only what the caller mounted, copied into HOME ------------
mkdir -p "$HOME/.pi/agent"
copied=""
for file in auth.json models.json; do
  if [[ -f "/run/pi-secret/$file" ]]; then
    cp -f "/run/pi-secret/$file" "$HOME/.pi/agent/$file"
    chmod 600 "$HOME/.pi/agent/$file"
    copied="$copied $file"
  fi
done
# Only the agent directory and the copied files are restricted. A recursive
# chmod would walk into the sessions bind mount, whose files belong to the host
# user and whose permissions are evidence, not ours to change.
chmod 700 "$HOME/.pi" "$HOME/.pi/agent"
if [ -n "$copied" ]; then
  log "credentials: copied$copied from the read-only mount (nothing else: no sessions, settings, extensions or plugins)"
else
  log "credentials: /run/pi-secret has no auth.json or models.json; suites that call models will fail without provider auth"
fi
if [[ "${PI_NATIVE_CLI_LIVE:-0}" == 1 ]]; then
  for binary in claude codex; do command -v "$binary" >/dev/null || die "native suite requires $binary in the image"; done
  for file in claude.json claude/settings.json codex/config.toml codex/auth.json; do
    if [[ -f "/run/pi-secret/$file" ]]; then
      mkdir -p "$(dirname "$HOME/.$file")"
      cp "/run/pi-secret/$file" "$HOME/.$file"
      chmod 600 "$HOME/.$file"
    fi
  done
fi
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

# -- evidence: everything the suites write away from HOME -------------------
mkdir -p "$EVIDENCE/logs" "$EVIDENCE/tmp" "$HOME/.pi/agent/sessions"
export TMPDIR="$EVIDENCE/tmp"
if [[ "$SUITE" == unit || "$SUITE" == mutations ]]; then
  # Mutation copies are short-lived and deletion-sensitive: exercise the native
  # Linux filesystem, not a Docker Desktop host-file-sharing implementation.
  export TMPDIR=/tmp
fi
: > "$SUITE_LOG"

# -- run the suite ---------------------------------------------------------
if [[ "$SUITE" == terminal || "$SUITE" == live ]]; then
  # These suites assert on real panes, so the suite itself must run inside a tmux
  # session this script owns. The exit sentinel is the only source of truth for
  # the status; the deadline kills this script's own session, nobody else's.
  session="pi-e2e-$$"
  sentinel="$EVIDENCE/exit-$SUITE-$$"
  wrapper=/tmp/pi-e2e-suite.sh
  cat > "$wrapper" <<'WRAPPER'
#!/usr/bin/env bash
set -o pipefail
cd /work || exit 90
bash -c "$PI_LINUX_COMMAND" 2>&1 | tee "$PI_LINUX_SUITE_LOG"
status=${PIPESTATUS[0]}
printf '%s' "$status" > "$PI_LINUX_SENTINEL"
exit "$status"
WRAPPER
  chmod 0755 "$wrapper"
  log "tmux: starting the suite in owned session $session"
  tmux new-session -d -s "$session" -x 160 -y 48 \
    env PI_LINUX_COMMAND="$COMMAND" PI_LINUX_SUITE_LOG="$SUITE_LOG" PI_LINUX_SENTINEL="$sentinel" "$wrapper"
  tail -n +1 -f "$SUITE_LOG" &
  live_tail=$!
  started=$(date +%s)
  while [[ ! -f "$sentinel" ]]; do
    if (( $(date +%s) - started > TIMEOUT )); then
      tmux kill-session -t "$session" 2>/dev/null || true
      kill "$live_tail" 2>/dev/null || true
      printf '[pi-linux] ERROR: suite %s timed out after %ss\n' "$SUITE" "$TIMEOUT" >&2
      exit 124
    fi
    sleep 1
  done
  sleep 1
  kill "$live_tail" 2>/dev/null || true
  wait "$live_tail" 2>/dev/null || true
  tmux kill-session -t "$session" 2>/dev/null || true
  status=$(cat "$sentinel" 2>/dev/null || echo 1)
  rm -f "$sentinel"
  log "tmux: suite exited with status $status"
  exit "${status:-1}"
fi

# Unit and mutation suites need no pane: run them directly, semantics unchanged.
bash -c "$COMMAND" 2>&1 | tee "$SUITE_LOG"
exit "${PIPESTATUS[0]}"
