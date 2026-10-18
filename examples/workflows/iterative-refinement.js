export const meta = {
  name: 'iterative-refinement',
  description: 'Critique and revise an artifact until accepted, bounded by rounds, calls and optional token budget',
  whenToUse: 'When an existing draft can be improved through structured critique and repeated revision',
  phases: ['Critique', 'Revise'],
  agent: 'worker',
}

const task = typeof args.task === 'string' ? args.task.trim() : ''
const initial = typeof args.initial === 'string' ? args.initial.trim() : ''
const maxCalls = Number.isInteger(args.maxCalls) ? Math.max(2, Math.min(30, args.maxCalls)) : 10
const maxRounds = Number.isInteger(args.maxRounds) ? Math.max(1, args.maxRounds) : 3
const minRemainingTokens = Number.isFinite(args.minRemainingTokens) ? Math.max(0, args.minRemainingTokens) : 0
const criticAgent = typeof args.criticAgent === 'string' ? args.criticAgent : undefined
const editorAgent = typeof args.editorAgent === 'string' ? args.editorAgent : undefined

if (!task || !initial) return { error: 'args.task and non-empty args.initial are required' }

const CRITIQUE_SCHEMA = {
  type: 'object',
  required: ['accepted', 'issues', 'feedback'],
  properties: {
    accepted: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    feedback: { type: 'string', description: 'Concrete revision instructions; empty when accepted' },
  },
}

let draft = initial
let rounds = 0
let reason = 'round limit reached'
let lastCritique = null
const roundLimit = Math.min(maxRounds, Math.floor(maxCalls / 2))

while (rounds < roundLimit) {
  if (budget.total !== null && budget.remaining() <= minRemainingTokens) {
    reason = 'token budget guard reached'
    break
  }

  await phase('Critique')
  const critique = await agent([
    'Critique a draft against its task. Work independently; you do not have the parent conversation.',
    '',
    'Task: ' + task,
    'Draft:',
    draft,
    '',
    'Check correctness, completeness and fidelity to the task. Accept only when no material issue remains.',
    'Return actionable issues and feedback. Do not rewrite the draft in this step.',
  ].join('\n'), {
    label: 'critique:' + (rounds + 1),
    phase: 'Critique',
    agent: criticAgent,
    schema: CRITIQUE_SCHEMA,
  })

  if (!critique) {
    reason = 'critic failed'
    break
  }
  lastCritique = critique
  rounds++
  if (critique.accepted) {
    reason = 'accepted'
    break
  }
  if (rounds * 2 >= maxCalls) {
    reason = 'call limit reached'
    break
  }
  if (budget.total !== null && budget.remaining() <= minRemainingTokens) {
    reason = 'token budget guard reached'
    break
  }

  await phase('Revise')
  const revised = await agent([
    'Revise a draft using an independent critique. You do not have the parent conversation.',
    '',
    'Task: ' + task,
    'Current draft:',
    draft,
    '',
    'Critique:',
    JSON.stringify(critique, null, 2),
    '',
    'Return the complete revised artifact, not a diff, explanation or preamble.',
    'Fix the listed issues without discarding correct material.',
  ].join('\n'), {
    label: 'revise:' + rounds,
    phase: 'Revise',
    agent: editorAgent,
  })
  if (!revised) {
    reason = 'editor failed'
    break
  }
  draft = revised
}

return {
  task,
  draft,
  rounds,
  reason,
  accepted: reason === 'accepted',
  lastCritique,
}
