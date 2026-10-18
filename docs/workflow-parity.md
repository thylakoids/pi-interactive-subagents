# Claude Code Dynamic Workflow 与本插件 workflow 实现的对照

本文对照两套“脚本编排子代理”的实现：已安装的 Claude Code 2.1.299 二进制里的 Dynamic Workflow（本插件接口按其脚本契约对齐），以及本仓库 `pi-extension/subagents/workflow/` 的实现。结论都可用文末的方法自行复核。

## 1. 调查方法与证据来源

- 对象：`/Users/liyulong/.local/share/claude/versions/2.1.299`（Mach-O arm64 可执行文件，247,931,696 字节，sha256 前缀 `ba5ab7b8`）。
- 该二进制由 Bun 编译，整个 JS bundle 以明文形式嵌在可执行文件里：模块源码带 `// @bun @bytecode` 头，虚拟文件表里有 2,649 条 `file:///$bunfs/root/chunk-*.js` 路径。用 `grep -a -b -o` 定位字节偏移，再用 `tail -c +偏移 | head -c 长度` 切片即可取出原文；无需反编译，也没有件是压缩或混淆到不可读的。
- 只读操作：先复制一份二进制副本，所有 grep/切片都在副本上做，原文件未被改动（复制后 `cmp` 一致）。
- 没有可用的源码仓库。下文第 2 节的全部结论来自该二进制内嵌的文本与代码；引号内的英文句子是二进制文本原文（源码里的转义序列 `—` 等已还原成字符），并已标明出处性质。第 3 节起为本仓库源码（相对路径）。

## 2. Claude Code 的实现要点

### 2.1 工具暴露与 opt-in 门槛

工具名 `Workflow`（别名 `RunWorkflow`），后台运行、立即返回任务 ID。模型看到的描述由三段拼成：3,088 字符的基础模板 `t`；当 `workflow-authoring` skill 可用时只附加一段指针文本，否则内嵌整份 17,607 字符的“Workflow authoring reference”（两者是同一份长文本的两种投递方式）；再加一段 workflow size guideline 后缀（small/medium/large 对应 5/10/50 个 agent，`unrestricted` 时后缀为空）。

最重要的行为门槛（引自安装的二进制内嵌工具描述）：

> ONLY call this tool when the user has explicitly opted into multi-agent orchestration.

opt-in 的判定条件写得很具体：用户提示里出现 `ultracode`、会话开启了 ultracode、用户用自己的话点名要求、用户调用了指示调用 Workflow 的 skill/斜杠命令、或点名某条已保存工作流。任务是“会从并行中受益”不算。此外有 disableWorkflows / enableWorkflows 设置、growthbook 开关、`CLAUDE_CODE_DISABLE_WORKFLOWS` 等环境变量，以及运行前的权限对话框（展示 `meta.phases`，即“Review dynamic workflow before running”）。

### 2.2 输入 / 输出 schema

输入（zod）：`script`（≤524,288 字节，拒绝控制字符）、`name`（预定义工作流名）、`description` / `title`（均被忽略，描述要写在 `meta` 里）、`args`（原样暴露为脚本全局 `args`，要求传真正的 JSON 值）、`scriptPath`（磁盘脚本路径，优先于 script/name，用于编辑后迭代）、`resumeFromRunId`（正则 `^wf_[a-z0-9-]{6,}$/`）。refine 要求四者至少给一个，否则报 “Must provide script, name, scriptPath, or runId”。每次调用都会把脚本持久化到会话目录并在结果里返回路径。输出含 `status`、`taskId`、`taskType`（`local_workflow` / `remote_agent`）、`workflowName`、`runId`、`transcriptDir`、`scriptPath`、`warning`、`error` 等。

### 2.3 脚本契约与 pipeline 默认

