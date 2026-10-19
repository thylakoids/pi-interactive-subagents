# pi workflow：用脚本编排交互式子代理

Workflow 是一段 JavaScript 脚本，用确定的控制流（并发、分阶段、传递结果）编排多个子代理；脚本里每一次 `agent()` 都会启动一个真实的交互式子代理——独立 tmux 窗格里的一个 pi 会话，和手工 spawn 的子代理完全一样：能看、能发消息、能停。脚本本身跑在 QuickJS 沙箱里，`workflow` 工具立即返回 run id，run 在后台执行，结束时自动把结果送回主会话；过程中随时可以在主窗口打开 `/workflow` 面板观察和干预。

## 什么时候用

适合：

- 能拆成很多独立子任务的工作：按维度拆的审查、逐文件迁移、多来源调研。
- 下一步依赖前面子代理的结果，但依赖的**形状**可以提前写清楚。
- 大批量 fan-out，且中间结果不需要全部留在主会话上下文里。

不适合：

- 单个或少量子代理、结果你打算自己读：直接用 `subagent` 工具。
- 探索性工作：还描述不出控制流的阶段。
- 脚本化 fan-out 比直接在主会话里做更费 token 的任务——每个 agent 都是真实的模型调用，用户为每个 agent 付费。

## 运行一个 workflow

启动由 pi 完成，你把任务说清楚即可。脚本有三种来源：

1. **保存的脚本**：`<cwd>/.pi/workflows/<name>.js`（项目）或 `~/.pi/agent/workflows/<name>.js`（全局，`$PI_CODING_AGENT_DIR` 可覆盖）。`<name>` 只允许 `[A-Za-z0-9._-]`、1–64 字符；也可以直接给路径（含 `/` 或以 `.js` 结尾）。
2. **内联脚本**：把源码直接交给 pi。
3. **随包模板**：`examples/workflows/` 下的脚本。项目或全局同名脚本优先，所以可以直接覆盖内置模板。

pi 实际发出的工具调用形态如下（便于你读日志或自己指定）：

```js
workflow({ name: 'migrate-imports', args: { files: ['src/a.ts', 'src/b.ts'] } })  // 保存的脚本
workflow({ script: '...脚本源码...', args: { files: ['src/a.ts'] } })              // 内联
workflow({ action: 'resume', runId: 'wf-1a2b3c4d5e6f' })                          // 恢复
workflow({ action: 'status', runId: 'wf-1a2b3c4d5e6f' })                          // 查询（不带 runId 看最近一个）
workflow({ action: 'list' })                                                       // 列出项目、全局和内置 workflow
workflow({ action: 'guide' })                                                      // 读取编写指南和当前运行时 API
workflow({ action: 'guide', name: 'deep-research' })                               // 读取完整模板，不执行
```

`args` 必须是 JSON 可序列化的值，脚本里以 `args` 直接读到。

`list` 和 `guide` 是只读动作：不需要 tmux、持久化会话或可用的子代理配置，不会启动模型调用。`list` 展示每个 workflow 的 description、`whenToUse`、phases 和路径；`guide <name>` 返回完整脚本，适合在 skill 或文件读取不可用时参考。

工具立即返回 run id（形如 `wf-1a2b3c4d5e6f`）和 run 目录位置；run 在后台执行，落定（完成/失败/中止）时主会话收到一条消息：状态、完成数、token 用量、`runId`、`script:` 路径，以及脚本 `return` 值的 JSON（超长截断到 4000 字符，完整值在 run 目录的 `output.json`）。中途不需要轮询。

## 脚本契约

纯 JavaScript（不是 TypeScript），作为 async 函数体执行——`await` 和 `return` 都可用。**第一句必须是纯字面量的 `meta`**：

```js
export const meta = {
  name: 'migrate-imports',        // 必填：1–64 字符 slug，[A-Za-z0-9._-]
  description: '逐文件迁移并验证',  // 必填：非空描述
  phases: ['Migrate', 'Verify'],  // 可选：阶段列表，字符串或 { title, detail }
  whenToUse: '大范围改名时',       // 可选：什么时候该用它
  agent: 'worker',                // 可选：agent() 未点名时的默认子代理
}
```

`phases` 接受字符串，也接受 Claude Code 那种 `{ title, detail? }` 对象——它只用于展示，两种写法等价。

meta 只能是字面量（单引号、无引号键、尾逗号都接受；不允许模板字符串、变量、调用、展开）。它在运行前就被解析，是 run 的身份，也是恢复缓存归属的依据。

