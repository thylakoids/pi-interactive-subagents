/** One-shot evidence snapshots. Reading a saved handle never starts a child. */
import { resolve } from "node:path";
import { readSubagentActivityFile, type SubagentActivityPhase } from "./activity.ts";
import { getSessionId, resolveNameInRegistry } from "./session.ts";

export type InspectedSubagentState = "running" | "starting" | "waiting" | "finished" | "stopped" | "stop_requested" | "unknown";

export interface SubagentInspection {
  name: string;
  id: string | null;
  backend: "pi" | "codex" | "claude" | null;
  sessionFile: string | null;
  sessionId: string | null;
  state: InspectedSubagentState;
  /** Time this snapshot was read, not a new observation of the child process. */
  observedAt: number;
  source: string;
  evidenceAt: number | null;
  stale: boolean;
  reason: string;
  historicalPhase?: SubagentActivityPhase;
}

export interface InspectableRunningSubagent {
  id: string;
  sessionFile: string;
  cli?: "codex" | "claude";
  activityFile?: string;
  startTime: number;
  stopRequested?: boolean;
}

/**
 * Reconcile the existing parent registry and launch-scoped activity evidence.
 * No pane query, transcript write, guardian creation, steering or resume occurs.
 */
export function inspectNamedSubagent(
  artifactDir: string,
  name: string,
  running?: InspectableRunningSubagent,
  now = Date.now(),
): SubagentInspection {
  const snapshot: SubagentInspection = {
    name: name.trim(), id: null, backend: null, sessionFile: null, sessionId: null,
    state: "unknown", observedAt: now, source: "name registry", evidenceAt: null,
    stale: true, reason: "No saved subagent with this exact name in the parent session registry.",
  };
  const entry = resolveNameInRegistry(artifactDir, snapshot.name);
  if (!entry) return snapshot;
  snapshot.sessionFile = entry.sessionFile;
  snapshot.sessionId = typeof entry.sessionId === "string" ? entry.sessionId : null;

  const execution = entry.execution;
  if (execution) {
    if (typeof execution.id !== "string" || !execution.id ||
        !["pi", "codex", "claude"].includes(execution.backend) || !Number.isFinite(execution.startedAt) ||
        (execution.activityFile !== undefined && typeof execution.activityFile !== "string") ||
        (execution.finishedAt !== undefined && !Number.isFinite(execution.finishedAt)) ||
        (execution.stop && (!Number.isFinite(execution.stop.requestedAt) ||
          (execution.stop.confirmedAt !== undefined && !Number.isFinite(execution.stop.confirmedAt))))) {
      snapshot.reason = "Saved execution evidence is malformed; its state cannot be trusted.";
      return snapshot;
    }
    snapshot.id = execution.id;
    snapshot.backend = execution.backend;
    snapshot.evidenceAt = execution.startedAt;
  }

  const headerId = getSessionId(entry.sessionFile);
  if (!headerId) {
    snapshot.reason = "The recorded session header is missing, unreadable or invalid; execution identity cannot be verified.";
    return snapshot;
  }
  if (!snapshot.sessionId || headerId !== snapshot.sessionId) {
    snapshot.reason = snapshot.sessionId
      ? "The session header does not match the registered session identity; saved execution evidence is stale."
      : "The registry has no recorded session identity to validate against the session header.";
    return snapshot;
  }

  if (running) {
    if (resolve(running.sessionFile) !== resolve(entry.sessionFile) ||
        (execution && (running.id !== execution.id || (running.cli ?? "pi") !== execution.backend))) {
      snapshot.reason = "The in-memory launch does not match the saved execution identity; current state is unknown.";
      return snapshot;
    }
    snapshot.id = running.id;
    snapshot.backend = running.cli ?? "pi";
    snapshot.evidenceAt ??= running.startTime;
  }

  if (execution?.stop) {
    snapshot.source = "name registry stop evidence";
    snapshot.evidenceAt = execution.stop.confirmedAt ?? execution.stop.requestedAt;
    snapshot.state = execution.stop.confirmedAt !== undefined ? "stopped" : "stop_requested";
    snapshot.stale = false;
    snapshot.reason = execution.stop.confirmedAt !== undefined
      ? "Owned-child termination was confirmed at the evidence time; the session remains available for deliberate resume."
      : "A stop was requested; termination has not been confirmed.";
    if (execution.stop.reason) snapshot.reason += ` ${execution.stop.reason}`;
    return snapshot;
  }
  if (running?.stopRequested) {
    snapshot.source = "in-memory owned launch";
    snapshot.evidenceAt = null;
    snapshot.state = "stop_requested";
    snapshot.stale = false;
    snapshot.reason = "The owned launch has a stop request; no persisted termination confirmation is available.";
    return snapshot;
  }
  if (execution?.finishedAt !== undefined) {
    snapshot.source = "name registry completion evidence";
    snapshot.evidenceAt = execution.finishedAt;
    snapshot.state = "finished";
    snapshot.stale = false;
    snapshot.reason = "The recorded launch finished at the evidence time; inspection did not resume it.";
    return snapshot;
  }

  if (snapshot.backend === "codex" || snapshot.backend === "claude") {
    snapshot.source = running ? "in-memory owned launch + name registry" : "name registry";
    snapshot.reason = "The native CLI launch identity is recorded, but its execution state is unknown: this backend has no supported Pi activity evidence and process liveness was not independently checked.";
    return snapshot;
  }

  const activityFile = running?.activityFile ?? execution?.activityFile;
  if (!snapshot.id || !activityFile) {
    snapshot.source = running ? "in-memory owned launch + name registry" : "name registry";
    snapshot.reason = "No launch-scoped activity evidence is recorded; execution state is unknown.";
    return snapshot;
  }
  const read = readSubagentActivityFile(activityFile, snapshot.id);
  snapshot.source = running ? "in-memory owned launch + activity file" : "persisted activity file + name registry";
  if (read.ok === false) {
    snapshot.reason = `Launch activity evidence is ${read.reason}${read.error ? `: ${read.error}` : "."} Execution state is unknown.`;
    return snapshot;
  }
  snapshot.evidenceAt = read.activity.updatedAt;
  if (!running) {
    snapshot.historicalPhase = read.activity.phase;
    snapshot.reason = "Persisted activity describes a historical launch; this parent has no in-memory ownership and current process liveness is unknown.";
    return snapshot;
  }
  snapshot.state = read.activity.phase === "active" ? "running"
    : read.activity.phase === "done" ? "finished" : read.activity.phase;
  snapshot.stale = false;
  snapshot.reason = "Reported activity belongs to the in-memory owned launch. Process liveness was not independently checked; evidenceAt is the child's last activity update.";
  return snapshot;
}