脚本必须是纯 JavaScript（不是 TypeScript），首句是纯字面量 `export const meta = { name, description, phases }`（phases 是 `{title, detail?}` 数组，title 与 `phase()` 调用精确匹配）；脚本可用 `agent()`、`parallel()`、`pipeline()`、`phase()`、`log()`、`args`、`budget`、`workflow()`（一层嵌套）。`agent()` 无 schema 时返回子代理最后一段文本字符串，有 schema 时返回校验过的对象。脚本无文件系统与 Node API，且 `Date.now()` / `Math.random()` / 无参 `new Date()` 会抛错（因为它们会破坏 resume）；这条由 AST 检查（`cwn`）和运行期共同执行。

多阶段编排的默认形态（引自安装的二进制内嵌的 authoring reference）：

> DEFAULT TO pipeline(). Only reach for a barrier (parallel between stages) when you genuinely need ALL prior-stage results together.

二进制里只注册了唯一一条内置工作流：`deep-research`（24,272 字节脚本，Scope → Search → Fetch → Verify 三票对抗 → Synthesize）；工具描述与 authoring reference 里另有 review-changes、find-flaky-tests 等示例。

### 2.4 journal 与 resume

每次运行在目录里写 `journal.jsonl`，行类型 `started` / `failed` / `result`；缓存键是 `"v2:" + sha256(opts 规范化后 + 分离字段)`，opts 规范化覆盖 `schema`、`model`、`effort`、`isolation`、`agentType`、`disallowedTools`、`bashCommandClamp`。恢复流程：校验旧 run 状态（还在跑/paused 时拒绝），读磁盘 journal（或远端镜像），重新执行脚本并回放结果。

恢复语义（引自安装的二进制内嵌的 Resume 段）：

> the longest unchanged prefix of agent() calls returns cached results instantly; the first edited/new call and everything after it runs live

限制与兜底：仅限同一会话；没有 journal 时提示去读 transcript 目录里的 `agent-<id>.jsonl` 手工续写；诊断时先读 `journal.jsonl`（“cached results may themselves be empty”）。

### 2.5 并发与数量上限

- 并发门：`min(16, max(2, availableParallelism - 2))`，可被 `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` 覆盖；超出的 `agent()` 排队。
- 单次 `parallel()` / `pipeline()` 最多 4,096 项（`FR=4096`），超出是显式报错而非静默截断；该常量同时是值跨 VM 桥的日志上限。
- 单次运行生命周期内最多 1,000 个 agent（`WorkflowAgentCapError`，报错里提示“用 budget.remaining() 的循环在无预算时会把 remaining() 当 Infinity，请加硬性迭代上限”）。
- token 预算来自用户 “+500k” 这类指令，主循环与所有工作流共享一个池；是硬上限，触顶抛 `WorkflowBudgetExceededError`（在途 agent 跑完、结果保留）。
- 另有一个 50 的并发门（推测用于分类/预检），证据不足，未确认。

### 2.6 结构化输出与子代理

工作流子代理是内置 agent 类型 `workflow-subagent`，禁掉 `SendUserMessage`、`Agent`、`Workflow` 工具。系统提示写明“最终文本就是返回值，不是给人看的消息”；带 schema 时改为“必须恰好调用一次 `StructuredOutput` 工具”。`StructuredOutput` 工具以 `{type:'object', ...}` 为根、透传 JSON Schema，用 ajv 在工具调用层校验（校验失败模型会重试）；schema 不合法（required 不 ⊆ properties）在 `agent()` 时就抛错。

### 2.7 通知

完成通知的载体是 `<task-notification>` XML：`task-id`、`tool-use-id`、`task-type`、`output-file`、`status`、`summary` 等标签加正文。模板为 `Dynamic workflow "X" completed` / `... failed: ...` / `... was stopped`；失败/中止时附 `<recovery>`（给出带 `scriptPath` + `resumeFromRunId` 的恢复调用）；完成时附 `<diagnostics>`（journal.jsonl 解释、“结果为空先读这个文件再诊断”、重跑提示）与 `<usage>`（agent_count / subagent_tokens / tool_uses / duration_ms）；结果超过 8,000 字符时截断并指向 output 文件。另有 paused 提示“Resume the paused workflow by calling: Workflow({scriptPath, resumeFromRunId})”。