脚本使用下面的 workflow globals，没有文件系统、网络、计时器、`require` 或 `process`。`Date.now()` 和无参 `new Date()` 固定为持久化的 run 起始时间，`performance.now()` 恒为 0，不用于测量耗时；真实耗时由宿主记录。`Math.random()` 使用持久化 seed，但并发分支消耗随机序列的顺序可能变化，不要用共享随机数生成调用内容或缓存键。业务日期等输入用 `args` 显式传入，要文件内容就让 agent 去读。脚本报错的行号与源文件一致。

| 全局 | 签名 | 说明 |
| --- | --- | --- |
| `agent` | `agent(prompt, opts?)` → `Promise` | 启动一个交互式子代理。`opts`：`label`（仅面板行标题，不参与恢复键）、`phase`（阶段归属）、`schema`（结构化结果）、`agent` / `agentType`（子代理类型，两个名字等价）、`model`（模型覆盖）、`effort`（思考强度，取值 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`）。不认识的选项会在启动任何子代理之前报错——拼错的 `schemas:` 不会静默变成“用默认值跑”。 |
| `parallel` | `parallel(thunks)` → `Promise` | 并发跑一组 `() => Promise`，全部结束后统一返回（barrier）。失败的项返回 `null`，不影响其他项。 |
| `pipeline` | `pipeline(items, ...stages)` → `Promise` | 每个 item 独立依次走完所有 stage，stage 之间没有 barrier——快的 item 可以先进入下一阶段。stage 签名 `(prev, item, index)`（第一个 stage 的 `prev` 就是 item），返回值传给下一个 stage。任一步失败，该 item 整体为 `null`。 |
| `phase` | `phase(title)` → `Promise` | 设置 run 当前的阶段名（面板显示）。 |
| `log` | `log(message)` → `Promise` | 记录一条运行日志。 |
| `workflow` | `workflow(name, args?)` | 执行已保存的子工作流，共享父 run 的取消及限制。 |
| `args` | 任意 JSON 值 | 启动时传入的数据。 |
| `budget` | `{ total, spent(), remaining() }` | 运行 token 预算，单位是子代理的**未缓存输入 + 输出** token（cacheRead/cacheWrite 单独记录，不重复计入；不等于账单金额）。`spent()` / `remaining()` 返回**数字**（不是 Promise），并且在每次 `agent()` / `workflow()` 结束后刷新，所以 `while (budget.total && budget.remaining() > 50_000)` 这种写法是对的。`total` 取自 `PI_WORKFLOW_TOKEN_BUDGET`（未设置时为 `null`，此时 `remaining()` 为 `Infinity`）。**超限会中止 run**：预算用完后下一个 `agent()` 直接让 run 失败，脚本自己按 `remaining()` 收敛才能优雅结束。 |

**默认用 `pipeline`，不要用 `parallel`。** 除非下一步真的需要**全部**之前的结果（全量去重、跨项比较、发现“什么都没找到”后提前退出），否则让 pipeline 逐项推进——阶段之间没有 barrier。宿主按实际完成顺序交付调用结果，单项完成后的预算刷新也不等待无关的慢调用；`pipeline` 最终返回的数组仍按输入项顺序排列，`parallel` 仍等待整组完成。

**结构化结果必须用 `schema`。** `agent(prompt, { schema })` 返回的是子代理通过 `structured_output` 工具提交并被校验的对象，不是自由文本；要在结果上做分支就必须用它。子代理完成时若没有调用 `structured_output`，该调用判为失败（错误文本：`the agent finished without calling structured_output`）。schema 用常用 JSON Schema 子集：`type`（object / array / string / number / integer / boolean）、`properties`、`required`、`items`、`enum`、`description`、`additionalProperties`。未声明 properties 的嵌套 object 可返回任意字段；声明字段的对象默认闭合，显式 additionalProperties 可覆盖。根必须是 `{ type: 'object', properties: {...} }`，且 `required` 里的字段必须在 `properties` 里——不满足的 schema 在任何子代理启动之前就报错，而不是等烧完模型调用才失败。运行时会给 prompt 自动附加一句“用 structured_output 返回结果”，prompt 里不用重复。

**只读验证。** 证据收集、规划、审查和验证步骤可设置 `agent(prompt, { readOnly: true })`；随包 review-changes 的审查/核验以及 migrate-files 的规划/核验已启用，apply 仍可写。运行时移除 write/edit/普通 bash、任意扩展工具和自行委派（普通 worker 不受影响），保留定义中已有的 read/grep/find/ls、ask_question，以及受沙箱约束的 `verify_command`；schema 的 structured_output 照常可用。

`verify_command({ command, timeout_ms? })` 可读取文件，但只能向独立临时 scratch 写入；网络、tmux 和外部应用 IPC 被阻止。macOS 使用 sandbox-exec；Linux（arm64/x64）使用 bubblewrap 的只读挂载、独立 namespaces、能力移除、seccomp socket/异步 socket 系统调用限制，以及 Landlock 路径写权限（包括已有 FIFO）。Linux 需要安装 `bubblewrap`、`procps` 和 `python3`，内核及主机安全策略需允许非特权 user namespaces、seccomp 和 Landlock ABI 1+（Linux 5.13+）；依赖缺失或沙箱建立失败会明确报错，绝不退回裸 shell。`/tmp` 中的项目和依赖保持可读，只有每次调用新建的 scratch 可写。

默认每条命令 120 秒、最多 10 分钟，输出有上限；取消/超时会终止命令进程组，所属 Pi 退出（包括被强制结束）后，独立 watchdog 也会清理该组；Linux 另有 bubblewrap 的 parent-death 和 PID namespace 清理。需要生成仓库内构建产物或联网的测试会失败，应报告证据缺口或显式把输出配置到临时目录，而不是绕过限制。这不是敌对代码的通用安全容器，也不限制文件读取范围、CPU 或内存；macOS 中自行脱离进程组的恶意守护进程不在清理保证内。

只读模式纳入缓存键：不会复用之前可写步骤的答案；Focus 和 subagent_message 恢复原会话时继续限制权限。外部 CLI agent 不支持此模式，会在启动前拒绝。Skip/Abort 在 shell 就绪等待期间会取消启动、关闭已创建的自有 pane，并释放逻辑并发槽；已越过发命令时刻的调用按运行中取消处理。

**子工作流。** `workflow(name, args)` 解析项目 `.pi/workflows`、全局或随包脚本，首次执行把脚本保存到 `<runDir>/nested/`，恢复时使用该副本。支持一层嵌套；child 再调用 workflow 会让 run 失败。child 的普通 agent 与父 run 共用 journal、预算、取消和并发槽，child VM 本身不占 agent 槽；每个 run 最多调用 64 个 child、同时运行 16 个 child VM。必须 await 所有子任务后再 return，不支持以 workflow 脚本偷偷启动脱管后台工作。

**隔离写入。** `agent(prompt, { isolation: 'worktree' })` 从当前仓库的已提交 HEAD 创建 detached Git worktree，目录为 `<runDir>/worktrees/<callKey>`。主工作区的未提交修改和未跟踪文件不会被复制；隔离只避免意外互相覆盖，不是文件读取或恶意程序安全边界。不同调用各有一个工作树；重试/恢复同一调用复用其原工作树，保留修改、未跟踪文件和内部提交。Abort 不删除工作树，也不自动 merge、reset 或 clean。非 Git 项目会明确失败。运行结束后自行检查、测试并整合所需改动；查看调用的工作目录与保留工件，不能假定结果已经写回主仓库。

**显式重试。** `agent(prompt, { retries: 1, stallTimeoutMs: 60000 })` 允许失败后额外执行一次。`retries` 默认 0，可设置 0–5；重复执行可能重复写文件或外部副作用，必须由脚本作者明确 opt-in，不能把重试当成事务回滚。`stallTimeoutMs` 是单次尝试的活跃时间上限，不是模型 token 进展检测；可为 1000–21600000 毫秒，省略则使用默认值。提问等待由独立等待时限控制，不按工作时间误杀；Skip/Abort 不触发下一次重试。所有实际尝试仍受运行预算及调用数上限约束。每次尝试分别写 journal 并保留会话路径；同一 call 的最后一条 usage 累计之前的尝试，不能把该 call 的每条累计值再次求和。失败尝试的消耗也会在 resume 后保留。

**错误语义。** 一个子代理**死掉或失败**，只是这次调用落为 `null`，其他项继续——`parallel` / `pipeline` 如此，裸 `await agent(...)` 也如此，所以按 Claude Code 写的脚本（不包 `try/catch`，用 `.filter(Boolean)` 过滤）在这里行为一致。`null` 不等于“没事发生”：该调用仍记为 `failed`，面板上是 `✗`，run 的日志里会写一行 `… resolved to null`，落定消息里按名字列出所有“没有返回值的调用”。

**参数写错**（未知 agent、拼错的选项、不满足的 schema、超限、cli 型 agent 要 schema）是另一回事：这类错误直接抛，整个 run 失败。作者的错误不该被当成“没有结果”。

子代理看不到本次对话，每个 prompt 都要自包含。

**默认子代理。** `agent()` 没点名时使用普通 `worker`，`meta.agent` 和 `opts.agent` 照常覆盖。workflow 是执行模式，不是专用 agent 定义：运行时保留提问能力及定义中允许的自行委派，仅禁用嵌套 workflow；步骤不依赖用户手动操作，但可通过 ask_question 等待主模型回复，完成后自动退出、仅保留父会话 lineage，并将“直接返回步骤结果 / schema 最后调用 structured_output”的约束追加到系统提示。主模型收到问题后用 subagent_message 回复，子代理在同一会话继续；委派结果通知不会误清除待回答问题。等待期间可 Abort，同时关闭派生子窗格；迟到回复不会重新启动已中止步骤，需显式 Focus 或 Resume。并发与 agent 数上限只统计脚本直接发出的 agent() 调用，自行委派的调用属于子代理，不能将直接调用上限当作整棵委派树的上限。旧脚本的 `workflow-subagent` 名称在没有用户同名定义时映射到 worker；用户同名定义保留。旧默认调用的 journal 缓存键也兼容，resume 不会因此重跑已完成步骤。

## 编写指导与渐进披露

模型可见的 workflow 指导分三层，避免把长文档常驻在每次请求里：

1. `workflow` 工具描述保留 opt-in 门槛、形状选择规则、一个完整小范例、契约、错误/恢复语义和规模指导。
2. 随包提供 `workflow-authoring` skill。工具描述告诉模型在写脚本前加载它；加载后模型读到形状目录和详细参考，只在真正编写 workflow 时付这份上下文成本。
3. skills 或文件读取不可用时，`workflow({ action: 'guide' })` 返回同一份指南、参考和当前运行时声明，保证指导始终可达。

指导不提供“场景 → 固定脚本”的映射表，而是提供可组合骨架和默认约束：

| 依赖形状 | 写法 | 可运行模板 |
| --- | --- | --- |
| 独立调查，最终统一比较 | `parallel` + synthesis | `compare-options` |
| 每项独立推进下一阶段 | `pipeline`（默认） | `migrate-files` |
| 结果发现可变数量的子问题 | 审查后按 finding fan-out | `review-changes` |
| 同一 claim 的独立对抗验证 | 三次相同调用 + 结果分类 | `verify-claims` |
| 搜索、取证、核验、综合 | 复合 pipeline + voting + synthesis | `deep-research` |
| 根据验收条件反复改进 | 有轮数和预算上限的循环 | `iterative-refinement` |

`PI_WORKFLOW_SIZE=small|medium|large|unrestricted` 选择工具描述中的规划建议：约 5 / 10 / 50 次 agent 调用，默认 `medium`；`unrestricted` 省略数字后缀。它在扩展注册时读取，改变后需要 `/reload`。这个变量只影响规划建议，不改变运行时并发、单批 4096 项或单 run 1000 次启动的硬上限。模板接受的 `maxCalls` 也是模板自行计算和查询预算用的参数，不是内核配额。

## 完整例子：逐文件迁移 + 独立验证

保存为 `.pi/workflows/migrate-imports.js`（同一份源码也可以内联交给 pi 运行）：

```js
export const meta = {
  name: 'migrate-imports',
  description: '把每个文件迁移到新 API，再逐个独立验证',
  phases: ['Migrate', 'Verify'],
  agent: 'worker',
}

