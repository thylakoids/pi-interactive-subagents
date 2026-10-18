export const meta = {
  name: 'verify-claims',
  description: 'Check each claim with three independent adversarial votes and preserve disagreement',
  whenToUse: 'When claims need independent checking and unsupported majority agreement would be risky',
  phases: ['Verify'],
  agent: 'worker',
}

const context = typeof args.context === 'string' ? args.context.trim() : ''
const requested = Array.isArray(args.claims)
  ? args.claims.filter((claim) => typeof claim === 'string' && claim.trim())
  : []
const maxCalls = Number.isInteger(args.maxCalls) ? Math.max(3, Math.min(60, args.maxCalls)) : 10
const verifierAgent = typeof args.verifierAgent === 'string' ? args.verifierAgent : undefined
const VOTES = 3

if (requested.length === 0) {
  return { error: 'args.claims must contain at least one claim' }
}

const claims = [...new Set(requested.map((claim) => claim.trim()))]
const admitted = claims.slice(0, Math.floor(maxCalls / VOTES))
const omitted = claims.slice(admitted.length)

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'evidence'],
  properties: {
    verdict: { type: 'string', enum: ['supported', 'refuted', 'uncertain'] },
    evidence: { type: 'string', description: 'Independent evidence and how it was checked' },
    counterexample: { type: 'string', description: 'A concrete refutation when one exists' },
  },
}

await phase('Verify')
const results = await parallel(admitted.map((claim, claimIndex) => async () => {
  const prompt = [
    'Adversarially verify one claim. Work independently; you do not have the parent conversation.',
    '',
    'Claim: ' + claim,
    context ? 'Context and allowed sources: ' + context : '',
    '',
    'Try to refute the claim with concrete evidence. Agreement with another agent is not evidence.',
    'Use supported only when the evidence establishes the claim, refuted when evidence contradicts it,',
    'and uncertain when the available sources cannot decide. Include source pointers in evidence.',
  ].filter(Boolean).join('\n')
  const votes = await parallel(Array.from({ length: VOTES }, (_, voteIndex) => async () =>
    agent(prompt, {
      label: 'verify:' + (claimIndex + 1) + ':' + (voteIndex + 1),
      phase: 'Verify',
      agent: verifierAgent,
      schema: VERDICT_SCHEMA,
    })
  ))
  const usable = votes.filter(Boolean)
  const counts = { supported: 0, refuted: 0, uncertain: 0 }
  for (const vote of usable) {
    if (counts[vote.verdict] !== undefined) counts[vote.verdict]++
  }
  let status = 'unverified'
  if (usable.length < VOTES) status = 'incomplete'
  else if (counts.supported === VOTES) status = 'supported'
  else if (counts.refuted === VOTES) status = 'refuted'
  else if (counts.uncertain === VOTES) status = 'unverified'
  else status = 'disputed'
  return { claim, status, counts, usableVotes: usable.length, votes }
}))

return {
  results,
  omitted,
  complete: omitted.length === 0 && results.every((result) => result && result.usableVotes === VOTES),
}
