/** Hook shared by Codex notify, Claude Stop/StopFailure, and the launch shell.
 * No dependencies, no global config edits, and no transcript directory scans.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function atomicJson(path, value) {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}
function tryCliRunLock(resultFile) {
  const lock = `${resultFile}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }
  return () => rmdirSync(lock);
}
function lockTimeout(resultFile) {
  return new Error(`Timed out acquiring CLI run lock: ${resultFile}.lock. The run may have an interrupted hook; resume it as a new run.`);
}
// Hooks run in their own process; the parent must use the asynchronous variant.
export function withCliRunLock(resultFile, action) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const release = tryCliRunLock(resultFile);
    if (release) {
      try { return action(); } finally { release(); }
    }
    if (Date.now() >= deadline) throw lockTimeout(resultFile);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
export async function withCliRunLockAsync(resultFile, action) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const release = tryCliRunLock(resultFile);
    if (release) {
      try { return await action(); } finally { release(); }
    }
    if (Date.now() >= deadline) throw lockTimeout(resultFile);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const normalizeInput = text => text.replace(/\r\n/g, '\n').trim();
function pendingInputs(resultFile, completed = []) {
  if (!existsSync(`${resultFile}.inputs.json`)) return [];
  const pending = JSON.parse(readFileSync(`${resultFile}.inputs.json`, 'utf8')).map(normalizeInput);
  for (const input of completed) {
    const index = pending.indexOf(normalizeInput(input));
    if (index >= 0) pending.splice(index, 1);
  }
  return pending;
}
// Keep the last answer even when the native process exits with work pending.
export function readCliExitResult(resultFile, exitCode, reason = '') {
  let latest = null;
  try { latest = JSON.parse(readFileSync(`${resultFile}.latest`, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pending = pendingInputs(resultFile, latest?.completedInputs);
  const summary = [latest?.summary, reason,
    pending.length ? `${pending.length} submitted prompt(s) still pending.` : ''].filter(Boolean).join('\n\n');
  return { summary: summary || `CLI exited with code ${exitCode} without a final response.`,
    exitCode: exitCode || (pending.length ? 1 : 0), nativeId: latest?.nativeId };
}
function acknowledgeInputs(resultFile, completed, inputs) {
  const pending = pendingInputs(resultFile, completed);
  for (const input of inputs) {
    if (typeof input !== 'string') continue;
    const index = pending.indexOf(normalizeInput(input));
    if (index < 0) continue;
    completed.push(input);
    pending.splice(index, 1);
  }
}
function claudeTranscriptInputs(event) {
  if (!event.transcript_path || !existsSync(event.transcript_path)) return [];
  const entries = readFileSync(event.transcript_path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  // Inputs after the final assistant entry may still be waiting for a turn.
  const lastAssistant = entries.findLastIndex(entry => entry.type === 'assistant');
  return entries.slice(0, lastAssistant + 1).filter(entry => !entry.isSidechain).flatMap(entry => {
    // Claude may absorb live input into the current turn as a queued_command
    // attachment, rather than creating a standalone user message.
    if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command' &&
        entry.attachment.origin?.kind === 'human' && entry.attachment.commandMode === 'prompt') {
      return typeof entry.attachment.prompt === 'string' && entry.uuid
        ? [{ id: entry.uuid, text: entry.attachment.prompt }] : [];
    }
    if (entry.type !== 'user' || entry.isMeta) return [];
    const content = entry.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
    return text && entry.uuid ? [{ id: entry.uuid, text }] : [];
  });
}
export function handleCliEvent(kind, sessionFile, resultFile, mode, event) {
  return withCliRunLock(resultFile, () => handleLockedEvent(kind, sessionFile, resultFile, mode, event));
}
function handleLockedEvent(kind, sessionFile, resultFile, mode, event) {
  const sidecar = `${sessionFile}.cli.json`;
  const session = JSON.parse(readFileSync(sidecar, 'utf8'));
  if (existsSync(resultFile)) return; // A completed run cannot be overwritten by shell exit.
  if (kind === 'exit') {
    const exitCode = Number(mode);
    const validExitCode = Number.isInteger(exitCode) ? exitCode : 1;
    atomicJson(resultFile, { ...readCliExitResult(resultFile, validExitCode), nativeId: session.nativeId });
    return;
  }
  if (kind !== session.kind) return;
  appendFileSync(`${resultFile}.events.jsonl`, JSON.stringify(event) + '\n', { mode: 0o600 });
  if (kind === 'codex') {
    if (event.type !== 'agent-turn-complete') return;
    // The native CLI also invokes notify for internal threads (e.g. title
    // generation). Only a turn responding to an actually submitted prompt
    // belongs to this run. Filter before accepting its native thread ID.
    if (session.nativeId && event['thread-id'] !== session.nativeId) return;
    if (!session.nativeId && existsSync(`${resultFile}.inputs.json`)) {
      const expected = JSON.parse(readFileSync(`${resultFile}.inputs.json`, 'utf8'));
      const inputs = event['input-messages'];
      if (!Array.isArray(inputs) || !inputs.some(input => typeof input === 'string' &&
        expected.some(prompt => normalizeInput(prompt) === normalizeInput(input)))) return;
    }
  }
  if (kind === 'claude' && event.hook_event_name === 'SessionStart') {
    if (event.session_id !== session.nativeId) return;
    // Resume history must not count as processing a prompt submitted in this run.
    if (!existsSync(`${resultFile}.claude-seen.json`)) {
      atomicJson(`${resultFile}.claude-seen.json`, claudeTranscriptInputs(event).map(input => input.id));
    }
    return;
  }
  if (kind === 'claude' && !['Stop', 'StopFailure'].includes(event.hook_event_name)) return;
  const nativeId = kind === 'codex' ? event['thread-id'] : event.session_id;
  if (typeof nativeId === 'string' && nativeId) {
    if (session.nativeId && session.nativeId !== nativeId) return;
    session.nativeId = nativeId;
    atomicJson(sidecar, session);
  }
  const failed = event.hook_event_name === 'StopFailure';
  let summary = (kind === 'codex' ? event['last-assistant-message'] : event.last_assistant_message) || '';
  // Older Claude versions omit last_assistant_message in Stop payloads.
  if (!failed && !summary && kind === 'claude' && event.transcript_path) {
    try {
      const entries = readFileSync(event.transcript_path, 'utf8').split('\n').filter(Boolean);
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = JSON.parse(entries[i]);
        if (entry.type !== 'assistant') continue;
        summary = entry.message?.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
        if (summary) break;
      }
    } catch {}
  }
  if (typeof summary !== 'string') summary = '';
  if (failed && !summary) summary = `Claude Code error: ${event.error_details || event.error || 'unknown'}`;
  const result = { summary, exitCode: failed ? 1 : 0, nativeId: session.nativeId };
  if (event.transcript_path) result.transcriptPath = event.transcript_path;
  const turnId = event['turn-id'];
  let previous = null;
  try { previous = JSON.parse(readFileSync(`${resultFile}.latest`, 'utf8')); } catch {}
  const completedTurns = previous?.completedTurns || [];
  if (turnId && completedTurns.includes(turnId)) return;
  const completedInputs = previous?.completedInputs || [];
  if (kind === 'codex' && Array.isArray(event['input-messages'])) {
    // Every submitted Codex prompt has a unique receipt. Match outstanding
    // receipts directly; cumulative history, turn-local inputs, compaction and
    // resume need no format detection or persistent history snapshot.
    acknowledgeInputs(resultFile, completedInputs, event['input-messages']);
  } else if (kind === 'claude' && !failed) {
    let seen = [];
    try { seen = JSON.parse(readFileSync(`${resultFile}.claude-seen.json`, 'utf8')); } catch {}
    const inputs = [];
    for (const input of claudeTranscriptInputs(event)) {
      if (seen.includes(input.id)) continue;
      seen.push(input.id);
      inputs.push(input.text);
    }
    acknowledgeInputs(resultFile, completedInputs, inputs);
    atomicJson(`${resultFile}.claude-seen.json`, seen);
  }
  if (turnId) completedTurns.push(turnId);
  const lines = readFileSync(sessionFile, 'utf8').trim().split('\n');
  const leaf = JSON.parse(lines.at(-1));
  appendFileSync(sessionFile, JSON.stringify({
    type: 'message', id: randomUUID(), parentId: leaf.id,
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: summary }],
      model: session.model || session.kind, provider: session.kind,
      stopReason: failed ? 'error' : 'stop', ...(failed ? { errorMessage: summary } : {}) },
  }) + '\n');
  atomicJson(`${resultFile}.latest`, { ...result, turnId, completedTurns, completedInputs });
  // Interactive profiles remain open until the user exits the native TUI.
  // A native turn can finish while follow-up prompts await the next turn.
  // Failure is terminal even if the transcript or pending-input ledger cannot
  // be read. Do not make reporting a native error depend on history parsing.
  if (failed || (mode === 'auto' && pendingInputs(resultFile, completedInputs).length === 0)) {
    atomicJson(resultFile, result);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [kind, sessionFile, resultFile, mode, payload] = process.argv.slice(2);
  try {
    const event = kind === 'exit' ? {} : JSON.parse(kind === 'codex' ? payload : readFileSync(0, 'utf8'));
    handleCliEvent(kind, sessionFile, resultFile, mode, event);
  } catch (error) {
    // Hook errors must be observable but must never block the CLI's own loop.
    console.error(`pi subagent hook: ${error.message}`);
    // Separate diagnostic: never overwrite a completion outside its lock.
    try { atomicJson(`${resultFile}.hook-error`, { errorMessage: `CLI hook failed: ${error.message}` }); }
    catch (reportError) { console.error(`pi subagent hook diagnostic: ${reportError.message}`); }
    process.exitCode = 1;
  }
}
