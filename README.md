# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in tmux panes. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**tmux-only fork.** See [Acknowledgements](#acknowledgements) for the upstream project, which also supports cmux, zellij, and WezTerm.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own tmux pane — a right split off the parent pi pane, so pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Panes are kept evenly sized: the extension re-applies an `even-horizontal` layout after every spawn and exit (debounced). The layout is a single constant, `SUBAGENT_TMUX_LAYOUT` in `pi-extension/subagents/tmux.ts` — change it to any named tmux layout (`main-vertical`, `tiled`, …).

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated tmux pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is typed into the live pane (newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openrouter/z-ai/glm-5.3` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | `openrouter/z-ai/glm-5.3` | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | `openrouter/z-ai/glm-5.3` | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Review workflow

Use `/subagent review <scope and requirements>` to run independent correctness and combined
code-quality/simplicity reviewers in parallel. The review orchestrator
collects and deduplicates their findings, then asks a verifier to validate
candidates before returning one report. Review does not apply fixes or run tests; it may read existing test code and results.

The four definitions are bundled in `agents/`; no global agent links are needed.
See [review workflow](docs/review-workflow.md) for usage, configuration, and sources.

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI, `codex` via the OpenAI codex CLI — instead of pi. See [CLI-backed agents](#cli-backed-agents) |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### CLI-backed agents

Set `cli: claude` or `cli: codex` to run the subagent as an external coding-agent CLI in its own pane instead of a pi child process. The CLI's own auth/config apply; pi tools, `tools:` allowlists, and `subagent_agents` are ignored.

Both backends run their **native interactive TUI** in a tmux pane. Use the same
`subagent`, `subagent_message`, and `subagents_list` tools as for pi agents:

```json
{ "agent": "codex-cli", "name": "implement", "task": "Implement and verify the change" }
```

Send `subagent_message({ name: "implement", message: "Also handle empty input" })`
to paste one message into the running TUI, or resume its native conversation when
it has finished. Names and native session IDs persist across parent restarts.
The bundled `claude-cli` profile works the same way and uses Claude's default model.

| | `cli: claude` | `cli: codex` |
| --- | --- | --- |
| Binary | PATH, `~/.local/bin`, or `PI_CLAUDE_BIN` | PATH, ChatGPT.app, or `PI_CODEX_BIN` |
| Identity append | `--append-system-prompt` | `developer_instructions` |
| Identity replace | `--system-prompt` | `model_instructions_file` |
| Thinking | `--effort` (use a level supported by Claude) | `model_reasoning_effort` |
| Completion | invocation-local SessionStart / Stop / StopFailure hooks | invocation-local `notify` callback |
| Resume | `claude --resume <session-id>` | `codex resume <thread-id>` |

`auto-exit: true` returns the final response and closes the pane after the turn
and all submitted follow-ups have completed. With `auto-exit: false`, the native UI stays open; its latest response is
returned when the user exits. If the pane is forcibly closed, the last completed
response is retained alongside the interruption and any pending-input notice. Follow-ups to finished sessions run autonomously.
Multiple-line messages use tmux bracketed paste, preserving them as one prompt.
CLI panes have no surrounding shell that could execute leftover input.

The parent-facing pi transcript records submitted tasks and final responses;
`<session>.cli.json` stores the backend, exact native ID, cwd, model and identity.
Full native history remains in the CLI's own storage. Each invocation's prompt,
launch script, hook settings, submitted prompts, notification events and structured result live under the parent's
`artifacts/<session-id>/cli-runs/`. No global CLI configuration is rewritten.

CLI profiles use the CLI's own credentials and native tools. Claude reads its
normal settings, including cc-switch's `env` (base URL, authentication, and
Opus/Sonnet/Haiku model aliases). The bundled `claude-cli` profile does not set
`model`, so cc-switch remains in control; an explicit profile `model` is passed
to Claude as an intentional override. The bridge never substitutes Anthropic
credentials or routes the request through pi's model provider. The same unrestricted
execution flags as the previous integration are used. Pi-specific tool allowlists,
skills and `subagent_agents` do not configure native CLI tools. Run the CLI once
to complete login/onboarding before using it as a subagent. `session-mode: fork`
remains unsupported: native CLIs cannot load pi's conversation format. Use
`lineage-only` or `standalone` and include relevant context in the task.
Native progress currently uses an elapsed-time status, rather than pi tool activity.

Codex's internal title-generation threads also emit `notify` callbacks. The bridge
binds the native thread only after a notification matches the submitted task,
then accepts only that thread's results. Internal title responses cannot complete
or close the worker. Submitted follow-ups are tracked across completed turns:
with `auto-exit: true`, the pane stays open until every submitted prompt has been
processed, including prompts queued for the next turn. Submitting a message and
publishing completion are serialized to avoid losing a message at the turn
boundary. Exiting with pending prompts reports a failure.
Directory trust is passed as an invocation-local TOML table. Each task, follow-up
and resume prompt sent to Codex carries a unique receipt in an HTML comment;
pi's session records retain the original task text. Completion matches outstanding
receipts directly, so repeated messages work with both cumulative and turn-local
notifications, without guessing the format or storing native history snapshots.
Old receipts cannot acknowledge new requests. Claude completion checks only the
transcript path supplied by its hook: user messages and human `queued_command`
attachments before the final
assistant entry count as processed; queue enqueue records do not. SessionStart
records a baseline so previous conversation inputs cannot satisfy new requests.

### Verification

`npm test` runs the regression and native hook tests without model requests.
`npm run test:cli-integration` exercises the actual extension tools in an isolated
tmux session with deterministic stand-in CLIs (no credentials or model calls).

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [tmux](https://github.com/tmux/tmux)

```bash
tmux new -A -s pi 'pi'
```

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