## 3. 本插件的实现

代码在 `pi-extension/subagents/workflow/`，通过 `pi-extension/subagents/wiring.ts` 复用交互式子代理的启动/观察通路。

### 3.1 脚本执行：worker 里的 QuickJS + prelude

`runner.ts` 用 `@earendil-works/pi-codemode` 的 `CodemodeSandbox` 在 worker 线程里跑 QuickJS（wasm）。VM 没有文件系统、网络、定时器、`require`、`process`。宿主只暴露五个桥接全局（`__wfBridgeAgent/Phase/Log/Workflow/Budget`）；沙箱声明的全局不可写、调用桥每次只带一个参数，因此脚本里常见的 API（`agent`/`parallel`/`pipeline`/`phase`/`log`/`workflow`/`args`/`budget`）由一段 prelude 用 `const` 定义并遮蔽桥接名——`parallel` 和 `pipeline` 是纯 Promise 编排，留在 VM 里，`agent()` 是唯一真正跨到宿主的调用。`args` 以 JSON 字面量内联进 prelude。

确定性：run 的 `seed` 与 `startedAt` 存进 snapshot，resume 时原样复用（脚本看到的时钟与随机数回放）。宿主按 `seq` 顺序把结果交付给 VM（完成顺序随意、交付按序）；宿主侧看门狗在脚本 `runTimeoutMs`（默认 30 分钟）无进展时中止；堆上限 256MB；VM 会给出指纹（含 prelude hash、引擎版本、限制）。pi-codemode 自身还会让“等待一个永远无法 settle 的 promise”的脚本立即失败，而不是挂死。

### 3.2 meta 与工具面

`script.ts` 要求首句 `export const meta = {...}`，把 `export` 改写成 `const` 后交给沙箱（其余字节不动，报错行号与用户脚本一致）；meta 按 JSON 值严格解析（接受单引号、无引号键、尾逗号；拒绝模板串、标识符、调用），字段为 `name`（1-64 位 `[A-Za-z0-9._-]`）、非空 `description`、可选 `phases: string[]`、可选默认 `agent`。

模型侧工具名 `workflow`，参数 `action: start|resume|status` + `script | name | args | runId`。已保存工作流按 `.pi/workflows/<name>.js`、`$PI_CODING_AGENT_DIR/workflows/<name>.js` 顺序查找。工具描述内嵌 `WORKFLOW_GLOBAL_DECLARATIONS`，保证文档与运行时同源。

### 3.3 调度与上限

`manager.ts` 每个 runId 一个 `WorkflowRun`：`enqueue` 以 `defaultConcurrency() = max(2, min(16, CPUs-2))`（`PI_WORKFLOW_MAX_CONCURRENT_AGENTS` 可覆盖）排队执行 `agent()`；单 run 上限 `MAX_AGENTS_PER_RUN = 1000`，按**实际启动次数**计，超出抛 `WorkflowLimitError`（run 失败）。

失败语义分两类：**子代理死掉/失败**只是该次调用落为 `null`（`parallel`/`pipeline` 如此，裸 `await agent()` 也如此，与 CC 一致），同时记为 `failed`、面板显示错误、日志写一行、落定消息按名字列出；**参数写错**（未知 agent、拼错的选项、不满足的 schema、超限、预算用尽、cli 型 agent 要 schema）抛错并让 run 失败。被跳过的调用同样返回 `null`。

默认子代理是 `agents/workflow-subagent.md`（本仓库自带）。刻意不走“允许列表里的第一个”：`agents/` 里还有 `cli:` 型定义，那是外部 coding CLI，带自己的工具集和模型，不该被当成匿名调用的默认值。

每个 agent 的显示名唯一，并注册进插件既有名册，之后可用 `subagent_message` 找到它。

### 3.4 结构化输出

