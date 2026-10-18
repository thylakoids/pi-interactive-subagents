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

启动由 pi 完成，你把任务说清楚即可。脚本有两种来源：

1. **保存的脚本**：`<cwd>/.pi/workflows/<name>.js`（项目）或 `~/.pi/agent/workflows/<name>.js`（全局，`$PI_CODING_AGENT_DIR` 可覆盖）。`<name>` 只允许 `[A-Za-z0-9._-]`、1–64 字符；也可以直接给路径（含 `/` 或以 `.js` 结尾）。
2. **内联脚本**：把源码直接交给 pi。

pi 实际发出的工具调用形态如下（便于你读日志或自己指定）：

```js
workflow({ name: 'migrate-imports', args: { files: ['src/a.ts', 'src/b.ts'] } })  // 保存的脚本
workflow({ script: '...脚本源码...', args: { files: ['src/a.ts'] } })              // 内联
workflow({ action: 'resume', runId: 'wf-1a2b3c4d5e6f' })                          // 恢复
workflow({ action: 'status', runId: 'wf-1a2b3c4d5e6f' })                          // 查询（不带 runId 看最近一个）
```

`args` 必须是 JSON 可序列化的值，脚本里以 `args` 直接读到。

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

脚本可用的全局**只有下面这些**——没有文件系统、网络、计时器、`require`、`process`，也不提供 `Date.now()` 和 `Math.random()`。时间和随机数来自 run 而不是脚本，这样恢复才能重放；需要的一切输入都用 `args` 传进来，要文件内容就让 agent 去读。脚本报错的行号与源文件一致。

