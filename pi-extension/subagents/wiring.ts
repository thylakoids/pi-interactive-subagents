/**
 * Wires the workflow runtime into the interactive-subagent plugin.
 *
 * Everything workflow agents need already exists here — panes, names,
 * permission sandboxes, watchers, status classification and usage stats. This
 * module exposes that as a service object so the runtime in `./workflow` can
 * spawn and observe agents without a second execution path, and it registers
 * the `workflow` tool, the `/workflow` command, the shortcut and the panel.
 */
import { join as joinPath, dirname } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getSessionId, type NameRegistry, type NameRegistryEntry } from "./session.ts";
import { classifyStatus, formatStatusDetail } from "./status.ts";
import { cleanupVerifyScratch } from "./workflow/readonly.ts";
import { isMuxAvailable, muxSetupHint, closeSurfaceTree, reapSurfaceOwner } from "./tmux.ts";
import { surfaceOwnerDirectory } from "./surface-owner.ts";
import type { RunningSubagent, SubagentResult, SubagentMessageResult } from "./index.ts";
import type {
  WorkflowSubagentCompletion,
  WorkflowSubagentHandle,
  WorkflowSubagentRequest,
  WorkflowSubagentService,
  WorkflowUsage,
} from "./workflow/types.ts";

/** Directory of this extension, for resolving sibling extension files. */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

/** The structured-output tool the runtime loads into schema-driven agents. */
export const STRUCTURED_OUTPUT_TOOL = "structured_output";
export const STRUCTURED_OUTPUT_EXTENSION = joinPath(SUBAGENTS_DIR, "workflow", "structured-output.ts");

/**
 * Surface the workflow runtime uses. Deliberately the *same* functions the
 * `subagent` tool uses, so permissions, naming and watching cannot drift.
 */
