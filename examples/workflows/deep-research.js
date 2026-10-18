export const meta = {
  name: 'deep-research',
  description: 'Scope a question, search and fetch sources, verify claims adversarially, then synthesize',
  whenToUse: 'When a research answer needs traceable sources, independent claim checks and an explicit evidence-gap report',
  phases: ['Scope', 'Search', 'Fetch', 'Verify', 'Synthesize'],
  agent: 'researcher',
}

const question = typeof args.question === 'string' ? args.question.trim() : ''
const context = typeof args.context === 'string' ? args.context.trim() : ''
const maxCalls = Number.isInteger(args.maxCalls) ? Math.max(8, Math.min(60, args.maxCalls)) : 10
const researchAgent = typeof args.researchAgent === 'string' ? args.researchAgent : 'researcher'
const VOTES = 3

if (!question) return { error: 'args.question is required' }

const SCOPE_SCHEMA = {
  type: 'object',
  required: ['queries', 'scopeNotes'],
  properties: {
    queries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['query', 'reason'],
        properties: { query: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    scopeNotes: { type: 'array', items: { type: 'string' } },
  },
}
const SOURCE_SCHEMA = {
  type: 'object',
  required: ['sources'],
  properties: {
    sources: {
      type: 'array',
      items: {
        type: 'object',
        required: ['url', 'title', 'relevance'],
        properties: { url: { type: 'string' }, title: { type: 'string' }, relevance: { type: 'string' } },
      },
    },
  },
}
const EVIDENCE_SCHEMA = {
  type: 'object',
  required: ['findings', 'claims', 'gaps'],
  properties: {
    findings: { type: 'array', items: { type: 'string' } },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'source', 'priority'],
        properties: {
          claim: { type: 'string' },
          source: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    gaps: { type: 'array', items: { type: 'string' } },
  },
}
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'evidence'],
  properties: {
    verdict: { type: 'string', enum: ['supported', 'refuted', 'uncertain'] },
    evidence: { type: 'string' },
  },
}

// Reserve final synthesis using actual calls, including failed branches.
let issuedCalls = 0
const callAgent = (prompt, options) => {
  issuedCalls++
  return agent(prompt, options)
}

await phase('Scope')
const scope = await callAgent([
  'Define the research plan for a question. You do not have the parent conversation.',
  '',
  'Question: ' + question,
  context ? 'Additional context and source constraints: ' + context : '',
  '',
  'Produce at most two high-value, non-overlapping search queries and brief scope notes.',
  'Do not answer the question yet and do not invent sources.',
].filter(Boolean).join('\n'), {
  label: 'scope',
  phase: 'Scope',
  agent: researchAgent,
  schema: SCOPE_SCHEMA,
})

const queryLimit = Math.max(0, Math.min(2, Math.floor((maxCalls - 5) / 2)))
const plannedQueries = scope && Array.isArray(scope.queries)
  ? scope.queries.filter((entry) => entry && typeof entry.query === 'string' && entry.query.trim())
  : []
// 被 queryLimit 截掉的计划查询和被 claimBudget 截掉的 claim 一样是证据缺口：
// 必须单独记下来、交给综合提示词，并在 status 里体现，不能在 sliced 之后就不见了
const queries = plannedQueries.slice(0, queryLimit)
const omittedQueries = plannedQueries.slice(queryLimit).map((entry) => entry.query)

if (queries.length === 0) {
  // maxCalls 的下限是 8，queryLimit 因此永不为 0：这里的空 queries 只可能是
  // scope 没给出可用查询（或 scope 失败），不是被预算切掉
  return {
    question,
    status: 'incomplete',
    reason: scope ? 'The scope step found no usable search queries.' : 'The scope step failed.',
    scope: scope || null,
    sources: [],
    evidence: [],
    verdicts: [],
    answer: null,
  }
}

await phase('Search')
const researched = await pipeline(queries, async (entry, _, index) => {
  const search = await callAgent([
    'Find candidate authoritative sources for one research query. Work independently.',
    '',
    'Overall question: ' + question,
    'Search query: ' + entry.query,
    'Why this query exists: ' + entry.reason,
    context ? 'Source constraints: ' + context : '',
    '',
    'Search the web and return up to four relevant sources with direct URLs.',
    'Do not summarize claims from a page you have not fetched.',
  ].filter(Boolean).join('\n'), {
    label: 'search:' + (index + 1),
    phase: 'Search',
    agent: researchAgent,
    schema: SOURCE_SCHEMA,
  })
  if (!search) return null
  return { query: entry, sources: Array.isArray(search.sources) ? search.sources.slice(0, 4) : [] }
}, async (found, entry, index) => {
  if (!found || found.sources.length === 0) return null
  const evidence = await callAgent([
    'Fetch and extract evidence for one research query. Work independently.',
    '',
    'Overall question: ' + question,
    'Search query: ' + entry.query,
    'Candidate sources:',
    JSON.stringify(found.sources, null, 2),
    context ? 'Source constraints: ' + context : '',
    '',
    'Fetch the candidate pages. Keep only sources you actually read and that support the question.',
    'Return concise findings, falsifiable claims with exact source pointers, and evidence gaps.',
    'Do not fill an inaccessible page from memory.',
  ].filter(Boolean).join('\n'), {
    label: 'fetch:' + (index + 1),
    phase: 'Fetch',
    agent: researchAgent,
    schema: EVIDENCE_SCHEMA,
  })
  return { query: entry, sources: found.sources, evidence }
})