const files = args.files

const migratedSchema = {
  type: 'object',
  required: ['path', 'changed', 'summary'],
  properties: {
    path: { type: 'string' },
    changed: { type: 'boolean' },
    summary: { type: 'string', description: '一句话说明改了什么；未改动写：无需改动' },
  },
}

const verdictSchema = {
  type: 'object',
  required: ['path', 'ok', 'problems'],
  properties: {
    path: { type: 'string' },
    ok: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
  },
}

const report = await pipeline(
  files,
  // 阶段 1：迁移。每个文件独立推进，不等整批
  (file) =>
    agent(
      `把 ${file} 里的旧 API 迁移到新 API。先读该文件和 docs/api-migration.md，再改文件。`,
      { label: `migrate-${file}`, phase: 'Migrate', schema: migratedSchema },
    ),
  // 阶段 2：独立验证。迁移失败或未改动的文件直接跳过
  (mig, file) => {
    if (!mig || !mig.changed) return null
    return agent(
      `独立验证 ${file} 的迁移是否完整、等价。不要相信迁移者的总结，重新读代码核对。`,
      { label: `verify-${file}`, phase: 'Verify', agent: 'scout', schema: verdictSchema },
    )
  },
)

const passed = report.filter((item) => item && item.ok).length
await log(`${passed}/${files.length} 个文件通过验证`)
return report
```

启动：

```js
workflow({ name: 'migrate-imports', args: { files: ['src/a.ts', 'src/b.ts'] } })
```

每个文件由 `worker` 迁移完成后立刻开始验证，不必等别的文件；验证交给只读的 `scout`，不要相信迁移者自己的总结。两阶段的结果都在 `report` 里，脚本 `return` 的 `report` 就是这次 run 的结果（失败的项是 `null`）。

## 示例工作流

`examples/workflows/` 下有六个可直接运行的例子。它们是纯 JavaScript，只用沙箱提供的全局（`agent`、`parallel`、`pipeline`、`phase`、`log`、`args`、`budget`）——脚本本身不做文件操作，工作都交给子会话，每个子会话有自己的终端 pane。

保存的工作流按名字查找：先 `<项目>/.pi/workflows/<name>.js`，再 `~/.pi/agent/workflows/<name>.js`，最后随包模板。直接使用内置模板不需要复制：

```sh
# 先看每个模板的用途、阶段和路径
workflow({ action: 'list' })
```

覆盖内置模板时，把同名 `.js` 放到项目的 `.pi/workflows/` 或全局 workflows 目录即可。`name` 也接受相对项目根的路径或绝对路径。

### review-changes

按维度并行审查 → 每条发现由独立 agent 对抗性验证 → 只保留被确认的问题。返回的 `confirmed` 和 `unverified` 是扁平清单：`confirmed` 条目带 `dimension`，`unverified` 条目不带；`rejected` 是全局计数，不做维度归属。被上限挡住的维度与发现分别记在 `droppedDimensions`（维度名数组）和 `droppedFindings`（`{ dimension, count }` 数组）里，脚本日志也会打印。`args`：

- `target`（可选）：审查范围描述，默认“当前未提交的改动”
- `dimensions`（可选）：维度数组，默认三个（correctness、quality、regression）。每项是字符串，或 `{ name, focus, agent }`
- `verifierAgent`（可选）：验证者 agent；默认不绑定，用 workflow 的默认子代理
- `maxDimensions`（可选）：审查的维度数上限，默认 8、最大 16；超出的维度不审查，名字进 `droppedDimensions`
- `maxFindings`（可选）：每个维度送往验证的发现数上限，默认 20、最大 25；按严重性从高到低取前 N 条，裁掉的数量进 `droppedFindings`

默认维度不绑定 agent——维度要求写在提示词里，审查者就是普通的 workflow 子代理。想指定某个定义（比如一个只读的 reviewer）就在维度里写 `agent`：

```js
workflow({ action: 'start', name: 'review-changes', args: {
  target: 'PR #12 相对 main 的改动',
  dimensions: [
    { name: 'correctness', focus: '并发与错误路径', agent: 'scout' },
    { name: 'api', focus: '对外 API 兼容性' },
  ],
} })
```

### migrate-files

逐文件三段式：出计划（带 `risky` 标记）→ 按计划执行 → 验证。脚本里的 `if` 按 `risky` 选验证强度：非 risky 用轻量只读核验，risky 用能跑测试的完整核验。`args`：

- `task`（必填）：迁移任务描述
- `files`（必填）：文件路径列表
- 可选覆盖：`planAgent`（默认 `scout`）、`applyAgent`（默认 `worker`）、`verifierAgent`（默认 `worker`）、`quickVerifierAgent`（默认 `scout`）

`applyReport` 是执行者自述原文，**未经核验**：它只作为线索传给验证者，并原样附在走完验证的文件条目上（只有 `verified` 与 `needsAttention` 是对象条目，`unfinished` 里是文件路径字符串）。文件归类完全由验证者的 `ok` 决定；`issues` 随条目一起返回、但不参与分组。执行者自述某步没做不会改变归类，要读出这一点得人去看 `applyReport`。

```js
workflow({ action: 'start', name: 'migrate-files', args: {
  task: '把 fs 回调风格改成 async/await',
  files: ['src/loader.ts', 'src/writer.ts'],
} })
```

### compare-options

独立调查多个选项，全部完成后做一次比较。`args`：`question`（必填）、`options`（必填字符串数组）、可选 `maxCalls`（默认 10，包含综合）、`inspectAgent`、`synthesisAgent`。输入超过调用预算时会截断，并在结果中列出未纳入的选项。

### verify-claims

每条 claim 由三个独立 agent 对抗核验，结果区分 supported、refuted、disputed、incomplete 和 unverified。`args`：`claims`（必填）、可选 `context`、`maxCalls`（默认 10）、`verifierAgent`。它保留分歧和缺失票，不会把“没有人能反驳”当成支持。

### deep-research

Scope → 每查询 Search → Fetch → 对高优先级 claim 做三票 Verify → Synthesize。`args`：`question`（必填）、可选 `context`、`maxCalls`（默认 10）、`researchAgent`（默认 `researcher`）。模板会显式报告失败分支、未核验 claim、因预算省略的 claim 与查询（`omittedClaims`、`omittedQueries`），以及 fetch 明确报出的证据缺口（`evidenceGaps`）。`status` 只有在成功生成了综合答复（`answer` 非空）、没有任何省略与缺口、每条被纳入的查询都拿到证据、且每条被核验的 claim 都是 supported 或 refuted 时才是 `complete`，否则为 `incomplete`。`researcher` 必须可用并具备搜索/抓取能力；也可指定其他等价 agent。

### iterative-refinement

Critique → Revise，直到验收或轮数/调用/token guard 触顶。`args`：`task`、`initial`（均必填）、可选 `maxRounds`（默认 3）、`maxCalls`（默认 10）、`minRemainingTokens`、`criticAgent`、`editorAgent`。即使没有 token budget，也有轮数和调用上限。

## 恢复与缓存

调用按**内容 + 出现次序**记账：`callKey` 是 prompt + schema + agent + model + effort + readOnly + isolation 的哈希；label 仅用于展示，与完成顺序无关；同一份内容在一次 run 里出现第 N 次会带上序号。由此：

- **start 默认全新执行。** 即使同名同参也会重新启动子代理。只有显式传 `reuse: 'auto'` 时，才查找同 `meta.name` 且 `args` 相同的最近可复用 run，重放其中的 `completed` 调用；历史用量不挤占新 run 的预算。`reuse: 'none'` 与默认行为相同。继续某次具体执行请用 `resume`。
- **改 label 不重跑。** 新格式调用键不包含展示标签；重复相同内容仍按出现序号保留独立样本。旧版本含 label 的 journal 继续兼容原标签回放，修改旧记录标签可能重新执行。
- **改过的调用重跑。** prompt / schema / agent / model / effort / readOnly / isolation 任一变化都会改变内容键；内容没变的调用继续复用。model 和 effort 也在键里，所以把某个验证阶段从便宜模型换成强模型，会真的重跑，而不是把便宜模型的答案换个标签重放。
- **完全相同的多次调用是多个调用。** 三个一模一样的 refuter 是三个样本，不是同一个答案重放三遍——否则「3 票里 2 票确认」这种写法会失效。

**resume 用 runId 恢复一次具体的 run**：重新执行该 run 目录里的 `script.js`，重放 journal 里所有 `completed` 的调用，只补跑未完成的。适用于进程被杀（状态 `interrupted`）、中止（`aborted`）、失败（`failed`）之后：

```js
workflow({ action: 'resume', runId: 'wf-1a2b3c4d5e6f' })
```

面板里展开 run 并选择 `Resume workflow` 也可以。正在本会话运行中、或被另一个活进程持锁的 run 会被拒绝；死进程留下的锁自动回收（空锁超过几秒也算废弃）。resume 沿用 run 原始快照里的 `args` 和预算；也可以传 `args` 覆盖、传 `script` 换上改过的脚本（改动会被写回 run 目录，下次 resume 继续用它）。恢复要求还是同一个 pi 会话（run 存在该会话的 artifacts 目录里），重启后继续原会话即可——重启后 `/workflow <runId>` 也能打开磁盘上的 run。

**跳过的调用不会被当作已完成重放。** 只有 `completed` 进缓存；`skipped`（面板里手动跳过）和 `failed` 都不会在 resume 或重跑时“冒充”完成——它们会真正重新执行。被跳过时脚本拿到 `null` 并继续，这是用户的决定，不是错误。

## 观测面板

打开方式：

- 命令 `/workflow`：TUI 下打开覆盖面板；非 TUI 会话打印文本报告，`/workflow <runId>` 查看指定 run。
- 快捷键 **Ctrl+Alt+W**（默认绑定，见 `/hotkeys`）：切换面板的打开/关闭。确认页中也可直接关闭，关闭不会执行尚未确认的动作；再次打开保留树的位置与展开状态。

主界面保留 `Subagents` 状态框，仍然展示运行中的所有子代理。历史定义名 `(workflow-subagent)` 不再重复显示；当前定义如 `(worker)`、`(scout)` 正常显示。框底附上运行中 workflow 的名字、简单进度条、`settled/issued` 计数、running 数、累计 tokens、费用以及打开面板的快捷键。进度只反映脚本已发出的调用；脚本产生新调用时分母会增加，不代表预先知道整个脚本的任务总数。脚本仍在运行但没有活跃 agent 时，摘要继续保留。

详情是一个居中、有完整边框的 overlay，四周留出背景，框内完整覆盖；宽度适配窗格并设置上限，高度在打开期间随终端尺寸保持稳定。里面不再重复进度条和用量，也没有底部快捷键提示。使用 Pi 列表的 `❯` 光标、状态符号和主题颜色。

内容是一棵树：

```text
Workflows
  workflow name                       running · 2m10s
    phase
      subagent                        streaming 2s
        Focus
        Skip
    Abort workflow