`agent({ schema })` 时，本次调用在 run 目录下建 `calls/<callKey>/`，写 `schema.json`、清掉上一轮的 `result.json`（重跑不能继承上次的答案）；子代理通过 `-e` 额外加载 `structured-output.ts`（`PI_SUBAGENT_SCHEMA_FILE` / `PI_SUBAGENT_RESULT_FILE` 环境变量），该扩展把 JSON Schema 的子集（object/array/enum/number/integer/boolean/null/string）转成 TypeBox 参数，注册必须调用一次的 `structured_output` 工具。结束后宿主读 `result.json`：缺失即记为 failed（“the agent finished without calling structured_output”），成功则 `agent()` 返回校验过的对象。

启动前先 lint schema：根必须是 `{type:'object', properties}`，`required` ⊆ `properties`——不满足的直接报错，而不是等烧完模型调用才失败。对 `cli:` 型 agent 要求 schema 也在启动前拒绝：那条路径不会加载 structured-output 扩展，错误信息只会误导成“子代理没调用工具”。

### 3.5 journal 与 resume

`journal.ts` 每个 run 一份 `journal.jsonl`，一行一次调用，键是内容哈希 `callKey = sha256(kind \0 label \0 agent \0 model \0 effort \0 prompt \0 schema)` 前 24 位（与完成顺序无关，乱序完成也能在 resume 时对上）；同一份内容在一次 run 里第 N 次出现会带上序号（`<hash>-1`、`-2`…），所以三个一模一样的 refuter 是三个调用而不是一个。model/effort 进键是必要的：把验证阶段换成强模型必须真的重跑，而不是把便宜模型的答案换个标签重放。条目在结果落定之后、交给脚本之前追加并落盘；解析失败的行只计数丢弃（只有最后一行可能残缺）。run 目录另有 `script.js`（原文）、`snapshot.json`（meta/args/seed/startedAt/status/result）、`output.json`、`lock`（`openSync wx`，持有者进程已死、或空锁超过 5 秒则回收）。

- `start`：新建 run 时自动找同名工作流、**且 args 相同**的最近一次可复用 run，把其中所有 `completed` 条目按 callKey 注入缓存——未改动的调用直接回放，并记一条日志说明复用了几个调用；`reuse: 'none'` 关掉它。要求 args 相同是因为 args 不在键里：参数变了还复用，等于拿上一次的答案回答新问题。
- `resume`：从磁盘读 snapshot 与 journal，重建缓存后重跑脚本；只回放 `completed`，失败/跳过/中止不回放（重试要真的重试）；拒绝仍在跑的 run（有锁或进程内未结束）。因此 resume 可以跨进程。可以传 `args` 覆盖、传 `script` 换上改过的脚本（写回 run 目录，下次 resume 继续用），预算沿用快照。
- 与 Claude Code 的差别：回放不按“最长不变量前缀”，而是按调用的内容键全局命中；脚本本身仍是整段重新执行，只是已完成的 `agent()` 在宿主侧回放。

### 3.6 预算

`budget.total` 来自 `PI_WORKFLOW_TOKEN_BUDGET`（manager 选项或 start 参数），默认 `null`；`spent()` 累加本次 run 各调用的 `usage.totalTokens`；`remaining()` 在 `total === null` 时返回 `Infinity`。

`spent()` / `remaining()` 返回**同步数字**（不是 Promise），并且在每次 `agent()` 结束后由 prelude 刷新——`while (budget.total && budget.remaining() > 50_000)` 这种写法必须真的能比较。超限有中止路径：下一个 `agent()` 抛 `WorkflowBudgetExceededError`，run 失败（不是只拒绝那一次调用——那样 `parallel` 会把异常吞成 `null`，循环继续跑到墙钟）。单位是子代理的**总** token（输入+输出）；CC 的预算是「+500k」指令分出来的输出 token 池，本实现没有那个池可共享，于是选了更保守的口径。

### 3.7 通知与可观测性

