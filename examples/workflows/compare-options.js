export const meta = {
  name: 'compare-options',
  description: 'Inspect independent options in parallel, then compare them in one synthesis step',
  whenToUse: 'When several alternatives can be investigated independently and the final answer needs all of them',
  phases: ['Inspect', 'Compare'],
  agent: 'worker',
}

const question = typeof args.question === 'string' ? args.question.trim() : ''
const requested = Array.isArray(args.options)
  ? args.options.filter((option) => typeof option === 'string' && option.trim())
  : []
const maxCalls = Number.isInteger(args.maxCalls) ? Math.max(2, Math.min(50, args.maxCalls)) : 10
const inspectAgent = typeof args.inspectAgent === 'string' ? args.inspectAgent : undefined
const synthesisAgent = typeof args.synthesisAgent === 'string' ? args.synthesisAgent : undefined

if (!question || requested.length === 0) {
  return { error: 'args.question and at least one args.options entry are required' }
}

const options = [...new Set(requested.map((option) => option.trim()))]
const admitted = options.slice(0, maxCalls - 1)
const omitted = options.slice(admitted.length)

const FINDING_SCHEMA = {
  type: 'object',
  required: ['option', 'summary', 'strengths', 'weaknesses', 'evidenceGaps'],
  properties: {
    option: { type: 'string' },
    summary: { type: 'string', description: 'Direct answer for this option' },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'string' } },
    evidenceGaps: { type: 'array', items: { type: 'string' } },
  },
}

await phase('Inspect')
const findings = await parallel(admitted.map((option, index) => async () => {
  const result = await agent([
    'Investigate one option for a comparison. Work independently; you do not have the parent conversation.',
    '',
    'Question: ' + question,
    'Option: ' + option,
    '',
    'Use only evidence you can inspect. Distinguish verified facts from inferences.',
    'Do not investigate the other options and do not return a final ranking.',
    'Return the requested structured result, including evidence gaps.',
  ].join('\n'), {
    label: 'inspect:' + (index + 1),
    phase: 'Inspect',
    agent: inspectAgent,
    schema: FINDING_SCHEMA,
  })
  return { option, result }
}))

const usable = findings.filter((entry) => entry && entry.result)
const failed = findings.map((entry, index) => entry?.result ? null : admitted[index]).filter(Boolean)

let comparison = null
if (usable.length > 0) {
  await phase('Compare')
  comparison = await agent([
    'Write a decision-oriented comparison. You do not have the parent conversation; the evidence below is complete.',
    '',
    'Question: ' + question,
    'Options requested: ' + JSON.stringify(admitted),
    'Omitted because of maxCalls: ' + JSON.stringify(omitted),
    'Failed investigations: ' + JSON.stringify(failed),
    '',
    'Verified investigation results:',
    JSON.stringify(usable, null, 2),
    '',
    'Synthesize only the usable evidence. Do not invent findings for failed or omitted options.',
    'State a recommendation when the evidence supports one, explain tradeoffs, and list remaining evidence gaps.',
  ].join('\n'), {
    label: 'compare',
    phase: 'Compare',
    agent: synthesisAgent,
  })
}

return {
  question,
  admitted,
  omitted,
  failed,
  findings: usable,
  comparison,
  complete: omitted.length === 0 && failed.length === 0 && comparison !== null,
}
