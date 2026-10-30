/** Execution mode, not a second agent identity. Persisted in the child loadout. */
import { READONLY_BUILTIN_TOOLS, VERIFY_COMMAND_TOOL } from "./readonly.ts";

export const WORKFLOW_EXECUTION_CONTRACT = `## Workflow execution contract
These rules override conflicting role conventions above for this invocation.
You are executing one step of a script, not managing the overall task.
- You may delegate to the ordinary agents allowed by your definition. Include sufficient task context, wait for their results, and do not start a nested workflow.
- If blocked or missing a decision, call ask_question to ask your parent orchestrator. Stop and wait for its reply; then continue the same step. Do not guess the answer.
- If information or tools are missing, return an explicit uncertainty or failure; do not invent success.
- Your final answer is the step's return value, not a report about your work. Return the requested result directly, without greetings, preamble, offers or a Changes/Verification/Notes report.
- When structured_output is available, call it exactly once with the complete final result as your last action; do not restate it in prose.
- Stop when this step is finished. The runtime handles orchestration and termination.`;

export const CLI_WORKFLOW_EXECUTION_CONTRACT = `## Native CLI workflow execution contract
These rules override conflicting role conventions above for this invocation.
You are executing one step, not managing the workflow.
- Use your native tools to complete only the assigned task. Do not delegate or start workflows: native children are not integrated with the parent's delegation protocol.
- Pi's ask_question, structured_output and verify_command tools are not available. Do not call or emulate them, and do not wait for terminal input. If blocked, return the missing information or an explicit failure as your final answer.
- Return the requested result directly as your final text, without greetings or a Changes/Verification/Notes report. Never invent success.
- End your turn when done. The parent can send messages or reopen this native conversation, but workflow Resume retries an unfinished step in a new conversation.
- Tool permissions and models come from the native CLI, not Pi. This is not a read-only sandbox; token budgets and Pi tool allowlists are not supported.`;

/**
 * Appended for read-only steps. It states enforcement, not a request: the tool
 * allowlist contains no writer and no spawning tool, so the only way to run
 * something is verify_command under the read-only shell sandbox.
 */
export const READONLY_EXECUTION_CONTRACT = `## Read-only execution contract
These rules override the delegation rules above for this invocation.
- This step is read-only. You cannot modify, create or delete anything in the workspace: write, edit and plain bash are not available to you.
- Delegation is disabled: you have no subagent tools and no nested workflow, because any child could write.
- To run something (tests, type check, build), use verify_command. It runs locally under a read-only sandbox: reads are unrestricted (the whole filesystem, not only this workspace), but it can only write inside its own private scratch directory, and the network and tmux/IPC are blocked. A command that tries otherwise fails - report that as an evidence gap instead of working around it.
- Report what you read and what you ran. Never claim you changed a file.`;

const DEFAULT_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
export const READONLY_TOOLS = [...READONLY_BUILTIN_TOOLS, 'ask_question', VERIFY_COMMAND_TOOL];
const SPAWNING_TOOLS = ['subagent', 'subagent_message', 'subagents_list'];
const BLOCKED_TOOLS = new Set(['workflow', ...SPAWNING_TOOLS]);

export type WorkflowExecutionOptions = {
  /**
   * Drop every writer from the step: keep the read-only built-ins plus
   * ask_question and verify_command, and never grant spawning tools. The
   * launcher additionally loads the verify_command extension and hands it a
   * scratch directory; without that the tool is inert and the step can only read.
   */
  readOnly?: boolean;
};

export function workflowExecution(
  definition: {
    tools?: string; body?: string; systemPromptMode?: 'append' | 'replace'; subagentAgents?: string[];
  } | null,
  options: WorkflowExecutionOptions = {},
) {
  const readOnly = options.readOnly === true;
  const requested = definition?.tools?.trim()
    ? definition.tools.split(',').map(tool => tool.trim()).filter(Boolean)
    : DEFAULT_TOOLS;
  // Never pass tool globs through: a wildcard would re-enable denied tools.
  const allowed = requested.filter(tool => !BLOCKED_TOOLS.has(tool) && !/[*?\[\]]/.test(tool));

  if (readOnly) {
    // A definition cannot widen this: only tools that cannot write survive, and
    // a step that may not write must not be able to start a step that may.
    const readable = allowed.filter(tool => (READONLY_BUILTIN_TOOLS as readonly string[]).includes(tool));
    const tools = [...new Set([...readable, 'ask_question', VERIFY_COMMAND_TOOL])];
    return {
      toolAllowlist: tools.join(','),
      identity: [definition?.body, WORKFLOW_EXECUTION_CONTRACT, READONLY_EXECUTION_CONTRACT]
        .filter(Boolean)
        .join('\n\n'),
      systemPromptMode: definition?.systemPromptMode ?? 'append',
      spawnable: null,
      sessionMode: 'lineage-only' as const,
      interactive: false,
      autoExit: true,
      readOnly: true,
    };
  }

  const tools = [...new Set(allowed)];
  const spawnable = definition?.subagentAgents?.length ? [...definition.subagentAgents] : null;
  tools.push('ask_question');
  if (spawnable) tools.push(...SPAWNING_TOOLS);
  return {
    toolAllowlist: definition?.tools?.trim() ? [...new Set(tools)].join(',') : null,
    identity: [definition?.body, WORKFLOW_EXECUTION_CONTRACT].filter(Boolean).join('\n\n'),
    systemPromptMode: definition?.systemPromptMode ?? 'append',
    spawnable,
    sessionMode: 'lineage-only' as const,
    interactive: false,
    autoExit: true,
    readOnly: false,
  };
}