run 落定（completed/failed/aborted）时 `onSettled` 调 `pi.sendMessage({ customType: "workflow_result", display: true, ... }, { triggerTurn: true, deliverAs: "steer" })`：纯文本，含状态、完成数、tokens、错误、**按名字列出所有没有返回值的调用**、run/script/journal 路径、各 agent 的 session 文件、查看/恢复提示；结果 JSON 截断到 4,000 字符并指向 `output.json`。点名“空结果”的调用是必要的：只给计数时，“8/8 completed” 会被读成八个可用结果。工具返回值本身带 action / runId / status / progress / agents / runDir / scriptPath。

可观测性（`ui.ts` + `index.ts`）：

- 不设常驻 widget：早期版本在编辑器上方每秒重绘一行状态，既造成输入区域闪烁、又让已完成 run 的耗时随墙钟虚增；面板足够，已移除。
- 快捷键（默认 `ctrl+alt+w`）或 `/workflow` 打开覆盖面板；非 TUI 会话退化为文本报告。
- 面板一次显示一个 run（`[`/`]` 切换，标题右侧 `n/m`），排版照 Claude Code 的界面语言来：无边框、无分隔线、`❯` 指针选中、已完成行变暗、底部 dim 按键提示；不显示 runId。打开期间只要有活跃 run 就每秒重绘（内容没变则不重绘），已结束 run 的耗时按结束时刻冻结。
- 逐行展示每个调用：状态字形、label、实时活动（子代理窗口的同一句 status）、耗时、cached 标记、错误；**按 phase 分组**（同一 phase 字符串合成一组，组头是 dim 的阶段名；`view.phase` 是最后一次 `phase()` 调用，会与还在跑的早期阶段矛盾，所以不再出现在标题里）；run 自己的 `log()` 与运行时提示显示在标题下方（最多 3 条，被截断时标出还有多少条）。运行中/已结束的行可 focus（跳到该 agent 的 tmux 窗格）、message（发消息）、stop、skip；run 可 abort / resume，都既有菜单（回车）也有直按键（`f`/`m`/`x`/`s`/`a`/`r`）。`/workflow <runId>` 也能打开磁盘上的旧 run（和 `action:'status'` 一致）。每个 agent 就是一个独立 tmux 窗格里的真实 pi 会话，人可以直接看和输入。
- transcript 一侧同样是这套语言：工具调用行 `● Workflow(<名字>)`（内联脚本取其 `meta.name`，取不到写 `inline`），结果是 `⎿ 状态 · n agents planned (ctrl+o to expand)`；run 落定消息渲染成 `● <名字> · completed in 2m04s` + `⎿ n agents · n done · tokens · $cost`，`ctrl+o` 展开 run id、脚本路径和脚本返回值。

## 4. 逐项对照表