| 全局 | 签名 | 说明 |
| --- | --- | --- |
| `agent` | `agent(prompt, opts?)` → `Promise` | 启动一个交互式子代理。`opts`：`label`（面板行标题，也参与恢复键）、`phase`（阶段归属）、`schema`（结构化结果）、`agent` / `agentType`（子代理类型，两个名字等价）、`model`（模型覆盖）、`effort`（思考强度，取值 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`）。不认识的选项会在启动任何子代理之前报错——拼错的 `schemas:` 不会静默变成“用默认值跑”。 |
| `parallel` | `parallel(thunks)` → `Promise` | 并发跑一组 `() => Promise`，全部结束后统一返回（barrier）。失败的项返回 `null`，不影响其他项。 |
| `pipeline` | `pipeline(items, ...stages)` → `Promise` | 每个 item 独立依次走完所有 stage，stage 之间没有 barrier——快的 item 可以先进入下一阶段。stage 签名 `(prev, item, index)`（第一个 stage 的 `prev` 就是 item），返回值传给下一个 stage。任一步失败，该 item 整体为 `null`。 |
| `phase` | `phase(title)` → `Promise` | 设置 run 当前的阶段名（面板显示）。 |
| `log` | `log(message)` → `Promise` | 记录一条运行日志。 |
| `workflow` | `workflow(name, args?)` | 声明存在，但当前版本不支持嵌套：调用会直接报错。把子步骤内联写进当前脚本。 |
| `args` | 任意 JSON 值 | 启动时传入的数据。 |
| `budget` | `{ total, spent(), remaining() }` | 运行 token 预算，单位是子代理的**总** token（输入+输出）。`spent()` / `remaining()` 返回**数字**（不是 Promise），并且在每次 `agent()` 结束后刷新，所以 `while (budget.total && budget.remaining() > 50_000)` 这种写法是对的。`total` 取自 `PI_WORKFLOW_TOKEN_BUDGET`（未设置时为 `null`，此时 `remaining()` 为 `Infinity`）。**超限会中止 run**：预算用完后下一个 `agent()` 直接让 run 失败，脚本自己按 `remaining()` 收敛才能优雅结束。 |

**默认用 `pipeline`，不要用 `parallel`。** 除非下一步真的需要**全部**之前的结果（全量去重、跨项比较、发现“什么都没找到”后提前退出），否则让 pipeline 逐项推进——阶段之间没有 barrier。

**结构化结果必须用 `schema`。** `agent(prompt, { schema })` 返回的是子代理通过 `structured_output` 工具提交并被校验的对象，不是自由文本；要在结果上做分支就必须用它。子代理完成时若没有调用 `structured_output`，该调用判为失败（错误文本：`the agent finished without calling structured_output`）。schema 用常用 JSON Schema 子集：`type`（object / array / string / number / integer / boolean）、`properties`、`required`、`items`、`enum`、`description`。根必须是 `{ type: 'object', properties: {...} }`，且 `required` 里的字段必须在 `properties` 里——不满足的 schema 在任何子代理启动之前就报错，而不是等烧完模型调用才失败。运行时会给 prompt 自动附加一句“用 structured_output 返回结果”，prompt 里不用重复。

**错误语义。** 一个子代理**死掉或失败**，只是这次调用落为 `null`，其他项继续——`parallel` / `pipeline` 如此，裸 `await agent(...)` 也如此，所以按 Claude Code 写的脚本（不包 `try/catch`，用 `.filter(Boolean)` 过滤）在这里行为一致。`null` 不等于“没事发生”：该调用仍记为 `failed`，面板上是 `✗`，run 的日志里会写一行 `… resolved to null`，落定消息里按名字列出所有“没有返回值的调用”。

**参数写错**（未知 agent、拼错的选项、不满足的 schema、超限、cli 型 agent 要 schema）是另一回事：这类错误直接抛，整个 run 失败。作者的错误不该被当成“没有结果”。

子代理看不到本次对话，每个 prompt 都要自包含。

**默认子代理。** `agent()` 没点名时，用本仓库自带的 `workflow-subagent`（一个普通 pi 子代理）。这一点是刻意的：`agents/` 目录里还有 `cli:` 型定义（外部 coding CLI），它们带自己的工具集和模型、也没有 pi 的工具层，不该被当成“随手跑个 prompt”的默认值。`meta.agent` 和 `opts.agent` 照常覆盖。

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

`examples/workflows/` 下有两个可直接运行的例子。它们是纯 JavaScript，只用沙箱提供的全局（`agent`、`parallel`、`pipeline`、`phase`、`log`、`args`、`budget`）——脚本本身不做文件操作，所有工作都交给子会话，每个子会话有自己的终端 pane。

保存的工作流按名字查找：先 `<项目>/.pi/workflows/<name>.js`，再 `~/.pi/agent/workflows/<name>.js`。复制（或软链）过去即可按名字自动发现：

```sh
# 在 pi-interactive-subagents 仓库根目录执行
mkdir -p <你的项目>/.pi/workflows
cp examples/workflows/review-changes.js examples/workflows/migrate-files.js <你的项目>/.pi/workflows/
```

不复制也可以：`name` 接受相对项目根的路径或绝对路径，例如 `name: 'examples/workflows/review-changes.js'`。

### review-changes

按维度并行审查 → 每条发现由独立 agent 对抗性验证 → 只保留被确认的问题（结果里附各维度驳回/未验证计数）。`args`：

- `target`（可选）：审查范围描述，默认“当前未提交的改动”
- `dimensions`（可选）：维度数组，默认三个（correctness、quality、regression）。每项是字符串，或 `{ name, focus, agent }`
- `verifierAgent`（可选）：验证者 agent；默认不绑定，用 workflow 的默认子代理

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

```js
workflow({ action: 'start', name: 'migrate-files', args: {
  task: '把 fs 回调风格改成 async/await',
  files: ['src/loader.ts', 'src/writer.ts'],
} })
```

## 恢复与缓存

调用按**内容 + 出现次序**记账：`callKey` 是 label + prompt + schema + agent + model + effort 的哈希，与完成顺序无关；同一份内容在一次 run 里出现第 N 次会带上序号。由此：

- **同名同参重跑（start）自动复用。** 再次 start 同一个 workflow、且 `args` 相同，会找到上一次含完成记录的同类 run，把其中 `completed` 的调用按 callKey 直接复用：没改过的调用不会再起 agent，面板上标 `(cached)`。归属看 `meta.name`（不是文件名）**加上 `args`**——`args` 不在键里，所以参数变了就不再复用（否则会拿上一次的答案回答新问题）。想强制不复用，传 `reuse: 'none'`。
- **改过的调用重跑。** label / prompt / schema / agent / model / effort 任一变化都会改变内容键；内容没变的调用继续复用。model 和 effort 也在键里，所以把某个验证阶段从便宜模型换成强模型，会真的重跑，而不是把便宜模型的答案换个标签重放。
- **完全相同的多次调用是多个调用。** 三个一模一样的 refuter 是三个样本，不是同一个答案重放三遍——否则「3 票里 2 票确认」这种写法会失效。

**resume 用 runId 恢复一次具体的 run**：重新执行该 run 目录里的 `script.js`，重放 journal 里所有 `completed` 的调用，只补跑未完成的。适用于进程被杀（状态 `interrupted`）、中止（`aborted`）、失败（`failed`）之后：

```js
workflow({ action: 'resume', runId: 'wf-1a2b3c4d5e6f' })
```

面板上按 `r` 也可以。正在本会话运行中、或被另一个活进程持锁的 run 会被拒绝；死进程留下的锁自动回收（空锁超过几秒也算废弃）。resume 沿用 run 原始快照里的 `args` 和预算；也可以传 `args` 覆盖、传 `script` 换上改过的脚本（改动会被写回 run 目录，下次 resume 继续用它）。恢复要求还是同一个 pi 会话（run 存在该会话的 artifacts 目录里），重启后继续原会话即可——重启后 `/workflow <runId>` 也能打开磁盘上的 run。

**跳过的调用不会被当作已完成重放。** 只有 `completed` 进缓存；`skipped`（面板里手动跳过）和 `failed` 都不会在 resume 或重跑时“冒充”完成——它们会真正重新执行。被跳过时脚本拿到 `null` 并继续，这是用户的决定，不是错误。

## 观测面板

打开方式：

- 命令 `/workflow`：TUI 下打开覆盖面板；非 TUI 会话打印文本报告，`/workflow <runId>` 查看指定 run。
- 快捷键 **Ctrl+Alt+W**（默认绑定，见 `/hotkeys`）。

面板不常驻编辑器上方——早期版本有一个每秒刷新的 widget，既让编辑器区域闪烁，也让已完成 run 的耗时随时间虚增，已移除。面板是用户主动打开的 overlay，渲染不碰编辑器：

- 一次只显示一个 run（默认最新的活跃 run，没有活跃的就显示最新的），`[` / `]` 切换，标题右侧标 `n/m`；**面板里不出现 runId**——名字和在 run 列表里的位置足够定位。
- 视觉是 Claude Code 的一套：无边框、无分隔线，靠明暗分层；选中行是强调色 `❯` 指针（不是反色块），已完成的 agent 整行变暗、进行中的最亮，底部按键提示是暗色且只列当前行真正能做的动作。
- 内容按终端高度开窗，光标跟着可见区域走，末尾标出 `(光标行/总行数)`，所以 call 比屏幕多的 run 也能完整浏览；光标跟踪的是身份（callKey）而不是行号，重绘时新增或消失的行不会把光标挪到别的 agent 上。
- 打开期间只要有 run 还在跑就每秒重绘一次，内容没变则不重绘；没有活跃 run 就停表。已结束 run 的耗时按结束时刻算，不会因为面板开着而虚增。
- 面板铺满终端宽度、锚在顶部：overlay 是画在既有内容上的，居中的窄框会让两侧漏出会话的历史输出。

面板里能看到（一次一个 run）：

- 标题行：状态字形 + run 名字（`✻` running / `✓` completed / `✗` failed / `⊘` aborted、interrupted），右侧 dim 的 `状态 · 耗时`。
- 元信息行：`已结算/总数` agents · 累计 token（有预算时写成 `已用 / 预算 tokens`）· 费用；有失败时补 `n failed`。
- 进度行：`▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱ 43%`（暗条 + 亮数字）。
- 最近几条 run 日志（脚本的 `log()` 和运行时的提示，如 `reusing 3 completed call(s)`），最多 3 条；被截断时标出还有多少条没显示。
- agent 行按 **phase 分组**：同一 phase 字符串合成一组，组头是 dim 的阶段名。`view.phase`（最后一次 `phase()` 调用）不再出现在标题里——它会在早期阶段的 agent 还在跑时就翻到下一个阶段，和下面的行自相矛盾。
- 每个 agent（call）一行：状态字形（`○` queued / `✻` running / `✓` completed / `✗` failed / `⊘` skipped、aborted）、label、右侧活动列——运行中是子代理窗口里同一句实时状态（如 `bash 19s`），结束的是耗时和 `cached` 标记，失败的行尾就是错误文本；run 自身的错误单独占一行。
- 单个 agent 的 model 与 token 用量不在面板逐行显示（面板按「一行一件事」排版），看 `workflow({ action: 'status' })` 的返回或 journal 里的 `usage` 字段。

能做的事：

- `↑`/`↓`（或 `j`/`k`）选择一行，`g`/`G` 到首/末，`PgDn`/`PgUp`（或 `Ctrl+D`/`Ctrl+U`）翻页。
- `enter` 打开该行的动作菜单（`↑`/`↓` 选、回车执行、`Esc` 取消），菜单只列出该行当前可行的动作；同样的动作也可以直接按键完成：
  - `f` —— **focus**：把该 agent 的 tmux 窗格切到前台；
  - `m` —— **message**：给该 agent 发一条消息（已结束的会把它叫回原会话继续）；
  - `x` —— **stop**：停掉该 agent（关窗格），脚本把这次调用当失败、该项为 `null`；
  - `s` —— **skip**：跳过该调用——脚本立刻收到 `null` 继续跑（跳过不算完成，恢复时会重跑）；
  - `a` / `r` —— 直接中止运行中的这个 run（先确认）/ 恢复已结束或中断的这个 run；
  - `[` / `]` —— 本会话有多个 run 时，切换前一个 / 后一个；
  - `q` / `Esc` —— 关闭。

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
- 脚本 30 分钟无任何进展会被中止（默认值，偏宽松；agent 正常工作会不断重置）。
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

1. 面板 / `workflow({ action: 'status', runId })` 里哪一行是 `✗`，行尾就是错误文本。
2. 在 journal 里翻这个调用的原文：

   ```sh
   RUN='<sessionDir>/artifacts/<sessionId>/workflows/wf-1a2b3c4d5e6f'
   jq -r 'select(.status != "completed") | [.label, .status, .error] | @tsv' "$RUN/journal.jsonl"
   ```

3. 结构化结果失败最常见的原因是子代理没调用 `structured_output`（`calls/<callKey>/result.json` 缺失），常见于 prompt 太含糊，或 schema 超出了支持子集。
4. 想看子代理的完整对话：journal 里每个调用带 `sessionFile` / `sessionId`，指向它自己的 pi 会话；也可以按名字用 `subagent_message` 把它叫回来追问。
5. 修好脚本或输入后：同名重跑（已完成调用自动复用）或 resume 那个 runId。
6. `snapshot.json` 状态是 `running` 但已经没有进程在跑 → `interrupted`，直接 resume。

注意：`script.js`、`snapshot.json`、`journal.jsonl` 里保存了完整 prompt 和结果文本，可能包含敏感内容。

## 和 subagent 工具的关系

两者共用同一条执行通道：同样的 tmux 窗格、命名表、权限沙箱、状态机、用量统计和 widget。`workflow` 只是把 `agent()` 调用编排成确定性脚本。单个或少量子代理用 `subagent`；成批、分阶段、有可预先写清的依赖结构时用 `workflow`。
