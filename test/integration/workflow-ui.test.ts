import { integrationRuntime } from './runtime.ts';
/** Real terminal navigation and original-session Focus, without model calls. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { cleanupSession } from "./cleanup.ts";
import { shellEscape } from "../../pi-extension/subagents/tmux.ts";

const tmux = (args: string[]) => execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let available = true;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); } catch { available = false; }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, detail: () => string, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (check()) return; await delay(150); }
  assert.fail(detail());
}

describe("workflow tree terminal", { skip: !available, timeout: 90_000 }, () => {
  it("renders a centered tree, confirms actions, and reopens a completed agent in a real pane", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-workflow-ui-"));
    const session = `pi-ui-${process.pid}-${Date.now()}`;
    const root = resolve(import.meta.dirname, "../..");
    console.log("UI evidence: " + dir);
    t.after(() => cleanupSession(session, dir, { preserveArtifacts: true }));
    let pane = "";
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "settings.json"), JSON.stringify({ quietStartup: true, enableTerminalTitle: false }));
    pane = tmux(["new-session", "-d", "-s", session, "-x", "120", "-y", "42", "-P", "-F", "#{pane_id}"]);
    tmux(["set-option", "-w", "-t", session, "window-size", "manual"]);
    tmux(["resize-window", "-t", session, "-x", "120", "-y", "42"]);
    const runtime = integrationRuntime();
    const command = `cd ${shellEscape(dir)} && env PATH=${shellEscape(runtime.path)} PI_OFFLINE=1 PI_WORKFLOW_MAX_CONCURRENT_AGENTS=1 PI_CODING_AGENT_DIR=${shellEscape(join(dir, "config"))} PI_WORKFLOW_UI_FIXTURE_DIR=${shellEscape(dir)} ${shellEscape(runtime.executable)} -ne -ns -np -nc --no-mcp -e ${shellEscape(join(root, "test/integration/fixtures/workflow-ui.ts"))} --session ${shellEscape(join(dir, "parent.jsonl"))} 2>${shellEscape(join(dir, "startup-error.log"))}; status=$?; echo $status >${shellEscape(join(dir, "parent-exit.txt"))}; sleep 120`;
    tmux(["respawn-pane", "-k", "-t", pane, command]);
    const screen = () => execFileSync("tmux", ["capture-pane", "-p", "-t", pane], { encoding: "utf8" });
    const key = (...keys: string[]) => tmux(["send-keys", "-t", pane, ...keys]);
    const events = () => existsSync(join(dir, "events")) ? readFileSync(join(dir, "events"), "utf8") : "";
    await waitFor(() => existsSync(join(dir, "ready")) && screen().includes("Ctrl+Alt+W details"), screen);
    assert.match(screen(), /Subagents/);
    assert.match(screen(), /1.2k tokens/);
    assert.doesNotMatch(screen(), /\(workflow-subagent\)/);
    key("/tree-fixture", "Enter");
    await waitFor(() => screen().includes("╭─ Workflows"), screen);
    let captured = screen();
    const topIndex = captured.split("\n").findIndex(line => line.includes("╭─ Workflows"));
    assert.ok(topIndex > 0, "frame must have space above");
    assert.ok(captured.split("\n")[topIndex].indexOf("╭") > 0, "frame must have space on the left");
    assert.doesNotMatch(captured.slice(captured.indexOf("╭─ Workflows"), captured.indexOf("╯", captured.indexOf("╭─ Workflows"))), /tokens|settled|select ·/);
    key("M-C-w");
    await waitFor(() => !screen().includes("╭─ Workflows"), screen);
    key("M-C-w");
    await waitFor(() => screen().includes("╭─ Workflows"), screen);
    // Running call -> its actions -> Skip, cancel once, then confirm.
    key("l", "l", "j", "Enter");
    await waitFor(() => screen().includes("Skip call"), screen);
    key("M-C-w");
    await waitFor(() => !screen().includes("╭─ Skip"), screen);
    key("M-C-w");
    await waitFor(() => screen().includes("╭─ Workflows"), screen);
    assert.doesNotMatch(events(), /skip:/);
    key("Enter");
    await waitFor(() => screen().includes("Skip call"), screen);
    key("Enter");
    await waitFor(() => screen().includes("╭─ Workflows"), screen);
    assert.doesNotMatch(events(), /skip:/);
    key("Enter", "j", "Enter");
    await waitFor(() => events().includes("skip:running"), () => screen() + events());
    // The vanished Skip selection returns to the agent. Collapse and walk to Abort.
    key("h", "j", "j", "Enter");
    await waitFor(() => screen().includes("╭─ Abort workflow"), screen);
    key("j", "Enter");
    await waitFor(() => events().includes("abort"), () => screen() + events());
    const aborted = JSON.parse(readFileSync(join(dir, "aborted-view.json"), "utf8"));
    assert.equal(aborted.status, "aborted");
    assert.equal(aborted.progress, 1);
    assert.deepEqual(aborted.calls.map((call: any) => call.status), ["completed", "skipped", "aborted"]);
    const journal = readFileSync(join(aborted.runDir, "journal.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(journal.map(entry => entry.status), ["completed", "skipped", "aborted"]);
    key("Enter");
    await waitFor(() => screen().includes("╭─ Resume workflow"), screen);
    key("j", "Enter");
    await waitFor(() => events().includes("resume") && screen().includes("╭─ Workflows"), () => screen() + events());
    await delay(100);
    assert.equal(events().split("spawn:completed").length - 1, 1, "Resume reuses the completed result");
    assert.equal(events().split("spawn:running").length - 1, 2, "Resume retries the skipped call");
    // Reopen at 80 columns and verify all frame lines remain bounded.
    key("Escape");
    await waitFor(() => !screen().includes("╭─ Workflows"), screen);
    tmux(["resize-window", "-t", session, "-x", "80", "-y", "30"]);
    key("/tree-fixture", "Enter");
    await waitFor(() => screen().includes("╭─ Workflows"), screen);
    assert.ok(screen().split("\n").every(line => line.length <= 80));
    // From Abort -> queued -> skipped -> Verify -> completed Probe call.
    key("k", "k", "k", "k", "l", "l", "Enter");
    await waitFor(() => events().includes('focus:{"ok":true}'), () => screen() + events());
    const childPane = tmux(["display-message", "-p", "-t", session, "#{pane_id}"]);
    assert.notEqual(childPane, pane);
    const childScreen = () => tmux(["capture-pane", "-p", "-t", childPane]);
    await waitFor(() => childScreen().includes("ORIGINAL_AGENT_HISTORY"), childScreen);
    const childSession = readFileSync(join(dir, "completed.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(childSession.filter(entry => entry.type === "message" && entry.message.role === "user").length, 0, "Focus must not submit a prompt");
    captured = childScreen();
    assert.doesNotMatch(captured, /Error loading extension|Failed to load/);
    // Opening the same completed call again focuses the existing pane.
    key("/tree-fixture", "Enter");
    await waitFor(() => screen().includes("╭─ Workflows"), screen);
    key("Enter");
    await waitFor(() => events().split('focus:{"ok":true}').length === 3, () => screen() + events());
    assert.equal(tmux(["list-panes", "-s", "-t", session, "-F", "#{pane_id}"]).split("\n").length, 2);
    // Bare /subagent uses the same production Focus path for ordinary saved sessions.
    key("/subagent", "Enter");
    await waitFor(() => screen().includes("Focus subagent") && screen().includes("saved-second"), screen);
    key("Escape");
    await waitFor(() => !screen().includes("Focus subagent"), screen);
    assert.equal(tmux(["list-panes", "-s", "-t", session, "-F", "#{pane_id}"]).split("\n").length, 2, "cancel must not open a pane");
    key("/subagent", "Enter");
    await waitFor(() => screen().includes("Focus subagent"), screen);
    key("Down", "Enter");
    await waitFor(() => tmux(["list-panes", "-s", "-t", session, "-F", "#{pane_id}"]).split("\n").length === 3, screen);
    const secondPane = tmux(["display-message", "-p", "-t", session, "#{pane_id}"]);
    assert.notEqual(secondPane, childPane);
    await waitFor(() => tmux(["capture-pane", "-p", "-t", secondPane]).includes("SECOND_AGENT_HISTORY"), () => tmux(["capture-pane", "-p", "-t", secondPane]));
    const secondEntries = readFileSync(join(dir, "second.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(secondEntries.filter(entry => entry.type === "message" && entry.message.role === "user").length, 0);
    key("/subagent", "Enter");
    await waitFor(() => screen().includes("Focus subagent"), screen);
    key("Enter"); // First item is the already-open original child.
    await waitFor(() => tmux(["display-message", "-p", "-t", session, "#{pane_id}"]) === childPane, screen);
    assert.equal(tmux(["list-panes", "-s", "-t", session, "-F", "#{pane_id}"]).split("\n").length, 3);
  });
});
