export const meta = {
  name: 'migrate-files',
  description: '逐文件：一个 agent 出迁移计划，另一个按计划执行，第三个验证；按计划的 risky 标记选择验证强度',
  whenToUse: '当迁移可以按文件拆分，并且每个文件都要独立经历 plan → apply → verify 时',
  phases: ['Plan', 'Apply', 'Verify'],
}

// 计划与验证结论都用 schema：脚本要按 risky / ok 分支，只能消费结构化结果
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    steps: { type: 'array', items: { type: 'string' }, description: '按顺序执行的具体步骤，每步一句话' },
    risky: { type: 'boolean', description: '会改变对外行为、跨文件契约或难以回滚时为 true' },
  },
  required: ['steps', 'risky'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '计划的步骤全部落实且没有引入问题才为 true' },
    issues: { type: 'array', items: { type: 'string' }, description: '未落实或新引入的问题；ok 为 true 时可以为空数组' },
  },
  required: ['ok', 'issues'],
}

const task = typeof args.task === 'string' && args.task.trim() ? args.task : ''
const files = Array.isArray(args.files)
  ? args.files.filter((file) => typeof file === 'string' && file.trim())
  : []

if (!task || files.length === 0) {
  await log('缺少参数：需要 args.task（做什么迁移）和 args.files（文件路径列表）')
  return { skipped: true, reason: 'args.task 与 args.files 都是必填' }
}

// 三个角色用不同 agent（各自独立会话）：执行者看不到规划者的推理，只能照计划做
const planAgent = typeof args.planAgent === 'string' ? args.planAgent : 'scout'
const applyAgent = typeof args.applyAgent === 'string' ? args.applyAgent : 'worker'
const fullVerifierAgent = typeof args.verifierAgent === 'string' ? args.verifierAgent : 'worker'
const quickVerifierAgent = typeof args.quickVerifierAgent === 'string' ? args.quickVerifierAgent : 'scout'

const baseName = (path) => {
  const parts = String(path).split(/[\\/]/)
  return parts[parts.length - 1] || String(path)
}

await phase('Plan')
await log('迁移 ' + files.length + ' 个文件：' + task)

// pipeline 无屏障：文件 A 的 apply/verify 不必等文件 B 的 plan 做完
const results = await pipeline(
  files,
  async (file) => {
    const plan = await agent(
      [
        '为一个文件的迁移写执行计划。你没有父会话上下文，以下是全部信息。',
        '',
        '迁移任务：' + task,
        '目标文件：' + file,
        '当前工作目录就是仓库根。先读文件和相关调用方，再给出按顺序可执行的步骤（每步指明位置和改法）。',
        'risky=true 表示这次改动会改变对外行为、跨文件契约或难以回滚。不要修改任何文件。',
      ].join('\n'),
      { label: 'plan:' + baseName(file), phase: 'Plan', agent: planAgent, schema: PLAN_SCHEMA },
    )
    const steps = plan && Array.isArray(plan.steps) ? plan.steps.filter((step) => typeof step === 'string' && step.trim()) : []
    // 空计划按该文件失败处理：pipeline 会把这一项置为 null，不拿空计划去改文件
    if (steps.length === 0) throw new Error('计划为空：' + file)
    const risky = plan.risky === true
    return {
      file: file,
      risky: risky,
      stepsText: steps.map((step, index) => (index + 1) + '. ' + step).join('\n'),
    }
  },
  async (planned, file) => {
    await agent(
      [
        '按给定的迁移计划修改文件。你没有父会话上下文，以下是全部信息。',
        '',
        '迁移任务：' + task,
        '目标文件：' + file,
        '计划：',
        planned.stepsText,
        '',
        '严格按计划执行；只做与该文件相关的改动，计划要求改到别的文件时先不做，并在报告里说明。',
        '完成后用几句话报告：实际改动、执行过的检查、遗留问题。',
      ].join('\n'),
      { label: 'apply:' + baseName(file), phase: 'Apply', agent: applyAgent },
    )
    return { file: file, risky: planned.risky, stepsText: planned.stepsText }
  },
  async (applied, file) => {
    // 分支：验证强度由计划的 risky 决定——非 risky 用只读轻量核验，risky 升级到能跑测试的完整核验
    let verifier = quickVerifierAgent
    let prompt = [
      '核验一次文件迁移是否落实到位。你没有执行者的上下文，以下是全部信息。',
      '',
      '迁移任务：' + task,
      '目标文件：' + file,
      '计划：',
      applied.stepsText,
      '',
      '读该文件，逐步核对计划里的每一步是否都已落实，有没有漏改或明显改错的地方。',
      '只读检查，不要修改任何文件；不确定的地方写进 issues，不要猜。',
    ].join('\n')
    if (applied.risky) {
      verifier = fullVerifierAgent
      prompt = [
        '深入核验一次文件迁移（计划标记为 risky）。你没有执行者的上下文，以下是全部信息。',
        '',
        '迁移任务：' + task,
        '目标文件：' + file,
        '计划：',
        applied.stepsText,
        '',
        '逐步核对计划是否落实，再检查调用方、对外行为与错误路径有没有回归；有相关测试或构建的话，运行它们作为证据。',
        '不确定或缺少证据的地方写进 issues；ok=true 只允许用于已确认没有问题的文件。',
      ].join('\n')
    }
    await log('验证 ' + file + '：risky=' + (applied.risky ? 'true' : 'false') + ' → ' + verifier)
    const verdict = await agent(
      prompt,
      { label: 'verify:' + baseName(file), phase: 'Verify', agent: verifier, schema: VERIFY_SCHEMA },
    ).catch(() => null)
    if (!verdict) {
      return { file: file, risky: applied.risky, verifier: verifier, ok: false, issues: ['验证没有完成（agent 失败或没有结构化结果）'] }
    }
    return {
      file: file,
      risky: applied.risky,
      verifier: verifier,
      ok: verdict.ok === true,
      issues: Array.isArray(verdict.issues) ? verdict.issues : [],
    }
  },
)

const report = { task: task, verified: [], needsAttention: [], unfinished: [] }
for (let index = 0; index < results.length; index++) {
  const entry = results[index]
  if (!entry) {
    report.unfinished.push(files[index])
    continue
  }
  const summary = { file: entry.file, risky: entry.risky, verifier: entry.verifier, issues: entry.issues }
  if (entry.ok) report.verified.push(summary)
  else report.needsAttention.push(summary)
}
await log('完成：' + report.verified.length + ' 通过，' + report.needsAttention.length + ' 待处理，' + report.unfinished.length + ' 未完成')
return report
