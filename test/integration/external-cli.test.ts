/** Tool integration tests using real tmux and stand-in native TUIs; not real CLI end-to-end coverage. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension, { __test__ } from "../../pi-extension/subagents/index.ts";
import { readNameRegistry, writeSubagentLoadout } from "../../pi-extension/subagents/session.ts";
import { readExternalSession } from "../../pi-extension/subagents/external-cli.ts";
import { readScreen, pollForExit } from "../../pi-extension/subagents/tmux.ts";

let hasTmux = true;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); } catch { hasTmux = false; }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (check()) return; await wait(50); }
  throw new Error(`Timed out: ${label}`);
}

describe("native CLI tools in tmux", { skip: !hasTmux, timeout: 60000 }, () => {
  let dir: string;
  const muxSession = `pi-cli-test-${process.pid}`;
  const keys = ["TMUX", "TMUX_PANE", "PI_CODEX_BIN", "PI_CLAUDE_BIN", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_SHELL_READY_DELAY_MS"];
  const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const tools = new Map<string, any>();
  const messages: any[] = [];
  let ctx: any;
  const api: any = { on() {}, registerTool(t: any) { tools.set(t.name, t); },
    registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
    getAllTools() { return []; }, sendMessage(message: any, options: any) { messages.push({ message, options }); } };
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-native-tools-"));
    mkdirSync(join(dir, "agents"));
    mkdirSync(join(dir, "sessions"));
    const parentFile = join(dir, "sessions", "parent.jsonl");
    writeFileSync(parentFile, JSON.stringify({ type: "session", id: "parent" }) + "\n");
    ctx = { cwd: dir, sessionManager: { getSessionFile: () => parentFile,
      getSessionId: () => "parent", getSessionDir: () => join(dir, "sessions") } };
    const pane = execFileSync("tmux", ["new-session", "-d", "-s", muxSession,
      "-x", "160", "-y", "40", "-P", "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
    process.env.TMUX_PANE = pane;
    process.env.TMUX = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{socket_path},#{pid},0"], { encoding: "utf8" }).trim();
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    const fakeSource = `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), kind = require('node:path').basename(process.argv[1]);
const prompt = args.at(-1);
let hook, id;
if (kind === 'codex') {
  const notify = args.find(a => a.startsWith('notify='));
  hook = JSON.parse(notify.slice(7));
  id = args[0] === 'resume' ? args[args.indexOf('--')+1] : 'native-codex';
} else {
  const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1], 'utf8'));
  hook = settings.hooks.Stop[0].hooks[0].command;
  id = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id')+1];
}
const transcript = require('node:path').join(require('node:path').dirname(process.argv[1]),'native-'+id+'.jsonl');
function nativeEvent(event) {
  const result = cp.spawnSync('bash',['-c',hook],{input:JSON.stringify({...event,session_id:id,transcript_path:transcript})});
  if (result.status !== 0) process.stderr.write(result.stderr);
}
function accept(prompt) {
  if (kind !== 'claude') return;
  fs.appendFileSync(transcript,JSON.stringify({type:'user',uuid:require('node:crypto').randomUUID(),message:{content:prompt}})+'\\n');
}
if (kind === 'claude') nativeEvent({hook_event_name:'SessionStart'});
const taskText = text => text.startsWith('<!-- pi-subagent-input:') ? text.slice(text.indexOf('\\n')+1) : text;
let turn = 0, submissions = 0;
const history = [prompt];
function complete(text, inputs = [text.startsWith('RESULT:')?prompt:text]) {
  const event = kind === 'codex' ? {type:'agent-turn-complete','thread-id':id,'turn-id':String(++turn),'last-assistant-message':text,'input-messages':inputs}
    : {hook_event_name:'Stop',session_id:id,transcript_path:transcript,last_assistant_message:text,stop_hook_active:false};
  if (kind === 'claude') fs.appendFileSync(transcript,JSON.stringify({type:'assistant',uuid:require('node:crypto').randomUUID(),message:{content:[{type:'text',text}]}})+'\\n');
  const result = kind === 'codex' ? cp.spawnSync(hook[0], [...hook.slice(1), JSON.stringify(event)])
    : cp.spawnSync('bash',['-c',hook],{input:JSON.stringify(event)});
  if (result.status !== 0) process.stderr.write(result.stderr);
}
process.stdout.write('\\x1b[?2004hREADY\\n');
process.stdin.setRawMode(true); process.stdin.resume();
let input='';
process.stdin.on('data', data => {
  input += data.toString();
  if (input.includes('\\r')) {
    const message = input.replace(/\\x1b\\[20[01]~/g,'').replace(/\\r/g,''); input='';
    if (prompt.includes('REPEAT')) {
      const position = ++submissions;
      if (position === 1) complete('INITIAL REPEAT TURN', [prompt]);
      setTimeout(() => {
        history.push(message);
        complete('REPEAT '+position, prompt.includes('CUMULATIVE') ? history.slice() : [message]);
      }, position === 1 ? 700 : 2600);
    } else if (prompt.includes('QUEUED')) {
      complete('FIRST TURN', [prompt]);
      process.stdout.write('FIRST_DONE\\n');
      setTimeout(() => { accept(message); complete('QUEUED RESULT:'+taskText(message), [message]); }, 1800);
    } else { accept(message); complete(taskText(message), [prompt, message]); }
  }
});
if (prompt.includes('CRASH')) process.exit(7);
accept(prompt);
if (!prompt.includes('HOLD') && !prompt.includes('QUEUED') && !prompt.includes('REPEAT')) setTimeout(() => complete('RESULT:'+id+':'+taskText(prompt)), 50);
setInterval(() => {}, 1000);
`;
    for (const kind of ["codex", "claude"]) {
      const binary = join(dir, kind);
      writeFileSync(binary, fakeSource, { mode: 0o700 });
      process.env[kind === "codex" ? "PI_CODEX_BIN" : "PI_CLAUDE_BIN"] = binary;
      writeFileSync(join(dir, "agents", `test-${kind}.md`), `---\ncli: ${kind}\nauto-exit: true\n---\nNative ${kind} profile.\n`);
      writeFileSync(join(dir, "agents", `interactive-${kind}.md`), `---\ncli: ${kind}\nauto-exit: false\n---\nNative interactive profile.\n`);
    }
    extension(api);
  });
  after(() => {
    for (const running of __test__.runningSubagents.values()) running.abortController?.abort();
    try { execFileSync("tmux", ["kill-session", "-t", muxSession], { stdio: "ignore" }); } catch {}
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  for (const kind of ["codex", "claude"]) {
    it(`${kind}: spawn, mid-run multiline message, result, restart, and native resume`, async () => {
      messages.length = 0;
      const name = `native-${kind}`;
      const spawned = await tools.get("subagent").execute("spawn", { name, agent: `test-${kind}`, task: "HOLD" }, new AbortController().signal, undefined, ctx);
      assert.equal(spawned.details.status, "started", JSON.stringify(spawned));
      const running = [...__test__.runningSubagents.values()].find(r => r.name === name)!;
      assert.ok(running, "running native session registered");
      await until(() => /READY/.test(readScreen(running.surface)), "native editor ready");
      const message = 'line one\nline two $(touch NEVER_EXECUTE)';
      const steered = await tools.get("subagent_message").execute("steer", { name, message }, new AbortController().signal, undefined, ctx);
      assert.equal(steered.details.status, "steered");
      await until(() => messages.some(m => m.message.customType === "subagent_result"), "first result");
      const first = messages.find(m => m.message.customType === "subagent_result");
      assert.ok(first.message.content.includes(message), first.message.content);
      assert.equal(first.message.details.exitCode, 0);
      const file = first.message.details.sessionFile;
      assert.ok(first.message.details.sessionId);
      const nativeId = readExternalSession(file)!.nativeId;
      assert.ok(nativeId);
      // Reinitialize extension registrations to simulate the parent returning.
      extension(api);
      messages.length = 0;
      const resumed = await tools.get("subagent_message").execute("resume", { name, message: "follow-up" }, new AbortController().signal, undefined, ctx);
      assert.equal(resumed.details.status, "started", JSON.stringify(resumed));
      assert.equal(resumed.details.sessionFile, file);
      await until(() => messages.some(m => m.message.customType === "subagent_result"), "resumed result");
      const second = messages.find(m => m.message.customType === "subagent_result");
      assert.ok(second.message.content.includes(`RESULT:${nativeId}:follow-up`), second.message.content);
      assert.equal(readExternalSession(file)!.nativeId, nativeId);
      assert.equal(second.message.details.exitCode, 0);
      const entries = readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
      assert.deepEqual(entries.filter(e => e.type === "message").map(e => e.message.role), ["user", "user", "assistant", "user", "assistant"]);
    });
  }
  for (const kind of ["codex", "claude"]) it(`${kind}: waits for queued follow-ups across separate native turns`, async () => {
    messages.length = 0;
    await tools.get("subagent").execute("queued", { name: "queued", agent: `test-${kind}`, task: "QUEUED" }, new AbortController().signal, undefined, ctx);
    const running = [...__test__.runningSubagents.values()].find(r => r.name === "queued")!;
    await until(() => /READY/.test(readScreen(running.surface)), "queued editor ready");
    const response = await tools.get("subagent_message").execute("queued-steer", { name: "queued", message: "second task" }, new AbortController().signal, undefined, ctx);
    assert.equal(response.details.status, "steered");
    await until(() => /FIRST_DONE/.test(readScreen(running.surface)), "first turn completed");
    await wait(1100); // Longer than a watcher polling interval.
    assert.equal(messages.filter(m => m.message.customType === "subagent_result").length, 0);
    assert.ok(__test__.runningSubagents.has(running.id));
    assert.match(readScreen(running.surface), /FIRST_DONE/);
    await until(() => messages.some(m => m.message.customType === "subagent_result"), "queued turn result");
    const result = messages.find(m => m.message.customType === "subagent_result").message;
    assert.equal(result.details.exitCode, 0);
    assert.match(result.content, /QUEUED RESULT:second task/);
  });
  for (const history of ["turn-local", "cumulative"]) {
    it(`codex: repeated queued messages complete with ${history} callbacks`, async () => {
      messages.length = 0;
      const name = `repeat-${history}`;
      await tools.get("subagent").execute("repeat", { name, agent: "test-codex",
        task: history === "cumulative" ? "REPEAT_CUMULATIVE" : "REPEAT_LOCAL" }, new AbortController().signal, undefined, ctx);
      const running = [...__test__.runningSubagents.values()].find(r => r.name === name)!;
      await until(() => /READY/.test(readScreen(running.surface)), "repeat editor ready");
      for (let n = 0; n < 2; n++) {
        const sent = await tools.get("subagent_message").execute(`repeat-${n}`, { name, message: "continue" }, new AbortController().signal, undefined, ctx);
        assert.equal(sent.details.status, "steered");
      }
      const inputs = JSON.parse(readFileSync(`${running.sentinelFile}.inputs.json`, "utf8"));
      assert.equal(inputs.length, 3);
      assert.notEqual(inputs[1], inputs[2], "identical tasks have different transport receipts");
      assert.ok(inputs[1].endsWith("\ncontinue") && inputs[2].endsWith("\ncontinue"));
      await until(() => {
        try { return JSON.parse(readFileSync(`${running.sentinelFile}.latest`, "utf8")).summary === "REPEAT 1"; }
        catch { return false; }
      }, "first repeated task completed");
      await wait(1100);
      assert.equal(messages.filter(m => m.message.customType === "subagent_result").length, 0);
      assert.ok(__test__.runningSubagents.has(running.id));
      assert.match(readScreen(running.surface), /READY/);
      await until(() => messages.some(m => m.message.customType === "subagent_result"), "second repeated task completed");
      const result = messages.find(m => m.message.customType === "subagent_result").message;
      assert.equal(result.details.exitCode, 0);
      assert.match(result.content, /REPEAT 2/);
      const users = readFileSync(running.sessionFile, "utf8").trim().split("\n").map(l => JSON.parse(l))
        .filter(e => e.message?.role === "user");
      assert.deepEqual(users.slice(1).map(e => e.message.content[0].text), ["continue", "continue"]);
    });
  }
  it("returns a nonzero native launch exit instead of hanging", async () => {
    messages.length = 0;
    await tools.get("subagent").execute("crash", { name: "crashed", agent: "test-codex", task: "CRASH" }, new AbortController().signal, undefined, ctx);
    await until(() => messages.some(m => m.message.customType === "subagent_result"), "crash result");
    const result = messages.find(m => m.message.customType === "subagent_result").message;
    assert.equal(result.details.exitCode, 7);
    assert.match(result.content, /code 7/);
    assert.equal(__test__.runningSubagents.size, 0);
  });
  it("preserves the latest answer when an interactive native pane is forcibly closed", async () => {
    messages.length = 0;
    await tools.get("subagent").execute("interactive", { name: "interactive", agent: "interactive-claude", task: "first response" }, new AbortController().signal, undefined, ctx);
    const running = [...__test__.runningSubagents.values()].find(r => r.name === "interactive")!;
    await until(() => {
      try { return readFileSync(`${running.sentinelFile}.latest`, "utf8").includes("first response"); } catch { return false; }
    }, "interactive response");
    await wait(1100);
    assert.equal(messages.filter(m => m.message.customType === "subagent_result").length, 0);
    assert.ok(__test__.runningSubagents.has(running.id));
    execFileSync("tmux", ["kill-pane", "-t", running.surface]);
    await until(() => messages.some(m => m.message.customType === "subagent_result"), "closed-pane result");
    const result = messages.find(m => m.message.customType === "subagent_result").message;
    assert.equal(result.details.exitCode, 1);
    assert.match(result.content, /first response/);
    assert.equal(__test__.runningSubagents.size, 0);
  });

  const panes = () => execFileSync("tmux", ["list-panes", "-s", "-t", muxSession, "-F", "#{pane_id}"], { encoding: "utf8" }).trim().split("\n").sort();
  it("finishes polling a destroyed pi pane without an exit sidecar", async () => {
    const pane = execFileSync("tmux", ["new-window", "-d", "-t", muxSession, "-P", "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
    execFileSync("tmux", ["kill-pane", "-t", pane]);
    const result = await pollForExit(pane, AbortSignal.timeout(2000), { interval: 10, sessionFile: join(dir, "missing.jsonl") });
    assert.equal(result.reason, "closed");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage!, /Pi subagent pane unavailable/);
  });
  it("closes a pi spawn pane when session seeding fails and releases its name", async () => {
    const sessions = join(dir, "sessions");
    writeFileSync(join(dir, "agents", "broken-pi.md"), "---\ntools: read\n---\nTest profile.\n");
    const before = panes();
    renameSync(sessions, `${sessions}.saved`);
    writeFileSync(sessions, "block session directory creation");
    try {
      await assert.rejects(tools.get("subagent").execute("broken", { agent: "broken-pi", task: "test" }, new AbortController().signal, undefined, ctx));
      assert.deepEqual(panes(), before);
      assert.equal(__test__.reservedNames.has("broken-pi"), false);
    } finally { rmSync(sessions); renameSync(`${sessions}.saved`, sessions); }

  });
  it("closes native spawn and resume panes when preparing run files fails", async () => {
    const runDir = join(dir, "sessions", "artifacts", "parent", "cli-runs");
    renameSync(runDir, `${runDir}.saved`);
    writeFileSync(runDir, "block directory creation");
    const before = panes();
    try {
      await assert.rejects(tools.get("subagent").execute("broken-native", { name: "broken-native", agent: "test-codex", task: "test" }, new AbortController().signal, undefined, ctx));
      assert.deepEqual(panes(), before);
      await assert.rejects(tools.get("subagent_message").execute("broken-resume", { name: "native-codex", message: "test" }, new AbortController().signal, undefined, ctx));
      assert.deepEqual(panes(), before);
      assert.equal(__test__.runningSubagents.size, 0);
    } finally { rmSync(runDir); renameSync(`${runDir}.saved`, runDir); }
  });
  it("closes a pi resume pane when identity preparation fails", async () => {
    const artifacts = join(dir, "sessions", "artifacts", "parent");
    const file = readNameRegistry(artifacts)["native-claude"].sessionFile;
    renameSync(`${file}.cli.json`, `${file}.cli.saved`);
    writeSubagentLoadout(file, { agent: "broken-pi", toolAllowlist: "read", model: null, thinking: null,
      systemPromptMode: "append", identity: "test identity", spawnable: null, autoExit: true, cwd: dir, agentDir: dir });
    const contextDir = join(artifacts, "context");
    mkdirSync(contextDir, { recursive: true });
    renameSync(contextDir, `${contextDir}.saved`);
    writeFileSync(contextDir, "block directory creation");
    const before = panes();
    try {
      await assert.rejects(tools.get("subagent_message").execute("broken-pi-resume", { name: "native-claude", message: "test" }, new AbortController().signal, undefined, ctx));
      assert.deepEqual(panes(), before);
      assert.equal(__test__.runningSubagents.size, 0);
    } finally {
      rmSync(contextDir); renameSync(`${contextDir}.saved`, contextDir);
      renameSync(`${file}.cli.saved`, `${file}.cli.json`); rmSync(`${file}.loadout.json`);
    }
  });

});
