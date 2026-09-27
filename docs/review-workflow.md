# pi 并行 review

入口是 `review`。它并行调度 correctness 和合并了 simplicity 的 code-quality 两个 reviewer，收齐结果后去重，有候选问题时交给独立 verifier，再给出一份报告。默认只审查，不改代码，也不运行测试、构建、lint、typecheck、benchmark 或可执行复现。可以读取现有测试代码和已有结果；缺少运行证据时报告未定论。

## 使用

```text
/subagent review 审查当前未提交改动
/subagent review 审查当前分支相对 main 的改动
/subagent review 审查 src/example.ts，需求是……
```

也可以直接告诉 pi：“用 review subagent 审查当前改动，需求是……”。独立子会话没有父会话历史，所以父 agent 应把需求和约束一起放进 task。

未指定范围时审查相对 HEAD 的 staged/unstaged 改动和未跟踪的源码/配置；不会猜分支 base。范围有实质歧义时，主审通过 `ask_question` 问父会话。分支审查使用指定 base 的 merge-base。

## 配置与同步

定义统一位于本仓库 `agents/` 下，随扩展作为 package-bundled agents 自动发现，不需要全局软链接或额外安装脚本。四个 `.md` 文件各自带完整提示词。

开发 checkout 的更新约定见本仓库 [AGENTS.md](../AGENTS.md)。安装相同包名不代表源码相同；更新前检查实际 HEAD、工作区和提交历史。Git 包更新可能重置并清理 checkout，开发中的本地提交及未提交改动应先保留，再通过 Git 同步。

安装此包后，核对实际 HEAD 和 agent 文件：

```sh
pi install git:github.com/thylakoids/pi-interactive-subagents
```

发现优先级为项目 `.pi/agents/` > 全局 `~/.pi/agent/agents/` > 本仓库 bundled agents；同名覆盖会优先于这里的定义。使用 bundled agents 时，检查是否有旧的全局或项目定义覆盖它们。

四个 agent 使用模型 `opencode-go/deepseek-v4.1-flash` 和 `thinking: medium`；使用 `lineage-only`、`system-prompt: append`、`auto-exit: true`。主审拥有三个具名 spawn target，叶子 agent 没有 spawn 权限。运行需要现有 `pi-interactive-subagents` 扩展和 tmux。

工具是 `read, bash`，提示词明确禁止修改 checkout、index、HEAD、branch 和应用状态。**这属于提示词约束，并不是操作系统级只读沙箱**。主审只允许在 `/tmp` 写临时 diff。

## 来源与适配

参考源码固定在以下 revision，避免上游后续修改导致来源漂移：

| 来源 | 采用的机制 |
|---|---|
| [Integralist/pi-subagents README](https://github.com/Integralist/pi-subagents/blob/6a3885845a50d069068a00d0e74bf29222939099/README.md) | 同一 diff、独立维度并行、verifier 反驳候选问题 |
| [Anthropic code-review](https://github.com/anthropics/claude-code/blob/7779afb12e3635f46f56ec823979d68350ae000b/plugins/code-review/commands/code-review.md) | 发现后验证、排除旧问题和误报、去重 |
| [Anthropic code-simplifier](https://github.com/anthropics/claude-code/blob/7779afb12e3635f46f56ec823979d68350ae000b/plugins/pr-review-toolkit/agents/code-simplifier.md) | 保持行为、优先清晰表达、删冗余抽象和重复代码式注释 |
| [CE correctness reviewer](https://github.com/EveryInc/compound-engineering-plugin/blob/a763b392c3c05faa1a383c0d228b7e95200ecc90/skills/ce-code-review/references/personas/correctness-reviewer.md) | 具体输入路径、状态/顺序/错误传播、只检查真实可达的 null 路径 |
| [CE maintainability reviewer](https://github.com/EveryInc/compound-engineering-plugin/blob/a763b392c3c05faa1a383c0d228b7e95200ecc90/skills/ce-code-review/references/personas/maintainability-reviewer.md) | 删除复杂度、薄包装、边界泄漏、要求具体维护成本 |
| [CE validator template](https://github.com/EveryInc/compound-engineering-plugin/blob/a763b392c3c05faa1a383c0d228b7e95200ecc90/skills/ce-code-review/references/validator-batch-template.md) | confirmed/rejected/unresolved、逐条独立验证、不能以无反证作为确认 |

这些 pi agent 定义参考上述实现，工作流采用以下设计：

- `review` 调度两个 reviewer（correctness；code-quality + simplicity）；有候选 findings 才启动一个批量 verifier。
- 叶子结果通过最终消息返回，主审依赖扩展的异步完成通知；不轮询，不在子任务运行中提前汇总。
- 审查重点为正确性、可读性、可维护性及 simplicity，识别无必要的防御编程和注释。
- 合并后的 code-quality 同时关注表达、维护成本及结构是否必要。删除校验必须说明内部契约依据，保持真实边界校验。
- 使用 P1/P2/P3 分级。不设置数值置信度门槛、固定行数阈值或语言专属风格；不自动改代码、发布 PR 评论或启动修复循环。
- 使用精简 JSON findings 与 verifier verdicts；保留来源 ID、证据、影响和最小建议，主审去重后验证，失败/未确认项明确报告。

项目已有规则和每次任务中明确给出的要求仍适用。修改工作流规则或模型配置时，应先确认预期行为。

## 验证范围

review 是静态审查，不运行测试。端到端验证需要真实 pi 的调度、子会话、异步回传和真实 native CLI；替身 CLI 的集成测试不代表真实 codex/claude 合约已经验证。

## 旧 agent 名称迁移

`clean-code-reviewer` 和独立 `simplicity-reviewer` 已由 `code-quality-reviewer` 取代。完整审查入口是 `review`；使用旧名称的项目或全局自定义定义需要自行更新。
