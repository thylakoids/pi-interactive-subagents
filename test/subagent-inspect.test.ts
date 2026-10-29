import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectNamedSubagent } from "../pi-extension/subagents/lifecycle.ts";
import { registerName } from "../pi-extension/subagents/session.ts";
import { writeSubagentActivityFile, type SubagentActivityPhase, type SubagentActivityState } from "../pi-extension/subagents/activity.ts";

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "pi-inspect-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, "child.jsonl");
  const activityFile = join(dir, "activity.json");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-id" }) + "\n");
  const execution = { id: "launch-id", backend: "pi" as const, startedAt: 100, activityFile };
  const entry = { sessionFile, sessionId: "session-id", execution };
  const running = { id: execution.id, sessionFile, activityFile, startTime: execution.startedAt };
  const save = (value: any = entry) => registerName(dir, "worker", value);
  const activity = (phase: SubagentActivityPhase = "active", id = execution.id) => {
    const value: SubagentActivityState = {
      version: 1, runningChildId: id, createdAt: 100, updatedAt: 150, sequence: 3,
      latestEvent: phase === "waiting" ? "ask_question" : "session_start", phase,
      agentActive: phase === "active", turnActive: false, providerActive: false, toolActive: false,
    };
    writeSubagentActivityFile(activityFile, value);
  };
  save();
  return { dir, sessionFile, activityFile, execution, entry, running, save, activity };
}

function filesSnapshot(dir: string) {
  return Object.fromEntries(readdirSync(dir, { recursive: true }).map(String).sort().flatMap(name => {
    const file = join(dir, name), stat = statSync(file);
    return stat.isFile() ? [[name, { contents: readFileSync(file, "utf8"), modifiedAt: stat.mtimeMs }]] : [];
  }));
}

it("inspect reports owned running and waiting activity without writing messages, inboxes or evidence", t => {
  const f = fixture(t);
  mkdirSync(join(f.dir, "child.jsonl.control-launch-id", "inbox"), { recursive: true });
  writeFileSync(`${f.sessionFile}.ask`, JSON.stringify({ question: "Continue?" }));
  for (const [phase, expected] of [["active", "running"], ["waiting", "waiting"], ["starting", "starting"], ["done", "finished"]] as const) {
    f.activity(phase);
    const before = filesSnapshot(f.dir);
    const result = inspectNamedSubagent(f.dir, "worker", f.running, 200);
    assert.equal(result.state, expected);
    assert.equal(result.id, "launch-id");
    assert.equal(result.backend, "pi");
    assert.equal(result.sessionFile, f.sessionFile);
    assert.equal(result.sessionId, "session-id");
    assert.equal(result.observedAt, 200);
    assert.equal(result.evidenceAt, 150);
    assert.equal(result.stale, false);
    assert.match(result.reason, /liveness was not independently checked/);
    assert.deepEqual(filesSnapshot(f.dir), before, "inspection must leave all session, question and inbox evidence untouched");
  }
});

it("restart inspection preserves historical phases and never claims a persisted activity snapshot is live", t => {
  const f = fixture(t);
  for (const phase of ["active", "waiting", "done"] as const) {
    f.activity(phase);
    const before = filesSnapshot(f.dir);
    const result = inspectNamedSubagent(f.dir, "worker", undefined, 200);
    assert.equal(result.state, "unknown");
    assert.equal(result.historicalPhase, phase);
    assert.equal(result.stale, true);
    assert.equal(result.evidenceAt, 150);
    assert.match(result.reason, /historical launch/);
    assert.deepEqual(filesSnapshot(f.dir), before);
  }
});

it("saved completion and stop evidence distinguish finished, requested and confirmed termination", t => {
  const f = fixture(t);
  for (const [extra, state, evidenceAt, reason] of [
    [{ finishedAt: 180 }, "finished", 180, /did not resume/],
    [{ stop: { requestedAt: 170 } }, "stop_requested", 170, /not been confirmed/],
    [{ finishedAt: 175, stop: { requestedAt: 170, confirmedAt: 190, reason: "Owned pane and processes absent." } }, "stopped", 190, /Owned pane and processes absent/],
  ] as const) {
    f.save({ ...f.entry, execution: { ...f.execution, ...extra } });
    const result = inspectNamedSubagent(f.dir, "worker", undefined, 200);
    assert.equal(result.state, state);
    assert.equal(result.evidenceAt, evidenceAt);
    assert.equal(result.stale, false);
    assert.match(result.reason, reason);
  }
  f.save();
  const requested = inspectNamedSubagent(f.dir, "worker", { ...f.running, stopRequested: true }, 200);
  assert.equal(requested.state, "stop_requested");
  assert.equal(requested.evidenceAt, null, "a boolean intent has no independently recorded request time");
  assert.match(requested.reason, /no persisted termination confirmation/);
});

