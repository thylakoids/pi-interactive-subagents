export const meta = {
  name: 'review-changes',
  description: '按维度并行审查改动，每条发现再由独立 agent 对抗性验证，只保留确认的问题',
  whenToUse: '当一组改动需要多个独立审查维度，并且每条发现都应由新的 agent 尝试反驳时',
  phases: ['Review', 'Verify'],
}

// 脚本要程序化地过滤 findings/verdict，所以结果必须走 schema，不能靠解析自由文本
const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话的问题描述' },
          detail: { type: 'string', description: '具体触发路径：输入/状态/顺序，附文件与行号' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'], description: '影响程度' },
        },
        required: ['title', 'detail', 'severity'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    isReal: { type: 'boolean', description: '尝试反驳后问题仍然成立才为 true' },
    reason: { type: 'string', description: '为什么成立，或被什么反证推翻' },
  },
  required: ['isReal', 'reason'],
}

const target = typeof args.target === 'string' && args.target.trim()
  ? args.target
  : '当前工作区相对 HEAD 的未提交改动（先用 git status / git diff 确认范围）'

// args.dimensions 每项是字符串或 { name, focus, agent }；缺省三个维度。
// 维度本身不绑定 agent：审查者用 workflow 的默认子代理，维度要求写在提示词里。
// 需要某个具体定义（例如只读的 reviewer）时，在 args.dimensions 里写 agent。
const declared = Array.isArray(args.dimensions) && args.dimensions.length > 0
  ? args.dimensions
  : [
      { name: 'correctness', focus: '正确性：错误结果、异常路径、状态传播，以及真实可达的边界（null、空集、并发）' },
      { name: 'quality', focus: '可读性与可维护性：多余的抽象、误导的命名与注释、没有必要的防御代码' },
      { name: 'regression', focus: '回归：调用方与内部契约是否被破坏，新行为是否被已有测试覆盖' },
    ]

const dimensions = declared.map((entry, index) => {
  if (typeof entry === 'string') return { name: 'dimension-' + (index + 1), focus: entry, agent: undefined }
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name : 'dimension-' + (index + 1)
  return {
    name: name,
    focus: typeof entry.focus === 'string' && entry.focus.trim() ? entry.focus : name,
    agent: typeof entry.agent === 'string' ? entry.agent : undefined,
  }
})

const verifierAgent = typeof args.verifierAgent === 'string' ? args.verifierAgent : undefined

await phase('Review')
await log('审查范围：' + target + '；维度：' + dimensions.map((dimension) => dimension.name).join('、'))

// pipeline 无屏障：先审完的维度立刻进入验证，不必等最慢的维度（parallel 要收齐全部审计才能开始）
const reviewed = await pipeline(
  dimensions,
  async (dimension) => {
    const audit = await agent(
      [
        '独立审查任务。你没有父会话上下文，以下就是全部信息。',
        '',
        '审查范围：' + target,
        '审查维度——' + dimension.name + '：' + dimension.focus,
        '',
        '先确认改动范围，再按需要读周围代码、调用方和现有测试。',
        '只记录这批改动引入或加重的问题；每条发现都要给出具体触发路径，给不出就不要记录。',
        '只审查，不修改任何文件，也不运行测试、构建或 lint。',
      ].join('\n'),
      { label: 'audit:' + dimension.name, phase: 'Review', agent: dimension.agent, schema: AUDIT_SCHEMA },
    )
    const findings = audit && Array.isArray(audit.findings) ? audit.findings : []
    return { dimension: dimension.name, findings: findings }
  },
  async (audited, dimension) => {
    const findings = audited && Array.isArray(audited.findings) ? audited.findings : []
    if (findings.length === 0) return { dimension: dimension.name, confirmed: [], unverified: [], rejected: 0 }
    // 每条发现单独交给一个验证者：只拿到这一条，独立复核，并默认它是错的
    const verdicts = await parallel(
      findings.map((finding, index) => async () => {
        const verdict = await agent(
          [
            '对抗性验证一条代码审查发现。你没有审查者的上下文，下面是全部信息；请独立复核，不要预设它成立。',
            '',
            '审查范围：' + target,
            '候选问题（维度 ' + dimension.name + '）：' + finding.title,
            finding.detail,
            '',
            '先尝试反驳：按 detail 的路径去读代码，找它不成立的理由——路径不可达、上游已校验、行为原本如此、需要不存在的调用方式。',
            '找不到反证且路径确实成立，才判 isReal=true；不要因为“无法证明它是错的”就判 true。',
          ].join('\n'),
          { label: 'verify:' + dimension.name + ':' + (index + 1), phase: 'Verify', agent: verifierAgent, schema: VERDICT_SCHEMA },
        )
        return { finding: finding, verdict: verdict }
      }),
    )
    const confirmed = []
    const unverified = []
    let rejected = 0
    for (let index = 0; index < verdicts.length; index++) {
      const checked = verdicts[index]
      const finding = findings[index]
      if (!checked || !checked.verdict) {
        unverified.push(finding)
        continue
      }
      if (checked.verdict.isReal === true) {
        confirmed.push({
          dimension: dimension.name,
          title: finding.title,
          detail: finding.detail,
          severity: finding.severity,
          reason: checked.verdict.reason,
        })
      } else {
        rejected++
      }
    }
    await log(dimension.name + '：候选 ' + findings.length + '，确认 ' + confirmed.length + '，驳回 ' + rejected + '，未验证 ' + unverified.length)
    return { dimension: dimension.name, confirmed: confirmed, unverified: unverified, rejected: rejected }
  },
)

const report = { target: target, confirmed: [], unverified: [], rejected: 0, failedDimensions: [] }
for (let index = 0; index < reviewed.length; index++) {
  const entry = reviewed[index]
  if (!entry) {
    report.failedDimensions.push(dimensions[index].name)
    continue
  }
  report.rejected += entry.rejected
  for (const finding of entry.confirmed) report.confirmed.push(finding)
  for (const finding of entry.unverified) report.unverified.push(finding)
}

const severityRank = { high: 0, medium: 1, low: 2 }
report.confirmed.sort((left, right) => {
  const a = severityRank[left.severity] === undefined ? 3 : severityRank[left.severity]
  const b = severityRank[right.severity] === undefined ? 3 : severityRank[right.severity]
  return a - b
})

await log('完成：确认 ' + report.confirmed.length + ' 条，驳回 ' + report.rejected + ' 条，未验证 ' + report.unverified.length + ' 条')
return report