| 行为 | Claude Code | 本实现 | 差异说明 |
|---|---|---|---|
| 脚本语言与 meta | 纯 JS（非 TS）；`export const meta = {name, description, phases:[{title, detail?}], whenToUse?, ...}`（纯字面量） | 纯 JS；`export const meta = {name, description, phases: Array<string \| {title, detail?, model?}>, whenToUse?, agent?}`（纯 JSON 字面量，`export` 被改写为 `const`） | phases 两种写法都接受；本实现多一个默认 agent 字段；`whenToUse` 已接受但还没有展示列表；校验方式不同（JSON 字面量解析 vs 专用 validator） |
| `agent()` 参数 | label、phase、schema、model、effort、isolation:`worktree`、agentType | label、phase、schema、agent / agentType（同名）、model、effort | 本实现无 worktree 隔离（传 `isolation` 明确报“未实现”，不静默忽略）；`effort` 与 `model` 分开下传，因此 `{ effort: 'low' }` 单独可用；未知选项一律报错 |
| parallel / pipeline | 宿主提供的原语；pipeline 无 barrier、抛错项变 null；文档默认 pipeline | 同一语义，在脚本 prelude 内实现（纯 Promise 编排），`agent()` 是唯一跨宿主调用 | 语义一致，实现位置不同；两边都把 pipeline 作为默认写法 |
| 结构化输出 | 强制调用 `StructuredOutput` 工具，ajv 在工具层校验并在不匹配时重试；`agent()` 返回校验后的对象 | 子代理加载 `structured-output` 扩展，把结果写入 sidecar `result.json`；JSON Schema 子集转 TypeBox | 本实现没有 ajv 级全量校验与“模型重试纠正”；缺结果/写失败时该次调用记为 failed；schema 转换有损（未覆盖的类型退化为 Unknown） |
| journal 与 resume | journal.jsonl；resume 按“最长不变量前缀”回放；仅同会话，需显式 `resumeFromRunId`；无 journal 时手工续写 | journal.jsonl；按键回放（键含 label/prompt/schema/agent/model/effort + 出现次序）；磁盘 journal + 锁，可跨进程 resume；`start` 在同名**且同 args** 时复用上一次的 completed 条目 | 回放粒度不同（前缀 vs 键）；本实现多出跨进程 resume 与隐式复用，并可 `reuse:'none'` 关掉；相同内容的多次调用不再折叠成一个 |
| 并发上限 | `min(16, max(2, CPUs-2))`；`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` 可覆盖 | 同一公式；`PI_WORKFLOW_MAX_CONCURRENT_AGENTS` 可覆盖（也认 CC 那个变量名） | 数值一致，覆盖口也一致 |
| 单次 items 上限 | 单个 parallel/pipeline 最多 4,096 项，超出显式报错 | `MAX_ITEMS_PER_BATCH = 4096`，由 prelude 中的 `__wfCheckBatch` 在调用前校验并抛错 | 数值一致；报错文案不同 |
| agent 总数上限 | 生命周期 1,000（`WorkflowAgentCapError`，附预算循环提示） | `MAX_AGENTS_PER_RUN = 1000`，按**实际启动次数**计，超出抛 `WorkflowLimitError`，run 失败 | 数值一致；本实现按启动次数而不是去重后的键数，否则反复发同一个调用的死循环撞不到上限 |
| 嵌套 | 允许一层：子工作流里再调 `workflow()` 才抛错 | 未实现：`workflow()` 桥接直接抛错（“nested workflows are not supported by this build yet”） | 本实现是 0 层 |
| 预算 | 来自用户 “+500k” 指令的共享池；硬上限，超限抛 `WorkflowBudgetExceededError` | `budget.total` 来自 `PI_WORKFLOW_TOKEN_BUDGET`（未设置时为 null）；`spent()`/`remaining()` 是**同步数字**、每次 `agent()` 后刷新；超限让 run 失败 | 本实现没有可共享的按轮预算池；单位是总 token（输入+输出）而非输出 token；同样强制中止 |
| 取消 / 跳过 | 跳过 → `null`；死掉的 agent → `null`；kill/pause + 恢复提示；用量限额自动暂停等待 | 跳过 → `null`；**失败/死掉的 agent → `null`**（记 failed，面板显示错误，落定消息按名字列出）；参数写错则整 run 失败；abort 停止运行中 agent 并中止 VM；无暂停态 | 失败语义已对齐 CC；本实现无 rate-limit 暂停与 pause 恢复，多出逐 agent 的交互干预 |
| 通知 | `<task-notification>` XML（task-id/status/summary/recovery/diagnostics/usage 等）+ “Dynamic workflow … completed/failed/was stopped” | `pi.sendMessage` 自定义消息（customType `workflow_result`），纯文本：状态、完成数、tokens、错误、按名字列出没有返回值的调用、run/script/journal 路径与各 agent 的 session 文件、查看/恢复提示；结果 JSON 截断到 4,000 字符并标出 output.json | 传输方式与结构不同；本实现也点名了每个“空结果”的调用，而不是只给计数 |
| 可观测性 | `/workflows` 进度页、task 进度事件（phase/log/agent 状态）、transcript 目录与 journal；子代理无交互面板 | `/workflow` 覆盖面板 + 快捷键（无常驻 widget：轮询渲染会闪烁，已移除）：按 phase 分组、显示 run 日志、`[`/`]` 切 run、磁盘上的旧 run 也能打开；每个 agent 是独立 tmux 窗格里的真实 pi 会话，可 focus/steer/stop/skip | 本实现的可观测性与可操作性更强（正是本插件的取舍：更重、可看可接管） |
| 脚本隔离 | 无 fs/Node API；AST 检查禁止 `Date.now()`/`Math.random()`/`new Date()`；在 Claude Code 进程内执行 | QuickJS WASM worker 线程；无 fs/网络/定时器/`require`/`process`；时钟与随机数由 run 的 `startedAt`/`seed` 决定；30 分钟无进展看门狗、256MB 堆上限 | 隔离更强、可强杀；两边都用“禁止非确定性 API”保证回放确定性 |