it("missing, malformed and wrong-launch activity remain explicit unknown evidence", t => {
  const f = fixture(t);
  for (const kind of ["missing", "invalid", "wrong-id"] as const) {
    if (kind === "invalid") writeFileSync(f.activityFile, "{partial");
    if (kind === "wrong-id") f.activity("waiting", "unrelated-launch");
    const result = inspectNamedSubagent(f.dir, "worker", f.running, 200);
    assert.equal(result.state, "unknown");
    assert.equal(result.stale, true);
    assert.match(result.reason, new RegExp(kind));
  }
});

it("session identity must validate even when persisted evidence claims terminal state", t => {
  const f = fixture(t);
  f.save({ ...f.entry, execution: { ...f.execution, stop: { requestedAt: 170, confirmedAt: 190 } } });
  writeFileSync(f.sessionFile, JSON.stringify({ type: "session", id: "another-session" }) + "\n");
  let result = inspectNamedSubagent(f.dir, "worker", f.running, 200);
  assert.equal(result.state, "unknown");
  assert.match(result.reason, /does not match/);
  rmSync(f.sessionFile);
  result = inspectNamedSubagent(f.dir, "worker", undefined, 200);
  assert.equal(result.state, "unknown");
  assert.match(result.reason, /missing, unreadable or invalid/);
  writeFileSync(f.sessionFile, JSON.stringify({ type: "session", id: "session-id" }) + "\n");
  f.save({ ...f.entry, sessionId: null });
  assert.match(inspectNamedSubagent(f.dir, "worker", f.running, 200).reason, /no recorded session identity/);
});

it("a stale in-memory identity cannot borrow the registry's state or completion", t => {
  const f = fixture(t);
  f.activity();
  f.save({ ...f.entry, execution: { ...f.execution, finishedAt: 180 } });
  for (const running of [
    { ...f.running, id: "old-launch" },
    { ...f.running, sessionFile: join(f.dir, "different.jsonl") },
    { ...f.running, cli: "codex" as const },
  ]) {
    const result = inspectNamedSubagent(f.dir, "worker", running, 200);
    assert.equal(result.state, "unknown");
    assert.equal(result.stale, true);
    assert.match(result.reason, /does not match the saved execution identity/);
  }
});

it("legacy, absent and malformed registry entries report unknown without creating evidence", t => {
  const f = fixture(t);
  f.save({ sessionFile: f.sessionFile, sessionId: "session-id" });
  assert.equal(inspectNamedSubagent(f.dir, "worker", undefined, 200).state, "unknown");
  const before = filesSnapshot(f.dir);
  const missing = inspectNamedSubagent(f.dir, "absent", undefined, 200);
  assert.equal(missing.id, null);
  assert.equal(missing.sessionFile, null);
  assert.equal(missing.state, "unknown");
  assert.deepEqual(filesSnapshot(f.dir), before);
  f.save({ ...f.entry, execution: { ...f.execution, startedAt: "yesterday" } });
  assert.match(inspectNamedSubagent(f.dir, "worker", undefined, 200).reason, /malformed/);
});

it("native launches expose backend identity while semantic state remains unknown", t => {
  const f = fixture(t);
  for (const cli of ["codex", "claude"] as const) {
    f.save({ ...f.entry, execution: { id: f.execution.id, backend: cli, startedAt: 100 } });
    const result = inspectNamedSubagent(f.dir, "worker", { ...f.running, cli, activityFile: undefined }, 200);
    assert.equal(result.backend, cli);
    assert.equal(result.state, "unknown");
    assert.match(result.reason, /native CLI/);
    assert.match(result.reason, /liveness was not independently checked/);
    f.activity();
    f.save({ ...f.entry, execution: { ...f.execution, backend: cli } });
    assert.equal(inspectNamedSubagent(f.dir, "worker", { ...f.running, cli }, 200).state, "unknown",
      "a misplaced Pi activity snapshot cannot establish native CLI state");
  }
});