const evidence = researched.filter((entry) => entry && entry.evidence)
// fetch 阶段明确报告的缺口（读不到的页面、缺失的证据）同样算没覆盖到：
// 只要有一条，答案就不能自称 complete
const evidenceGaps = evidence.flatMap((entry) =>
  entry.evidence && Array.isArray(entry.evidence.gaps) ? entry.evidence.gaps : []
)
const allClaims = evidence.flatMap((entry, evidenceIndex) =>
  (entry.evidence && Array.isArray(entry.evidence.claims) ? entry.evidence.claims : [])
    .map((claim, claimIndex) => ({ ...claim, evidenceIndex, claimIndex }))
)
const priority = { high: 0, medium: 1, low: 2 }
allClaims.sort((a, b) => priority[a.priority] - priority[b.priority])
const claimBudget = Math.max(0, Math.floor((maxCalls - 1 - issuedCalls) / VOTES))
const admittedClaims = allClaims.slice(0, claimBudget)
const omittedClaims = allClaims.slice(admittedClaims.length)

await phase('Verify')
const verdicts = await parallel(admittedClaims.map((claim, claimIndex) => async () => {
  const prompt = [
    'Adversarially verify one research claim. You do not have the parent conversation.',
    '',
    'Overall question: ' + question,
    'Claim: ' + claim.claim,
    'Source pointer supplied by the researcher: ' + claim.source,
    context ? 'Additional source constraints: ' + context : '',
    '',
    'Open the cited source and check whether it establishes the exact claim.',
    'Try to refute it. Use supported, refuted or uncertain, and cite the evidence you inspected.',
  ].filter(Boolean).join('\n')
  const votes = await parallel(Array.from({ length: VOTES }, (_, voteIndex) => async () =>
    callAgent(prompt, {
      label: 'verify:' + (claimIndex + 1) + ':' + (voteIndex + 1),
      phase: 'Verify',
      agent: researchAgent,
      schema: VERDICT_SCHEMA,
    })
  ))
  const usable = votes.filter(Boolean)
  const counts = { supported: 0, refuted: 0, uncertain: 0 }
  for (const vote of usable) if (counts[vote.verdict] !== undefined) counts[vote.verdict]++
  const status = usable.length < VOTES ? 'incomplete'
    : counts.supported === VOTES ? 'supported'
      : counts.refuted === VOTES ? 'refuted'
        : counts.uncertain === VOTES ? 'unverified'
          : 'disputed'
  return { claim, status, counts, votes }
}))

await phase('Synthesize')
const answer = evidence.length > 0 ? await callAgent([
  'Write a sourced research answer from the evidence below. You do not have the parent conversation.',
  '',
  'Question: ' + question,
  context ? 'Additional context: ' + context : '',
  'Scope notes: ' + JSON.stringify(scope ? scope.scopeNotes : []),
  'Failed or empty research branches: ' + (researched.length - evidence.length),
  'Evidence: ' + JSON.stringify(evidence, null, 2),
  'Claim checks: ' + JSON.stringify(verdicts, null, 2),
  'Claims omitted because of maxCalls: ' + JSON.stringify(omittedClaims),
  'Planned queries omitted because of maxCalls: ' + JSON.stringify(omittedQueries),
  '',
  'Answer directly. Separate supported findings, disputed or uncertain claims, and evidence gaps.',
  'State which planned query was not run; never present a refuted or unverified claim as established.',
  'Cite the source pointers present in the evidence.',
].filter(Boolean).join('\n'), {
  label: 'synthesize',
  phase: 'Synthesize',
  agent: researchAgent,
}) : null

return {
  question,
  status: answer && omittedClaims.length === 0 && omittedQueries.length === 0 && evidenceGaps.length === 0 && evidence.length === queries.length && verdicts.every((entry) => entry && (entry.status === 'supported' || entry.status === 'refuted')) ? 'complete' : 'incomplete',
  scope,
  queries: queries.map((query) => query.query),
  omittedQueries,
  // 交给 fetch 的候选来源，不代表已经被读到；真正读过的来源记在 evidence[].sources
  sources: evidence.flatMap((entry) => entry.sources),
  evidence,
  verdicts,
  omittedClaims,
  evidenceGaps,
  answer,
}