## 5. 已知差异与后续工作

- **嵌套未实现**：prelude 与工具描述声明了 `workflow(name, args)`，桥接层直接抛错，工具描述里已明说“声明了但总是抛错，请内联”。要么实现子 run（复用 manager、共享并发与计数），要么彻底从全局声明里去掉。
- **逐次调用超时**：`timeoutMs` 已从脚本 API 中移除（它此前只被解析、从未下传），调用粒度的超时由子代理自身的重试/卡住状态与整体 `scriptTimeoutMs` 兜底；传进来会被当作未知选项报错，而不是静默丢弃。
- **预算强制但单位自定**：`PI_WORKFLOW_TOKEN_BUDGET` 超限会让 run 失败。单位是子代理的**总** token（输入+输出），不是 CC 的输出 token——CC 的预算是「+500k」指令分出来的输出 token 池，本实现没有那个池可共享，于是选了更保守的口径。差异是刻意的，已写进 `docs/workflow.md`。
- **resume 语义与 CC 不同**：本实现按键全局回放，脚本若有文本之外的副作用（写文件、外部状态），回放的等价性与 CC 的“前缀”模型不同。这是刻意的取舍（按键回放才能跨进程 resume），已文档化；键里现在包含 model/effort 与出现次序。
- **无用量限额暂停**：CC 在 rate limit 时暂停工作流、限额恢复后重跑等待中的 agent；本实现下这是一次普通失败（子代理内部的自动重试不受影响）。**在 pi 里做不到**：`WorkflowSubagentCompletion` 只暴露 exitCode/summary/error/usage，没有限额信号，得先把信号从子会话里传出来。
- **无保存工作流/内置工作流/运行前审批**：CC 有 `.claude/workflows/`、内置 `deep-research`、`/workflows` 保存与展示 `meta.phases` 的权限对话框；本实现只有 `.pi/workflows` 查找与 subagent 的既有权限模型。审批这一条是刻意的——本插件靠子代理既有的权限模型加上人盯着窗格。
- **无 worktree 隔离**：并行改文件的 agent 会互相踩；CC 的 `isolation:'worktree'` 没有对应实现。传 `isolation` 会被明确拒绝（“未实现”），而不是静默忽略。
- **无 `whenToUse` 展示列表 / 无 `list` 动作**：`meta.whenToUse` 已被接受并保存，但还没有一个“列出可用 workflow”的入口来展示它。

## 如何自行复核

1. 复制二进制到只读副本（不要改原文件），所有操作在副本上做。
2. 用 `grep -a -b -o '<片段>' <副本>` 拿字节偏移，`tail -c +<偏移> <副本> | head -c <长度>` 切片看原文；`strings` 用于粗看。
3. 关键片段示例：`grep -a -o 'Execute a workflow script'`（工具描述模板，全文仅 1 处）；`grep -a -o 'longest unchanged'`（resume 语义，仅 1 处）；`grep -a -o 'DEFAULT TO pipeline'`（authoring reference）；负结果同样要记录，如 `grep -a -c 'Triggering condition'` 为 0。
4. 本实现一侧按第 3 节给出的文件逐条对照源码；`test/workflow.test.ts` 覆盖了并发上限、1,000 agent 上限、journal 与 resume 的主干路径。
