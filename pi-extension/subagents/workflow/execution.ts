/** Execution mode, not a second agent identity. Persisted in the child loadout. */
export const WORKFLOW_EXECUTION_CONTRACT = `## Workflow execution contract
These rules override conflicting role conventions above for this invocation.
You are executing one step of a script, not managing the overall task.
- You may delegate to the ordinary agents allowed by your definition. Include sufficient task context, wait for their results, and do not start a nested workflow.
- If blocked or missing a decision, call ask_question to ask your parent orchestrator. Stop and wait for its reply; then continue the same step. Do not guess the answer.
- If information or tools are missing, return an explicit uncertainty or failure; do not invent success.
- Your final answer is the step's return value, not a report about your work. Return the requested result directly, without greetings, preamble, offers or a Changes/Verification/Notes report.
- When structured_output is available, call it exactly once with the complete final result as your last action; do not restate it in prose.
- Stop when this step is finished. The runtime handles orchestration and termination.`;

const DEFAULT_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
const SPAWNING_TOOLS = ['subagent', 'subagent_message', 'subagents_list'];
const BLOCKED_TOOLS = new Set(['workflow', ...SPAWNING_TOOLS]);

export function workflowExecution(definition: {
  tools?: string; body?: string; systemPromptMode?: 'append' | 'replace'; subagentAgents?: string[];
} | null) {
  const requested = definition?.tools?.trim()
    ? definition.tools.split(',').map(tool => tool.trim()).filter(Boolean)
    : DEFAULT_TOOLS;
  // Never pass tool globs through: a wildcard would re-enable denied tools.
  const tools = [...new Set(requested.filter(tool => !BLOCKED_TOOLS.has(tool) && !/[*?\[\]]/.test(tool)))];
  const spawnable = definition?.subagentAgents?.length ? [...definition.subagentAgents] : null;
  tools.push('ask_question');
  if (spawnable) tools.push(...SPAWNING_TOOLS);
  return {
    toolAllowlist: [...new Set(tools)].join(','),
    identity: [definition?.body, WORKFLOW_EXECUTION_CONTRACT].filter(Boolean).join('\n\n'),
    systemPromptMode: definition?.systemPromptMode ?? 'append',
    spawnable,
    sessionMode: 'lineage-only' as const,
    interactive: false,
    autoExit: true,
  };
}
