/** Execution mode, not a second agent identity. Persisted in the child loadout. */
export const WORKFLOW_EXECUTION_CONTRACT = `## Workflow execution contract
These rules override conflicting role conventions above for this invocation.
You are executing one step of a script, not managing the overall task.
- Work alone. Do not delegate, spawn agents, or start another workflow.
- Work autonomously. Do not ask the user or parent questions or wait for a reply.
- If information or tools are missing, return an explicit uncertainty or failure; do not invent success.
- Your final answer is the step's return value, not a report about your work. Return the requested result directly, without greetings, preamble, offers or a Changes/Verification/Notes report.
- When structured_output is available, call it exactly once with the complete final result as your last action; do not restate it in prose.
- Stop when this step is finished. The runtime handles orchestration and termination.`;

const DEFAULT_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
const BLOCKED_TOOLS = new Set(['subagent', 'subagent_message', 'subagents_list', 'workflow', 'ask_question']);

export function workflowExecution(definition: {
  tools?: string; body?: string; systemPromptMode?: 'append' | 'replace';
} | null) {
  const requested = definition?.tools?.trim()
    ? definition.tools.split(',').map(tool => tool.trim()).filter(Boolean)
    : DEFAULT_TOOLS;
  // Never pass tool globs through: a wildcard would re-enable denied tools.
  const tools = [...new Set(requested.filter(tool => !BLOCKED_TOOLS.has(tool) && !/[*?\[\]]/.test(tool)))];
  if (!tools.length) throw new Error('Workflow agent definition has no permitted step tools; specify concrete non-orchestration tools.');
  return {
    toolAllowlist: tools.join(','),
    identity: [definition?.body, WORKFLOW_EXECUTION_CONTRACT].filter(Boolean).join('\n\n'),
    systemPromptMode: definition?.systemPromptMode ?? 'append',
    spawnable: null,
    sessionMode: 'lineage-only' as const,
    interactive: false,
    autoExit: true,
  };
}