```

- 多个 run 并列为根节点；同名 run 附启动日期和时间。默认展开最近的运行中 run，其他 run 收起。
- phase 真正合并分组，优先按 `meta.phases` 顺序；无 phase 的调用放入 `Tasks`。空阶段保留名称，不推断已完成。
- agent 右侧显示实时活动、耗时、`cached` 或结束状态；失败项展开后显示完整换行错误。run 本身的错误同样在展开后显示。
- 选择和展开状态在关闭重开后保留，光标按 run + call 身份定位；新增任务或状态刷新不抢光标。长列表在框内滚动，已结束 run 的耗时冻结。

导航：

- `↑`/`↓` 或 `k`/`j`：上一个/下一个可见节点。
- `→` 或 `l`：展开当前节点；已展开时进入第一个子节点。
- `←` 或 `h`：收起当前节点；叶子或已收起节点回到父节点。
- `Enter`：展开/收起分支，或执行选中的动作。
- `Esc`（也接受 `q`）：关闭面板，workflow 在后台继续。确认页的 `Esc` 返回树。

动作直接位于树中，没有独立动作菜单：

- **Focus**：运行中的 agent 切到原 tmux pane；已结束的 agent 重新打开原始会话及历史，不自动发送消息。有现存会话 pane 时复用，不创建重复进程。成功后关闭弹窗。Pi 会话沿用原模型、身份和工具权限，但保持交互模式；原生 CLI 会话按原 native session ID 打开。会话或权限快照缺失时明确报错。继续与单个 agent 交互不会替换 workflow 已记录的结果。
- **Skip**：仅 queued/running 调用提供。确认后停止该调用，脚本立即收到 `null` 并继续；恢复时会重新执行。排队任务没有会话时不提供 Focus。
- **Abort workflow**：仅运行中 run 提供。确认后中止脚本及运行中的 agents，保留完成记录。
- **Resume workflow**：仅 failed/aborted/interrupted run 提供。确认后重放脚本，复用 completed 调用，其余调用重新执行；不是让原进程从停止的指令继续。

Skip、Abort、Resume 使用同一框内的确认页，默认选中 `Cancel`。确认期间目标已结束时拒绝过期动作并显示原因。message/stop 操作不放入面板，用户可在真实 pane 中交互。日志、完整用量和返回值仍可通过 status、journal 与 output 文件查看。

`/workflow <runId>` 打开的面板只显示这个 run；该 runId 不在本会话、磁盘上也找不到时给出提示，而不是一个空面板。进程重启之前的 run 也能这样打开——面板会从 artifacts 目录读回来，和 `workflow({ action: 'status' })` 看到的一致。

**这些 agent 也是普通子代理。** 面板里每一行背后都是一个真实 pi 会话，名字形如 `<workflow名>-<label>`（如 `migrate-imports-migrate-src-a-ts`，重名自动加 `-2`），注册在会话命名表里，可以直接用 `subagent_message` 对话——运行中会注入它的窗格，已结束会把它叫回来在原会话上继续回答：

```js
subagent_message({ name: 'migrate-imports-migrate-src-a-ts', message: '为什么你把 X 也改了？' })
```

## 限制

- 并发：每个 run 同时最多 `min(16, CPU 核数 − 2)` 个 agent（下限 2），超出的调用排队；`PI_WORKFLOW_MAX_CONCURRENT_AGENTS` 可以覆盖（每个 agent 是一个真实窗格，机器忙的时候调小）。
- 单次 `parallel` / `pipeline` 最多 4096 项；单个 run 最多 1000 个 `agent()` 调用，再开会被拒绝（`Workflow exceeded 1000 agents in one run`）。按**实际启动次数**计，不是按去重后的键——否则一个反复发同一个调用的死循环永远撞不到这个上限。
- 设了 `PI_WORKFLOW_TOKEN_BUDGET` 时，预算用尽会让 run 失败（而不是只报个数继续跑）。
- 不支持嵌套：`workflow()` 调用直接报错；子步骤写进当前脚本。
- 需要 tmux；pi 会话必须有持久化 session 文件，否则 start 直接以 `Cannot run a workflow: …` 拒绝。
- `agent()` 只能使用当前会话允许的 agent 定义（与 `subagent` 工具同一套 allowlist），都不满足时会报错。
- 超时是两层的，都不按整轮的墙钟算：脚本自身 30 分钟没有任何进展、且没有未结算的调用，才中止整轮；单个 `agent()` 调用累计运行 60 分钟仍未结束则以 `failed` 结算，脚本拿到 `null` 继续，其他调用和整轮都不受影响。等待 `ask_question` 回复（状态 `waiting`）默认不设上限：等待是 run 自己要来的状态，进程退出由 watcher 结算，运行时不会在无法证明失联时猜它死掉；只有显式设置 `PI_WORKFLOW_WAIT_TIMEOUT_MS`（毫秒，`0` 关闭）才给等待设上限，超出的等待时间开始计入上面的 60 分钟。`PI_WORKFLOW_CALL_TIMEOUT_MS` 改单调用上限，`0` 关闭。
- 沙箱无文件系统/网络/计时器，堆上限 256MB；脚本卡死不会拖住 pi 主界面。
- 每个 `agent()` 都是完整模型调用，成本按 agent 数量线性增长。

## 运行产物与排查

每个 run 一个目录：`<sessionDir>/artifacts/<sessionId>/workflows/<runId>/`（和子代理名册 `subagent-registry.json` 在同一个 artifacts 目录下）。最省事的定位方式：启动时返回的 `script:` 路径就在这个目录里；从落定消息里也能拿到 `runId`。

| 文件 | 内容 |
| --- | --- |
| `script.js` | 本次运行实际执行的源码（resume 用的就是它，不是你后来改过的文件） |
| `snapshot.json` | 运行快照：meta、args、seed、状态、当前 phase、最终 result、error、起止时间、`resumedFrom`（若恢复过） |
| `journal.jsonl` | 每行一个已结算的调用：callKey、label、prompt、status、value、error、usage、子代理的 session 信息。恢复的缓存来源；只有 `completed` 条目会进缓存，截断的尾行会被忽略 |
| `output.json` | 脚本 `return` 的值（`{ ok: true, value: … }`，仅成功时存在） |
| `calls/<callKey>/schema.json` | 传给该子代理的 JSON Schema（仅结构化调用） |
| `calls/<callKey>/result.json` | 子代理通过 `structured_output` 回传的结果（仅结构化调用）；缺失 = 它完成时没调用该工具 |
| `lock` | 运行期间持有，防止两个进程同时执行同一个 run；进程死后自动回收 |

定位失败：

1. 面板里展开 `✗` 调用查看完整错误，或查询 `workflow({ action: 'status', runId })`。
2. 在 journal 里翻这个调用的原文：

   ```sh
   RUN='<sessionDir>/artifacts/<sessionId>/workflows/wf-1a2b3c4d5e6f'
   jq -r 'select(.status != "completed") | [.label, .status, .error] | @tsv' "$RUN/journal.jsonl"
   ```

3. 结构化结果失败最常见的原因是子代理没调用 `structured_output`（`calls/<callKey>/result.json` 缺失），常见于 prompt 太含糊，或 schema 超出了支持子集。
4. 想看子代理的完整对话：journal 里每个调用带 `sessionFile` / `sessionId`，指向它自己的 pi 会话；也可以按名字用 `subagent_message` 把它叫回来追问。
5. 修好脚本或输入后：全新 start，或显式 `reuse: 'auto'` 复用同名同参结果，或 resume 那个 runId。
6. `snapshot.json` 状态是 `running` 但已经没有进程在跑 → `interrupted`，直接 resume。

注意：`script.js`、`snapshot.json`、`journal.jsonl` 里保存了完整 prompt 和结果文本，可能包含敏感内容。

## 和 subagent 工具的关系

两者共用同一条执行通道：同样的 tmux 窗格、命名表、权限沙箱、状态机、用量统计和 widget。`workflow` 只是把 `agent()` 调用编排成确定性脚本。单个或少量子代理用 `subagent`；成批、分阶段、有可预先写清的依赖结构时用 `workflow`。