export interface SubagentPluginSurface {
  launch(
    params: { agent: string; task: string; name: string; model?: string; cwd?: string },
    ctx: { sessionManager: { getSessionFile(): string | null | undefined; getSessionId(): string; getSessionDir(): string }; cwd: string },
    options?: {
      extraExtensions?: string[];
      extraEnv?: Record<string, string>;
      /** Reasoning effort, applied to whichever model this child resolves to. */
      thinking?: string;
      outputIsData?: boolean;
      nonInteractive?: boolean;
      workflow?: boolean;
      readOnly?: boolean;
      /**
       * Cancels the launch before the child starts: the launcher checks it
       * before creating a pane, during the shell-ready wait, and before sending
       * the command. It never stops a child that already started.
       */
      signal?: AbortSignal;
    },
  ): Promise<RunningSubagent>;
  watch(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
  steer(running: RunningSubagent, message: string): Promise<SubagentMessageResult>;
  resolveRunning(name: string): { running: RunningSubagent } | { error: string };
  runningSubagents: Map<string, RunningSubagent>;
  /** Shared with manual launches, including names whose panes are still opening. */
  reservedNames?: Set<string>;
  closeSurface?: (surface: string) => void | Promise<void>;
  registerName(artifactDir: string, name: string, value: NameRegistryEntry): void;
  readNameRegistry(artifactDir: string): NameRegistry;
  getArtifactDir(sessionDir: string, sessionId: string): string;
  updateWidget(): void;
  startWidgetRefresh(): void;
  discoverAgents(): string[];
  /** Agent names and whether each is known to the caller's allowlist. */
  isAgentAllowed(name: string): boolean;
  /** Whether a definition runs as a pi child or as an external coding CLI. */
  agentKind(name: string): "pi" | "cli" | undefined;
  sessionSnapshot(): { sessionFile: string; sessionId: string; sessionDir: string };
  /** The parent session's model and thinking level, for children that inherit. */
  sessionDefaults(): { model?: string; thinking?: string };
  agentDir(): string;
  cwd(): string;
  focus(name: string, sessionFile?: string): Promise<{ ok: true } | { error: string }>;
}

/**
 * Build the runtime-facing service from the plugin surface.
 *
 * The returned object is the ONLY way workflow code touches subagents: it
 * carries the same per-agent sandbox (tool allowlist, model, identity) the
 * `subagent` tool computes, so a workflow agent is indistinguishable from a
 * hand-started one in the pane, the registry and the status widget.
 */
export function createWorkflowSubagentService(surface: SubagentPluginSurface): WorkflowSubagentService {
  const reserved = surface.reservedNames ?? new Set<string>();
  const close = surface.closeSurface ?? closeSurfaceTree;
  const takenNames = () => {
    const names = new Set(reserved);
    for (const running of surface.runningSubagents.values()) names.add(running.name);
    const { sessionDir, sessionId } = surface.sessionSnapshot();
    for (const name of Object.keys(surface.readNameRegistry(surface.getArtifactDir(sessionDir, sessionId)))) names.add(name);
    return names;
  };

  return {
    ownership: { current: surfaceOwnerDirectory, reap: reapSurfaceOwner },
    isAvailable() {
      if (!isMuxAvailable()) return { ok: false, reason: muxSetupHint() };
      if (!surface.sessionSnapshot().sessionFile) {
        return { ok: false, reason: "no session file (start pi with a persistent session to run workflows)" };
      }
      return { ok: true };
    },

    allowedAgents() {
      const allowed = surface.discoverAgents();
      return {
        allowed,
        unknown: (name: string) => !surface.isAgentAllowed(name),
      };
    },

    takenNames,

    async spawn(request: WorkflowSubagentRequest): Promise<WorkflowSubagentHandle> {
      if (takenNames().has(request.name)) throw new Error('Subagent name is already in use: ' + request.name);
      // Claim before the first await. Other workflows and the manual tool must
      // see the same pending name, not just launches already in the registry.
      reserved.add(request.name);
      let ownedRunning: RunningSubagent | undefined;
      try {
        const snapshot = surface.sessionSnapshot();
        const extraEnv: Record<string, string> = {};
        if (request.schemaFile) extraEnv.PI_SUBAGENT_SCHEMA_FILE = request.schemaFile;
        if (request.resultFile) extraEnv.PI_SUBAGENT_RESULT_FILE = request.resultFile;

        const extraExtensions = [...(request.extraExtensions ?? [])];
        if (request.schemaFile && !extraExtensions.includes(STRUCTURED_OUTPUT_EXTENSION)) {
          extraExtensions.push(STRUCTURED_OUTPUT_EXTENSION);
        }

        const running = await surface.launch(
          {
            agent: request.agentType,
            task: request.task,
            name: request.name,
            ...(request.model ? { model: request.model } : {}),
            ...(request.cwd ? { cwd: request.cwd } : {}),
          },
          {
            sessionManager: {
              getSessionFile: () => snapshot.sessionFile,
              getSessionId: () => snapshot.sessionId,
              getSessionDir: () => snapshot.sessionDir,
            },
            cwd: surface.cwd(),
          },
          {
            extraExtensions,
            extraEnv,
            // Effort rides the internal channel: it applies to whichever model
            // the definition pins, so combining it with a model here would need
            // that model first.
            ...(request.effort ? { thinking: request.effort } : {}),
            // A workflow child is read by a program and watched by nobody: its
            // final message is data, and it must end on its own.
            workflow: true,
            ...(request.readOnly ? { readOnly: true } : {}),
            outputIsData: true,
            nonInteractive: true,
            ...(request.signal ? { signal: request.signal } : {}),
          },
        );

        ownedRunning = running;
        surface.registerName(surface.getArtifactDir(snapshot.sessionDir, snapshot.sessionId), running.name, {
          sessionFile: running.sessionFile,
          sessionId: getSessionId(running.sessionFile),
        });
        surface.startWidgetRefresh();

        const controller = new AbortController();
        running.abortController = controller;
        const completion = surface
          .watch(running, controller.signal)
          .then((result) => toCompletion(result));

        return {
          id: running.id,
          name: running.name,
          sessionFile: running.sessionFile,
          completion,
        };
      } catch (error) {
        if (ownedRunning) {
          ownedRunning.abortController?.abort();
          try { await close(ownedRunning.surface); } catch { /* only the failed launch's owned surface */ }
          cleanupVerifyScratch(ownedRunning.verifyScratchDir);
          if (surface.runningSubagents.get(ownedRunning.id) === ownedRunning) {
            surface.runningSubagents.delete(ownedRunning.id);
          }
        }
        throw error;
      } finally {
        reserved.delete(request.name);
      }
    },

    async steer(name: string, message: string) {
      const resolved = surface.resolveRunning(name);
      if ("error" in resolved) return { error: resolved.error };
      return surface.steer(resolved.running, message);
    },

    async stop(name: string) {
      // Closing the pane ends the child process; the watcher then observes the
      // exit on its own, so the run's outcome stays accurate instead of being
      // reported as an abort of the watcher.
      const resolved = surface.resolveRunning(name);
      if ("error" in resolved) return;
      try { writeFileSync(`${resolved.running.sessionFile}.workflow-aborted`, "aborted"); } catch {}
      try { unlinkSync(`${resolved.running.sessionFile}.ask`); } catch {}
      try {
        await close(resolved.running.surface);
      } catch {
        // Pane already gone.
      }
    },

    focus: (name, sessionFile) => surface.focus(name, sessionFile),

    status(name: string) {
      const resolved = surface.resolveRunning(name);
      if ("error" in resolved) return undefined;
      const running = resolved.running;
      const now = Date.now();
      const snapshot = classifyStatus(running.statusState, now);
      return { kind: snapshot.kind, detail: formatStatusDetail(snapshot) };
    },

    agentKind(name: string) {
      return surface.agentKind(name);
    },

    sessionDefaults() {
      return surface.sessionDefaults();
    },
  };
}

function toCompletion(result: SubagentResult): WorkflowSubagentCompletion {
  const stats = result.stats;
  const usage: WorkflowUsage | undefined = stats
    ? {
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cacheReadTokens: stats.cacheReadTokens,
        cacheWriteTokens: stats.cacheWriteTokens,
        totalTokens: stats.inputTokens + stats.outputTokens,
        cost: stats.cost,
        ...(stats.model ? { model: stats.model } : {}),
      }
    : undefined;
  return {
    exitCode: result.exitCode,
    summary: result.summary,
    sessionId: result.sessionId,
    elapsedMs: result.elapsed * 1000,
    error: result.errorMessage ?? result.error,
    usage,
  };
}
