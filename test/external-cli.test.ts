import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, rmdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { prepareExternalLaunch, prepareExternalPrompt, readExternalSession, writeExternalSession, isExternalCliKind, type ExternalCliSession } from "../pi-extension/subagents/external-cli.ts";
import { handleCliEvent, readCliExitResult, withCliRunLockAsync } from "../pi-extension/subagents/cli-hook.mjs";

function fixture(kind: "claude" | "codex", run: (f: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), "pi-cli-test-"));
  const sessionFile = join(dir, "session.jsonl");
  const resultFile = join(dir, "result.json");
  const session: ExternalCliSession = { version: 1, kind, nativeId: kind === "claude" ? "claude-id" : null,
    cwd: dir, model: null, thinking: null, identity: null, systemPromptMode: null, autoExit: true };
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "pi-id" }) + "\n");
  writeExternalSession(sessionFile, session);
  try { run({ dir, sessionFile, resultFile, session }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
describe("native CLI hooks", () => {
  it("baselines complete history at SessionStart and accepts a completed record without a newline", () => fixture("claude", f => {
    const transcript = join(f.dir, "transcript.jsonl");
    const oldInput = { type: "user", uuid: "old", message: { content: "old task" } };
    writeFileSync(transcript, JSON.stringify(oldInput) + '\n' + JSON.stringify({ type: "assistant", uuid: "old-answer", message: { content: [] } }) + '\n{"type":');
    handleCliEvent("claude", f.sessionFile, f.resultFile, "auto", { hook_event_name: "SessionStart", session_id: "claude-id", transcript_path: transcript });
    assert.deepEqual(JSON.parse(readFileSync(`${f.resultFile}.claude-seen.json`, "utf8")), ["old"]);
    writeFileSync(`${f.resultFile}.inputs.json`, JSON.stringify(["new task"]));
    writeFileSync(transcript, [oldInput,
      { type: "user", uuid: "new", message: { content: "new task" } },
      { type: "assistant", uuid: "answer", message: { content: [{ type: "text", text: "done" }] } },
    ].map(x => JSON.stringify(x)).join("\n"));
    handleCliEvent("claude", f.sessionFile, f.resultFile, "auto", { hook_event_name: "Stop", session_id: "claude-id", transcript_path: transcript, last_assistant_message: "done" });
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).summary, "done");
  }));
  it("does not silently accept malformed complete transcript records", () => fixture("claude", f => {
    const transcript = join(f.dir, "transcript.jsonl");
    writeFileSync(transcript, 'invalid JSON\n');
    assert.throws(() => handleCliEvent("claude", f.sessionFile, f.resultFile, "auto", {
      hook_event_name: "SessionStart", session_id: "claude-id", transcript_path: transcript }), SyntaxError);
  }));

  it("can be imported by a Node stdin program", () => {
    const hook = new URL("../pi-extension/subagents/cli-hook.mjs", import.meta.url).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "-"],
      { input: `import { readCliExitResult } from ${JSON.stringify(hook)}; console.log(typeof readCliExitResult);`, encoding: "utf8" });
    assert.equal(output.trim(), "function");
  });
  it("keeps a completed Claude response when the transcript has an unfinished tail", () => fixture("claude", f => {
    const transcript = join(f.dir, "transcript.jsonl");
    writeFileSync(`${f.resultFile}.inputs.json`, JSON.stringify(["task"]));
    writeFileSync(transcript, [
      { type: "user", uuid: "u1", message: { content: "task" } },
      { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "done" }] } },
    ].map(x => JSON.stringify(x)).join("\n") + '\n{"type":');
    handleCliEvent("claude", f.sessionFile, f.resultFile, "auto", {
      hook_event_name: "Stop", session_id: "claude-id", transcript_path: transcript, last_assistant_message: "done", prompt_id: "p1" });
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).summary, "done");
  }));
  it("recovers an older Claude response without payload text from a transcript with an unfinished tail", () => fixture("claude", f => {
    const transcript = join(f.dir, "transcript.jsonl");
    writeFileSync(`${f.resultFile}.inputs.json`, JSON.stringify(["task"]));
    writeFileSync(transcript, [
      { type: "user", uuid: "u1", message: { content: "task" } },
      { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "done" }] } },
    ].map(x => JSON.stringify(x)).join("\n") + '\n{"type":');
    handleCliEvent("claude", f.sessionFile, f.resultFile, "auto", {
      hook_event_name: "Stop", session_id: "claude-id", transcript_path: transcript, prompt_id: "p1" });
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).summary, "done");
  }));
  it("does not append or replace the answer for a repeated Claude prompt_id", () => fixture("claude", f => {
    const event = { hook_event_name: "Stop", session_id: "claude-id", prompt_id: "p1", last_assistant_message: "first answer" };
    handleCliEvent("claude", f.sessionFile, f.resultFile, "interactive", event);
    const session = readFileSync(f.sessionFile, "utf8");
    const latest = readFileSync(`${f.resultFile}.latest`, "utf8");
    handleCliEvent("claude", f.sessionFile, f.resultFile, "interactive", { ...event, last_assistant_message: "duplicate" });
    assert.equal(readFileSync(f.sessionFile, "utf8"), session);
    assert.equal(readFileSync(`${f.resultFile}.latest`, "utf8"), latest);
    handleCliEvent("claude", f.sessionFile, f.resultFile, "interactive", { ...event, prompt_id: "p2", last_assistant_message: "next answer" });
    assert.equal(JSON.parse(readFileSync(`${f.resultFile}.latest`, "utf8")).summary, "next answer");
  }));

  it("runs the executable hook through a symbolic link", () => fixture("claude", f => {
    const hookLink = join(f.dir, "hook.mjs");
    symlinkSync(join(import.meta.dirname, "../pi-extension/subagents/cli-hook.mjs"), hookLink);
    execFileSync(process.execPath, [hookLink, "claude", f.sessionFile, f.resultFile, "auto"],
      { input: JSON.stringify({ hook_event_name: "Stop", session_id: "claude-id", last_assistant_message: "linked hook response" }), stdio: "pipe" });
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).summary, "linked hook response");
  }));

  it("yields while the parent waits for a run lock and releases it on failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-cli-lock-"));
    const resultFile = join(dir, "result.json"), lock = `${resultFile}.lock`;
    mkdirSync(lock);
    const timer = setTimeout(() => rmdirSync(lock), 25);
    try {
      await assert.rejects(withCliRunLockAsync(resultFile, () => { throw new Error("action failed"); }), /action failed/);
      assert.equal(existsSync(lock), false);
      assert.equal(await withCliRunLockAsync(resultFile, () => "next action"), "next action");
    } finally { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); }
  });
  it("uses the main Claude response when the fallback transcript ends in a sidechain", () => fixture("claude", f => {
    const transcript = join(f.dir, "transcript.jsonl");
    const user = { type: "user", uuid: "input", message: { content: "task" } };
    const assistant = (text: string, isSidechain: boolean) => ({ type: "assistant", isSidechain,
      message: { content: [{ type: "text", text }] } });
    writeFileSync(transcript, [user, assistant("main answer", false), assistant("child answer", true)].map(x => JSON.stringify(x)).join("\n") + "\n");
    handleCliEvent("claude", f.sessionFile, f.resultFile, "auto", { hook_event_name: "Stop", session_id: "claude-id", transcript_path: transcript });
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).summary, "main answer");
  }));

  it("retains the latest answer and pending work after an interrupted exit", () => fixture("codex", f => {
    writeFileSync(`${f.resultFile}.inputs.json`, JSON.stringify(["first", "queued"]));
    writeFileSync(`${f.resultFile}.latest`, JSON.stringify({ summary: "first answer", completedInputs: ["first"], nativeId: "native" }));
    const result = readCliExitResult(f.resultFile, 1, "Pane closed");
    assert.equal(result.exitCode, 1);
    assert.equal(result.nativeId, "native");
    assert.match(result.summary, /first answer/);
    assert.match(result.summary, /Pane closed/);
    assert.match(result.summary, /1 submitted prompt.*pending/);
  }));
  it("reports executable hook errors without replacing a canonical result", () => fixture("claude", f => {
    writeFileSync(f.resultFile, JSON.stringify({ summary: "finished", exitCode: 0 }));
    assert.throws(() => execFileSync(process.execPath, [join(import.meta.dirname, "../pi-extension/subagents/cli-hook.mjs"),
      "claude", f.sessionFile, f.resultFile, "auto"], { input: "invalid JSON", stdio: "pipe" }));
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).summary, "finished");
    assert.ok(JSON.parse(readFileSync(`${f.resultFile}.hook-error`, "utf8")).errorMessage);
  }));
  it("rejects valid JSON metadata with an unsupported CLI kind", () => fixture("codex", f => {
    writeFileSync(`${f.sessionFile}.cli.json`, JSON.stringify({ ...f.session, kind: "codexx" }));
    assert.throws(() => readExternalSession(f.sessionFile), /Unsupported or invalid native CLI session metadata/);
  }));
  it("distinguishes missing metadata from damaged metadata", () => fixture("codex", f => {
    assert.equal(readExternalSession(join(f.dir, "missing")), null);
    writeFileSync(`${f.sessionFile}.cli.json`, "invalid JSON");
    assert.throws(() => readExternalSession(f.sessionFile), /cli.json/);
  }));

  it("captures the exact Codex thread and response without searching concurrent rollouts", () => fixture("codex", f => {
    handleCliEvent("codex", f.sessionFile, f.resultFile, "auto", { type: "agent-turn-complete", "thread-id": "thread-a", "turn-id": "turn-a", "last-assistant-message": "done" });
    assert.equal(readExternalSession(f.sessionFile)?.nativeId, "thread-a");
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).summary, "done");
    handleCliEvent("exit", f.sessionFile, f.resultFile, "1", {});
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).exitCode, 0);
  }));
  it("ignores internal Codex title turns before accepting the main thread ID", () => fixture("codex", f => {
    writeFileSync(`${f.resultFile}.inputs.json`, JSON.stringify(["Implement the task"]));
    handleCliEvent("codex", f.sessionFile, f.resultFile, "auto", {
      type: "agent-turn-complete", "thread-id": "internal-title-thread",
      "input-messages": ["Generate a title for this conversation"],
      "last-assistant-message": '{"title":"Task title"}' });
    assert.equal(existsSync(f.resultFile), false);
    assert.equal(readExternalSession(f.sessionFile)?.nativeId, null);
    handleCliEvent("codex", f.sessionFile, f.resultFile, "auto", {
      type: "agent-turn-complete", "thread-id": "main-thread",
      "input-messages": ["Implement the task"], "last-assistant-message": "Actual work completed" });
    assert.equal(readExternalSession(f.sessionFile)?.nativeId, "main-thread");
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).summary, "Actual work completed");
  }));
  it("captures native interactive turns on the bound Codex thread", () => fixture("codex", f => {
    writeFileSync(`${f.resultFile}.inputs.json`, JSON.stringify(["Initial task"]));
    handleCliEvent("codex", f.sessionFile, f.resultFile, "interactive", {
      type: "agent-turn-complete", "thread-id": "main-thread", "turn-id": "1",
      "input-messages": ["Initial task"], "last-assistant-message": "First response" });
    handleCliEvent("codex", f.sessionFile, f.resultFile, "interactive", {
      type: "agent-turn-complete", "thread-id": "title-thread", "turn-id": "title",
      "input-messages": ["Generate a title"], "last-assistant-message": "Wrong response" });
    handleCliEvent("codex", f.sessionFile, f.resultFile, "interactive", {
      type: "agent-turn-complete", "thread-id": "main-thread", "turn-id": "2",
      "input-messages": ["Typed directly into the native CLI"], "last-assistant-message": "Latest response" });
    handleCliEvent("exit", f.sessionFile, f.resultFile, "0", {});
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).summary, "Latest response");
  }));
  for (const history of ["turn-local", "cumulative", "local then cumulative", "cumulative then local"] as const) {
    it(`acknowledges identical Codex follow-ups with ${history} callbacks exactly once`, () => fixture("codex", f => {
      const prompts = ["initial", "continue", "continue"].map(text => prepareExternalPrompt("codex", text));
      writeFileSync(`${f.resultFile}.inputs.json`, JSON.stringify(prompts));
      const inputs = (n: number) => {
        const cumulative = history === "cumulative" ||
          (history === "local then cumulative" && n === 2) ||
          (history === "cumulative then local" && n === 1);
        return cumulative ? prompts.slice(0, n + 1) : [prompts[n]];
      };
      const complete = (turn: string, inputs: string[]) => handleCliEvent("codex", f.sessionFile, f.resultFile, "auto", {
        type: "agent-turn-complete", "thread-id": "main", "turn-id": turn,
        "input-messages": inputs, "last-assistant-message": `response ${turn}` });
      complete("1", inputs(0));
      assert.equal(existsSync(f.resultFile), false);
      complete("2", inputs(1));
      complete("1", inputs(0));
      complete("2", inputs(1));
      // An old receipt remains old even if repeated under a different turn ID.
      complete("unrelated", [prompts[1], "continue"]);
      assert.equal(existsSync(f.resultFile), false);
      const latest = JSON.parse(readFileSync(`${f.resultFile}.latest`, "utf8"));
      assert.deepEqual(latest.completedInputs, prompts.slice(0, 2));
      complete("3", inputs(2));
      assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).summary, "response 3");
      assert.equal(readFileSync(f.sessionFile, "utf8").trim().split("\n").length, 5);
      assert.equal("codexInputMessages" in readExternalSession(f.sessionFile)!, false);
    }));
  }
  it("does not count old cumulative Codex input as a newly submitted identical prompt", () => fixture("codex", f => {
    const first = prepareExternalPrompt("codex", "repeat");
    const second = prepareExternalPrompt("codex", "repeat");
    writeFileSync(`${f.resultFile}.inputs.json`, JSON.stringify([first]));
    handleCliEvent("codex", f.sessionFile, f.resultFile, "interactive", {
      type: "agent-turn-complete", "thread-id": "main", "turn-id": "1",
      "input-messages": [first], "last-assistant-message": "first" });
    writeFileSync(`${f.resultFile}.inputs.json`, JSON.stringify([first, second]));
    handleCliEvent("codex", f.sessionFile, f.resultFile, "auto", {
      type: "agent-turn-complete", "thread-id": "main", "turn-id": "2",
      "input-messages": [first, "repeat"], "last-assistant-message": "manual" });
    assert.equal(existsSync(f.resultFile), false);
    handleCliEvent("codex", f.sessionFile, f.resultFile, "auto", {
      type: "agent-turn-complete", "thread-id": "main", "turn-id": "3",
      "input-messages": [first, "repeat", second], "last-assistant-message": "second repeat" });
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).summary, "second repeat");
  }));
  it("ignores old Codex receipts on resume and acknowledges a repeated task with truncated history", () => fixture("codex", f => {
    const oldPrompt = prepareExternalPrompt("codex", "continue");
    const newPrompt = prepareExternalPrompt("codex", "continue");
    writeFileSync(`${f.resultFile}.inputs.json`, JSON.stringify([oldPrompt]));
    handleCliEvent("codex", f.sessionFile, f.resultFile, "auto", {
      type: "agent-turn-complete", "thread-id": "main", "turn-id": "old",
      "input-messages": [oldPrompt], "last-assistant-message": "old done" });
    const resumedResult = join(f.dir, "resumed.json");
    writeFileSync(`${resumedResult}.inputs.json`, JSON.stringify([newPrompt]));
    // Neither a replay nor historical input in a new turn can acknowledge the
    // new request, even though all three have the same task text.
    for (const turn of ["old", "manual"]) handleCliEvent("codex", f.sessionFile, resumedResult, "auto", {
      type: "agent-turn-complete", "thread-id": "main", "turn-id": turn,
      "input-messages": [oldPrompt, "continue"], "last-assistant-message": "old input only" });
    assert.equal(existsSync(resumedResult), false);
    handleCliEvent("codex", f.sessionFile, resumedResult, "auto", {
      type: "agent-turn-complete", "thread-id": "foreign", "turn-id": "wrong",
      "input-messages": [newPrompt], "last-assistant-message": "wrong thread" });
    assert.equal(existsSync(resumedResult), false);
    handleCliEvent("codex", f.sessionFile, resumedResult, "auto", {
      type: "agent-turn-complete", "thread-id": "main", "turn-id": "new",
      "input-messages": [newPrompt], "last-assistant-message": "new done" });
    handleCliEvent("exit", f.sessionFile, resumedResult, "0", {});
    assert.equal(JSON.parse(readFileSync(resumedResult, "utf8")).summary, "new done");
    assert.equal(JSON.parse(readFileSync(resumedResult, "utf8")).exitCode, 0);
  }));
  it("waits for Claude processed transcript inputs, excluding resume history and queued tail", () => fixture("claude", f => {
    const transcript = join(f.dir, "native.jsonl");
    const entries: any[] = [{type:"user", uuid:"old", message:{content:"follow-up"}},
      {type:"assistant", uuid:"old-answer", message:{content:[]}}];
    const save = () => writeFileSync(transcript, entries.map(e => JSON.stringify(e)).join("\n")+"\n");
    save();
    writeFileSync(`${f.resultFile}.inputs.json`, JSON.stringify(["initial", "follow-up", "follow-up"]));
    handleCliEvent("claude", f.sessionFile, f.resultFile, "auto", {
      hook_event_name: "SessionStart", session_id: "claude-id", transcript_path: transcript });
    const stop = (summary: string) => handleCliEvent("claude", f.sessionFile, f.resultFile, "auto", {
      hook_event_name: "Stop", session_id: "claude-id", transcript_path: transcript, last_assistant_message: summary });
    entries.push({type:"user",uuid:"initial",message:{content:"initial"}}, {type:"assistant",uuid:"a1"}); save();
    stop("first"); assert.equal(existsSync(f.resultFile), false);
    entries.push({type:"queue-operation",operation:"enqueue",content:"follow-up"}); save();
    stop("still queued"); assert.equal(existsSync(f.resultFile), false);
    entries.push({type:"attachment",uuid:"second",attachment:{type:"queued_command",prompt:"follow-up",origin:{kind:"human"},commandMode:"prompt"}}, {type:"assistant",uuid:"a2"}); save();
    stop("second"); assert.equal(existsSync(f.resultFile), false);
    stop("duplicate stop"); assert.equal(existsSync(f.resultFile), false);
    entries.push({type:"user",uuid:"third",message:{content:"follow-up"}}); save();
    stop("queued tail"); assert.equal(existsSync(f.resultFile), false);
    entries.push({type:"assistant",uuid:"a3"}); save();
    stop("third");
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).summary, "third");
  }));
  it("does not report a successful native exit with queued prompts still outstanding", () => fixture("codex", f => {
    writeFileSync(`${f.resultFile}.inputs.json`, JSON.stringify(["initial", "queued"]));
    handleCliEvent("codex", f.sessionFile, f.resultFile, "auto", {
      type: "agent-turn-complete", "thread-id": "main", "turn-id": "1",
      "input-messages": ["initial"], "last-assistant-message": "first done" });
    handleCliEvent("exit", f.sessionFile, f.resultFile, "0", {});
    const result = JSON.parse(readFileSync(f.resultFile, "utf8"));
    assert.equal(result.exitCode, 1);
    assert.match(result.summary, /1 submitted prompt.*pending/);
  }));
  it("completes Claude resumed and steered turns without counting human messages", () => fixture("claude", f => {
    handleCliEvent("claude", f.sessionFile, f.resultFile, "auto", { hook_event_name: "Stop", session_id: "claude-id", stop_hook_active: true, last_assistant_message: "follow-up done" });
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).summary, "follow-up done");
    assert.equal(readFileSync(f.sessionFile, "utf8").trim().split("\n").length, 2);
  }));
  it("keeps interactive sessions open and returns the latest turn on exit", () => fixture("codex", f => {
    for (const n of [1, 2]) handleCliEvent("codex", f.sessionFile, f.resultFile, "interactive", {
      type: "agent-turn-complete", "thread-id": "thread-a", "turn-id": `turn-${n}`, "last-assistant-message": `answer-${n}` });
    assert.equal(existsSync(f.resultFile), false);
    handleCliEvent("exit", f.sessionFile, f.resultFile, "0", {});
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).summary, "answer-2");
  }));
  it("reports Claude API failure as failure and ignores foreign sessions", () => fixture("claude", f => {
    handleCliEvent("claude", f.sessionFile, f.resultFile, "auto", { hook_event_name: "Stop", session_id: "foreign", last_assistant_message: "wrong" });
    assert.equal(existsSync(f.resultFile), false);
    handleCliEvent("claude", f.sessionFile, f.resultFile, "auto", { hook_event_name: "StopFailure", session_id: "claude-id", error: "rate_limit" });
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).exitCode, 1);
  }));
  for (const transcriptState of ["truncated", "unreadable", "previous response"] as const) {
    it(`reports Claude StopFailure with a ${transcriptState} transcript`, () => fixture("claude", f => {
      const transcript = transcriptState === "unreadable" ? f.dir : join(f.dir, "native.jsonl");
      if (transcriptState === "truncated") {
        writeFileSync(transcript, '{"type":"assistant","message":{"content":[]}}\n{"type":');
      } else if (transcriptState === "previous response") {
        writeFileSync(transcript, JSON.stringify({ type: "assistant",
          message: { content: [{ type: "text", text: "An earlier successful response" }] } }) + "\n");
      }
      writeFileSync(`${f.resultFile}.inputs.json`, JSON.stringify(["initial", "queued"]));
      const event = { hook_event_name: "StopFailure", session_id: "claude-id",
        transcript_path: transcript, error: "rate_limit", error_details: "Provider rate limit exceeded" };
      // Exercise the executable hook too: it must exit cleanly so the native
      // TUI can continue while the watcher receives a structured failure.
      execFileSync(process.execPath, [join(import.meta.dirname, "../pi-extension/subagents/cli-hook.mjs"),
        "claude", f.sessionFile, f.resultFile, "interactive"],
        { input: JSON.stringify(event), stdio: ["pipe", "pipe", "pipe"] });
      const result = JSON.parse(readFileSync(f.resultFile, "utf8"));
      assert.equal(result.exitCode, 1);
      assert.equal(result.nativeId, "claude-id");
      assert.equal(result.summary, "Claude Code error: Provider rate limit exceeded");
      const entries = readFileSync(f.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(entries.at(-1).message.stopReason, "error");
      handleCliEvent("exit", f.sessionFile, f.resultFile, "0", {});
      assert.deepEqual(JSON.parse(readFileSync(f.resultFile, "utf8")), result);
    }));
  }
  it("preserves a launch failure even when no completion hook ran", () => fixture("codex", f => {
    handleCliEvent("exit", f.sessionFile, f.resultFile, "127", {});
    assert.equal(JSON.parse(readFileSync(f.resultFile, "utf8")).exitCode, 127);
  }));
});
describe("native CLI command construction", () => {
  it("validates external CLI kind values", () => {
    assert.equal(isExternalCliKind("codex"), true);
    assert.equal(isExternalCliKind("claude"), true);
    for (const value of ["codexx", "", null, undefined, 1]) assert.equal(isExternalCliKind(value), false);
  });
  it("preserves prompt text while giving each Codex submission a distinct receipt", () => {
    const text = 'continue\n<!-- user text -->\r\n$(echo untouched)\n';
    const first = prepareExternalPrompt("codex", text);
    const second = prepareExternalPrompt("codex", text);
    assert.notEqual(first, second);
    assert.match(first, /^<!-- pi-subagent-input:[0-9a-f-]{36} -->\n/);
    assert.equal(first.slice(first.indexOf("\n") + 1), text);
    assert.equal(prepareExternalPrompt("claude", text), text);
  });
  for (const kind of ["codex", "claude"] as const) {
    it(`${kind}: executes literal multiline prompt data and resumes the saved ID`, () => fixture(kind, f => {
      const bin = join(f.dir, "fake-cli");
      const argsFile = join(f.dir, "args.json");
      writeFileSync(bin, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o700 });
      const key = kind === "codex" ? "PI_CODEX_BIN" : "PI_CLAUDE_BIN";
      const old = process.env[key]; process.env[key] = bin;
      try {
        const prompt = 'resume\n"single\'quote" $(touch SHOULD_NOT_EXIST) `touch SHOULD_NOT_EXIST`';
        const taskFile = join(f.dir, "task.md"); writeFileSync(taskFile, prompt);
        f.session.nativeId = "native-id";
        const command = prepareExternalLaunch({ session: f.session, sessionFile: f.sessionFile,
          resultFile: f.resultFile, taskFile, hookFile: join(f.dir, "absent-hook"),
          settingsFile: join(f.dir, "settings.json"), resume: true });
        execFileSync("bash", ["-c", command], { stdio: "ignore" });
        const args = JSON.parse(readFileSync(argsFile, "utf8"));
        assert.equal(args.at(-1), prompt);
        assert.ok(args.includes("native-id"));
        assert.equal(existsSync(join(f.dir, "SHOULD_NOT_EXIST")), false);
        if (kind === "codex") { assert.equal(args[0], "resume"); assert.ok(!args.includes("exec")); }
        else {
          assert.ok(!args.includes("--model"), "cc-switch controls the default model");
          const settings = JSON.parse(readFileSync(join(f.dir, "settings.json"), "utf8"));
          assert.equal(settings.env, undefined, "hook settings must not replace cc-switch credentials or model aliases");
        }
      } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
    }));
  }
});
