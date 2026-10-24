/** Real Pi host, production tools/service, and actual native TUIs only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import extension, { __test__ } from '../../../pi-extension/subagents/index.ts';
import { readExternalSession } from '../../../pi-extension/subagents/external-cli.ts';
import { readScreen, surfaceExists } from '../../../pi-extension/subagents/tmux.ts';
import { WorkflowManager } from '../../../pi-extension/subagents/workflow/manager.ts';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export default function nativeLive(pi: any) {
  const dir = process.env.PI_NATIVE_LIVE_DIR!;
  assert.ok(process.env.CODEX_HOME && realpathSync(process.env.CODEX_HOME) === realpathSync(join(dir, 'codex-home')), 'native tests require their own CODEX_HOME');
  const tools = new Map<string, any>();
  const register = pi.registerTool;
  pi.registerTool = (tool: any) => { tools.set(tool.name, tool); register.call(pi, tool); };
  extension(pi);
  pi.registerTool = register;
  const save = (name: string, value: unknown) => writeFileSync(join(dir, name + '.json'), JSON.stringify(value, null, 2));
  const event = (name: string, value: unknown) => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ at: Date.now(), name, value }) + '\n');
  const contains = (file: string, text: string) => {
    try { return readFileSync(file, 'utf8').includes(text); }
    catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const running = (name: string) => [...__test__.runningSubagents.values()].find(child => child.name === name);
  const until = async (check: () => boolean, label: string) => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) { if (check()) return; await delay(200); }
    throw new Error('Timed out: ' + label);
  };
  const processState = (pid: number) => {
    assert.ok(Number.isInteger(pid) && pid > 0, 'shell tool must report a real PID');
    try { return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(); }
    catch (error: any) { if (error.status === 1) return ''; throw error; }
  };
  const prompt = (command: string, answer: string) => `Run exactly this shell command using your shell tool, then reply exactly ${answer}. Do not delegate.\n\`\`\`sh\n${command}\n\`\`\``;
  let manager: WorkflowManager | undefined;
  pi.on('session_start', () => save('ready', { pid: process.pid }));
  pi.on('session_shutdown', () => manager?.abortAll('native live cleanup'));
  pi.on('before_agent_start', (e: any) => ({ systemPrompt: e.systemPrompt + '\nAutomated native CLI probe. Acknowledge notifications briefly; never use tools or repair intentional failures. Slash commands drive the probe.' }));
  pi.registerCommand('native-live', { description: 'Explicit billed native TUI probe', handler: async (scenario: string, ctx: any) => {
    const service = (globalThis as any).__pi_interactive_subagents.workflow;
    const invoke = async (tool: string, args: any) => {
      const result = await tools.get(tool).execute('native-live', args, new AbortController().signal, undefined, ctx);
      assert.ok(!result.isError && !result.details?.error, JSON.stringify(result));
      return result.details;
    };
    try {
      if (scenario === 'conversation') {
        const name = 'native-conversation';
        const started = await invoke('subagent', { name, agent: 'native-interactive', task: 'Reply exactly NATIVE_START_OK. Do not call any tools.' });
        assert.equal(started.status, 'started');
        const child = running(name)!;
        assert.ok(child && surfaceExists(child.surface));
        await until(() => contains(`${child.sentinelFile}.latest`, 'NATIVE_START_OK'), 'native initial response');
        assert.match(readFileSync(`${child.sentinelFile}.latest`, 'utf8'), /NATIVE_START_OK/);
        const id = readExternalSession(child.sessionFile)!.nativeId;
        assert.ok(id, 'native hook reports identity');
        event('startup', { id, sessionFile: child.sessionFile });
        const message = 'Remember the token NATIVE_MEMORY_4829. Reply exactly NATIVE_MESSAGE_OK. Do not call tools.';
        assert.equal((await invoke('subagent_message', { name, message })).status, 'steered');
        await until(() => contains(`${child.sentinelFile}.latest`, 'NATIVE_MESSAGE_OK'), 'native message response');
        event('message', { id });
        service.stop(name);
        await until(() => !running(name), 'stopped native pane unregisters');
        assert.equal(surfaceExists(child.surface), false);
        event('abort', { id });
        const resumeName = 'native-resume';
        const seed = await service.spawn({ agentType: 'native-auto', name: resumeName,
          task: 'Remember the token NATIVE_MEMORY_4829. Reply exactly NATIVE_SEED_OK. Do not call tools.' });
        let seeded: any;
        void seed.completion.then(value => { seeded = value; });
        await until(() => !!seeded, 'native seed completion (including hook input acknowledgement)');
        assert.equal(seeded.exitCode, 0, seeded.error);
        assert.match(seeded.summary, /NATIVE_SEED_OK/);
        const resumeId = readExternalSession(seed.sessionFile)!.nativeId;
        assert.ok(resumeId);
        const resumed = await invoke('subagent_message', { name: resumeName, message: 'What token did I ask you to remember? Reply with only that token. Do not call tools.' });
        assert.equal(resumed.status, 'started');
        assert.equal(resumed.sessionFile, seed.sessionFile);
        const again = running(resumeName)!;
        assert.ok(again);
        await until(() => !running(resumeName), 'native resumed turn completes');
        assert.match(readFileSync(seed.sessionFile, 'utf8'), /NATIVE_MEMORY_4829/);
        const rows = readFileSync(seed.sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const answer = rows.filter(row => row.message?.role === 'assistant').at(-1);
        assert.match(JSON.stringify(answer?.message.content), /NATIVE_MEMORY_4829/);
        assert.equal(readExternalSession(seed.sessionFile)!.nativeId, resumeId);
        event('native-resume', { id: resumeId });
        save(scenario, { ok: true, checks: ['startup', 'message', 'abort', 'native-resume'] });
      } else if (scenario === 'workflow') {
        const options = { baseDir: join(dir, 'artifacts'), cwd: dir, agentDir: join(dir, '.pi'), sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId(), service };
        manager = new WorkflowManager(options);
        const source = `export const meta = {name:'native-journal',description:'Real native journal replay',agent:'native-auto'};\nconst first = await agent(${JSON.stringify(prompt('echo once >> saved', 'NATIVE_SAVED_OK'))}, {label:'saved'});\nconst second = await agent(${JSON.stringify(prompt('echo $$ > blocked-pid; echo started >> blocked; while ! test -f release; do sleep 0.2; done', 'NATIVE_RELEASE_OK'))}, {label:'blocked'});\nreturn {first,second};`;
        const run = await manager.start({ source, args: {}, reuse: 'none' });
        save('workflow-start', { runId: run.runId, runDir: run.runDir });
        const pending = run.execute();
        await until(() => existsSync(join(dir, 'blocked')), 'real native second command blocks');
        const oldToolPid = Number(readFileSync(join(dir, 'blocked-pid'), 'utf8').trim());
        const oldToolState = processState(oldToolPid);
        assert.ok(oldToolState && !oldToolState.startsWith('Z'), 'actual blocked shell tool is alive before Abort');
        event('workflow-tool-before-abort', { pid: oldToolPid, state: oldToolState });
        assert.equal(readFileSync(join(dir, 'saved'), 'utf8'), 'once\n');
        const first = run.view().calls.find((call: any) => call.label === 'saved')!;
        assert.equal(first.status, 'completed');
        const blocked = run.view().calls.find((call: any) => call.label === 'blocked')!;
        let blockedId = readExternalSession(blocked.sessionFile!)!.nativeId;
        if (!blockedId && process.env.PI_NATIVE_LIVE_KIND === 'codex') {
          // Codex notify supplies its ID only at turn completion. Observe the
          // real rollout for the still-running turn without changing config.
          for (const offset of [0, 86_400_000, -86_400_000]) {
            const day = new Date(Date.now() - offset).toISOString().slice(0, 10).split('-');
            const folder = join(process.env.CODEX_HOME!, 'sessions', ...day);
            if (!existsSync(folder)) continue;
            for (const file of readdirSync(folder).filter(file => file.endsWith('.jsonl'))) {
              const text = readFileSync(join(folder, file), 'utf8');
              const meta = JSON.parse(text.split('\n')[0]);
              if (meta.type === 'session_meta' && meta.payload.cwd === realpathSync(dir)
                && text.includes('echo started >> blocked')) blockedId = meta.payload.id;
            }
          }
        }
        assert.ok(blockedId, 'blocked native thread must be identified before abort');
        save('workflow-before-abort', run.view());
        const nativeId = readExternalSession(first.sessionFile!)!.nativeId;
        assert.ok(nativeId);
        run.abort('native live intentional abort');
        assert.equal((await pending).status, 'aborted');
        await until(() => ![...__test__.runningSubagents.values()].length, 'aborted workflow panes close');
        await until(() => {
          const state = processState(oldToolPid);
          return !state || state.startsWith('Z');
        }, 'Abort terminates actual native shell tool, not only its pane');
        event('workflow-tool-after-abort', { pid: oldToolPid, state: processState(oldToolPid) });
        assert.equal(JSON.parse(readFileSync(join(run.runDir, 'snapshot.json'), 'utf8')).status, 'aborted');
        writeFileSync(join(dir, 'release'), 'release');
        // A fresh manager must recover from the on-disk journal, not in-memory results.
        manager = new WorkflowManager(options);
        const resumed = await manager.resume(run.runId);
        const view = await resumed.execute();
        assert.equal(view.status, 'completed', view.error);
        assert.match(JSON.stringify(view.result), /NATIVE_SAVED_OK/);
        assert.match(JSON.stringify(view.result), /NATIVE_RELEASE_OK/);
        const retried = view.calls.find((call: any) => call.label === 'blocked')!;
        const retryId = readExternalSession(retried.sessionFile!)!.nativeId;
        assert.ok(retryId);
        assert.notEqual(retryId, blockedId, 'workflow retries unfinished native steps in a NEW conversation');
        save('workflow-completed', view);
        assert.equal(readFileSync(join(dir, 'saved'), 'utf8'), 'once\n', 'completed command must not replay');
        assert.equal(readFileSync(join(dir, 'blocked'), 'utf8'), 'started\nstarted\n');
        assert.equal(view.calls.find((call: any) => call.label === 'saved')!.sessionFile, first.sessionFile);
        const newToolPid = Number(readFileSync(join(dir, 'blocked-pid'), 'utf8').trim());
        assert.ok(Number.isInteger(newToolPid) && newToolPid > 0, 'retried shell tool records a real PID');
        assert.notEqual(newToolPid, oldToolPid, 'workflow resume executes in a different shell process');
        event('workflow-journal-resume', { runId: run.runId, blockedId, retryId, oldToolPid, newToolPid });
        const before = readFileSync(first.sessionFile!, 'utf8');
        assert.deepEqual(await service.focus(first.name!, first.sessionFile), { ok: true });
        const focused = running(first.name!)!;
        assert.ok(focused && surfaceExists(focused.surface));
        await until(() => {
          const screen = readScreen(focused.surface);
          return /Claude Code|OpenAI Codex/i.test(screen) && /[❯›]/u.test(screen);
        }, 'focused native TUI displays its native editor prompt');
        writeFileSync(join(dir, 'completed-focus.screen.txt'), readScreen(focused.surface));
        await delay(2000);
        assert.equal(readExternalSession(first.sessionFile!)!.nativeId, nativeId);
        assert.equal(readFileSync(first.sessionFile!, 'utf8'), before, 'Focus must not submit a new turn');
        assert.equal(readFileSync(join(dir, 'saved'), 'utf8'), 'once\n');
        event('completed-focus', { nativeId, surface: focused.surface });
        service.stop(first.name!);
        await until(() => !running(first.name!), 'focused pane closes');
        save(scenario, { ok: true, checks: ['workflow-abort', 'workflow-journal-resume', 'completed-focus'] });
      } else throw new Error('Unknown scenario');
    } catch (error: any) {
      for (const child of [...__test__.runningSubagents.values()]) {
        writeFileSync(join(dir, `failure-${child.id}.screen.txt`), readScreen(child.surface));
        service.stop(child.name);
      }
      manager?.abortAll('native live failure');
      save(scenario, { ok: false, error: error?.stack ?? String(error) });
    }
  } });
}
