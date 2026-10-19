/** Production Pi service only. All artifacts survive successful and failed runs. */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { processGroupOf, processGroupAlive, isSafeToSignal, killProcessGroup } from '../../helpers/readonly-process.ts';
import subagentsExtension from '../../../pi-extension/subagents/index.ts';
import { WorkflowManager } from '../../../pi-extension/subagents/workflow/manager.ts';

const script = (name: string, body: string) =>
  `export const meta = ${JSON.stringify({ name, description: 'Billed review regression', agent: 'worker' })}\n${body}`;
const prompt = (command: string) =>
  `Use bash to execute exactly this command once:\n\`\`\`sh\n${command}\n\`\`\`\nAfter success reply EXECUTED. Do not repeat the command.`;

export default function reviewLive(pi: any) {
  subagentsExtension(pi);
  const dir = process.env.PI_WORKFLOW_REVIEW_LIVE_DIR!;
  let manager: WorkflowManager | undefined;
  pi.on('session_start', () => writeFileSync(join(dir, 'ready'), 'ready'));
  pi.on('session_shutdown', () => manager?.abortAll('review live shutdown'));
  pi.registerCommand('review-live', {
    description: 'Explicitly requested billed workflow review probes',
    handler: async (_args: string, ctx: any) => {
      const options = {
        baseDir: join(dir, 'artifacts'), cwd: dir,
        sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId(),
        agentDir: process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME!, '.pi', 'agent'),
        service: (globalThis as any).__pi_interactive_subagents.workflow,
      };
      manager = new WorkflowManager(options);
      const checks: string[] = [];
      const save = (name: string, view: unknown) => {
        writeFileSync(join(dir, name + '.json'), JSON.stringify(view, null, 2));
        appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ at: Date.now(), name }) + '\n');
      };
      const execute = async (name: string, source: string, extra: Record<string, unknown> = {}) => {
        const run = await manager!.start({ source, args: {}, ...extra });
        const view = await run.execute();
        save(name, view);
        assert.equal(view.status, 'completed', view.error);
        assert.ok(view.calls.length > 0);
        for (const call of view.calls) assert.equal(call.status, 'completed', call.error);
        checks.push(name);
        return view;
      };
      // A short per-attempt ceiling is intentional. Require the first real bash
      // marker before accepting a timeout, so startup/provider latency cannot pass.
      const stallProbe = async (retry: boolean) => {
        const name = retry ? 'stall-retry' : 'stall-default';
        const command = "if test -f first.pid; then printf 'recovered\\n' >> recovered; else printf '%s\\n' \"$$\" > first.pid; sleep 90; printf 'leaked\\n' > leaked; fi";
        const task = 'Use bash exactly once with timeout 120 seconds to execute this command. Do not interrupt or background it.\n```sh\n'
          + command + '\n```\nAfter bash succeeds call structured_output with {"status":"recovered"}. Do not call structured_output while bash is running.';
        const source = script('review-live-' + name, `return await agent(${JSON.stringify(task)}, {
          label: '${name}', isolation: 'worktree', stallTimeoutMs: 30000,
          ${retry ? 'retries: 1,' : ''}
          schema: {type: 'object', required: ['status'], properties: {status: {enum: ['recovered']}}}
        });`);
        const run = await manager!.start({ source, args: {} });
        const execution = run.execute();
        let ended = false;
        void execution.then(() => { ended = true; }, () => { ended = true; });
        let pgid = 0;
        let first: any;
        let cwd = '';
        let pane = '';
        try {
          const deadline = Date.now() + 45_000;
          while (Date.now() < deadline && !ended) {
            const call = run.view().calls[0];
            if (call) {
              cwd = join(run.runDir, 'worktrees', call.callKey);
              if (call.sessionFile && existsSync(join(cwd, 'first.pid'))
                && /^\d+\s*$/.test(readFileSync(join(cwd, 'first.pid'), 'utf8'))) { first = call; break; }
            }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          assert.ok(first?.sessionFile, name + ': first attempt must execute bash before its ceiling expires');
          const pid = Number(readFileSync(join(cwd, 'first.pid'), 'utf8').trim());
          pgid = processGroupOf(pid) ?? 0;
          assert.ok(isSafeToSignal(pgid) && processGroupAlive(pgid), 'first command must still be running in its own group');
          const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).trim().split('\n');
          const parents = new Map<number, number>();
          for (const row of processes) {
            const match = row.trim().match(/^(\d+)\s+(\d+)\s+/);
            if (match) parents.set(Number(match[1]), Number(match[2]));
          }
          const ancestors = new Set<number>();
          for (let current = pid; current > 1 && !ancestors.has(current); current = parents.get(current) ?? 0) ancestors.add(current);
          const panes = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}'], { encoding: 'utf8' }).trim().split('\n');
          pane = panes.find(row => ancestors.has(Number(row.split(' ')[1])))?.split(' ')[0] ?? '';
          assert.ok(pane, 'first bash must belong to an actual production tmux pane');
          save(name + '-running', { first, cwd, pid, pgid, pane, groupAlive: true, processes });
          const view = await execution;
          save(name, view);
          assert.equal(view.status, 'completed', view.error);
          const journal = readFileSync(join(view.runDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
          assert.deepEqual(journal.map(row => row.status), retry ? ['failed', 'completed'] : ['failed']);
          assert.ok(journal.every(row => row.callKey === first.callKey));
          assert.match(journal[0].error ?? '', /stopped|timeout|ceiling|stall|limit/i);
          assert.equal(journal[0].sessionFile, first.sessionFile);
          if (retry) {
            assert.notEqual(journal[1].sessionFile, first.sessionFile);
            assert.deepEqual(view.result, { status: 'recovered' });
            assert.equal(readFileSync(join(cwd, 'recovered'), 'utf8'), 'recovered\n');
          } else {
            assert.equal(view.result, null);
            assert.equal(existsSync(join(cwd, 'recovered')), false);
          }
          const stoppedDeadline = Date.now() + 10_000;
          while (processGroupAlive(pgid) && Date.now() < stoppedDeadline) await new Promise(resolve => setTimeout(resolve, 50));
          const remainingPanes = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], { encoding: 'utf8' }).trim().split('\n');
          save(name + '-stopped', { pgid, pane, groupAlive: processGroupAlive(pgid), remainingPanes });
          assert.equal(processGroupAlive(pgid), false, 'timed-out bash group must be reaped');
          assert.ok(!remainingPanes.includes(pane), 'timed-out first pane must be closed');
          assert.equal(existsSync(join(cwd, 'leaked')), false);
          checks.push(name);
        } finally {
          if (!ended) run.abort('stall probe assertion failed');
          try { await execution; } finally {
            // Only signal the group attributed to this live command, never a
            // shared ancestor. Keep evidence of a production cleanup failure.
            if (pgid && isSafeToSignal(pgid) && processGroupAlive(pgid)) killProcessGroup(pgid);
          }
        }
      };
      try {
        assert.equal(options.service.isAvailable().ok, true);
        const source = script('review-live-cache', `return await agent(${JSON.stringify(prompt("printf 'effect\\n' >> cache-effects"))}, {label: 'original'});`);
        const first = await execute('fresh-first', source);
        const second = await execute('fresh-second', source);
        assert.notEqual(first.calls[0].sessionFile, second.calls[0].sessionFile);
        assert.equal(readFileSync(join(dir, 'cache-effects'), 'utf8'), 'effect\neffect\n');
        const reused = await execute('explicit-reuse', source, { reuse: 'auto' });
        assert.equal(reused.calls[0].cached, true);
        assert.equal(reused.calls[0].sessionFile, second.calls[0].sessionFile);
        manager = new WorkflowManager(options);
        const borrowedResume = await (await manager.resume(reused.runId)).execute();
        save('borrowed-resume', borrowedResume);
        assert.equal(borrowedResume.status, 'completed', borrowedResume.error);
        assert.equal(borrowedResume.calls[0].cached, true);
        assert.equal(borrowedResume.calls[0].sessionFile, second.calls[0].sessionFile);
        assert.equal(readFileSync(join(dir, 'cache-effects'), 'utf8'), 'effect\neffect\n');
        checks.push('borrowed-resume');
        const renamed = await (await manager.resume(second.runId, { source: source.replace("label: 'original'", "label: 'renamed'") })).execute();
        save('renamed-resume', renamed);
        assert.equal(renamed.status, 'completed', renamed.error);
        assert.equal(renamed.calls[0].label, 'renamed');
        assert.equal(renamed.calls[0].cached, true);
        assert.equal(renamed.calls[0].sessionFile, second.calls[0].sessionFile);
        assert.equal(renamed.calls[0].callKey, second.calls[0].callKey);
        assert.equal(readFileSync(join(dir, 'cache-effects'), 'utf8'), 'effect\neffect\n');
        checks.push('renamed-resume');

        const schema = { type: 'object', required: ['meta'], properties: { meta: { type: 'object' } } };
        const structured = await execute('nested-schema', script('review-live-schema',
          `return await agent(${JSON.stringify('Read schema-input.json with the read tool. Finish by calling structured_output with exactly the JSON object read from that file, including every nested field in meta. Do not return prose instead.')}, {schema: ${JSON.stringify(schema)}});`));
        assert.deepEqual(structured.result, JSON.parse(readFileSync(join(dir, 'schema-input.json'), 'utf8')));

        // Worktree location is the helper's public contract; retain it for host verification.
        {
          const isolatedSource = script('review-live-worktree',
            `return await agent(${JSON.stringify(prompt("printf 'isolated\\n' > tracked.txt; printf 'created\\n' > worktree-only.txt; printf 'once\\n' >> isolated-effects; pwd -P"))}, {isolation: 'worktree', label: 'isolated', retries: 0});`);
          const isolated = await execute('worktree', isolatedSource);
          const cwd = join(isolated.runDir, 'worktrees', isolated.calls[0].callKey);
          assert.equal(readFileSync(join(cwd, 'tracked.txt'), 'utf8'), 'isolated\n');
          assert.equal(readFileSync(join(cwd, 'worktree-only.txt'), 'utf8'), 'created\n');
          assert.equal(readFileSync(join(dir, 'tracked.txt'), 'utf8'), 'main-dirty\n');
          assert.equal(existsSync(join(dir, 'worktree-only.txt')), false);
          manager = new WorkflowManager(options);
          const replay = await (await manager.resume(isolated.runId, {
            source: isolatedSource.replace("label: 'isolated'", "label: 'renamed-isolated'"),
          })).execute();
          save('worktree-resume', replay);
          assert.equal(replay.status, 'completed', replay.error);
          assert.equal(replay.calls[0].cached, true);
          assert.equal(replay.calls[0].sessionFile, isolated.calls[0].sessionFile);
          assert.equal(readFileSync(join(cwd, 'isolated-effects'), 'utf8'), 'once\n');
          checks.push('worktree-resume');
        }
        // These are mandatory: missing manager integration must fail the suite.
        {
          await execute('nested-saved', script('review-live-parent',
            `return await workflow('review-live-child', {token: 'NESTED_REAL'});`));
          const limited = await manager.start({ source: script('review-live-depth',
            `return await workflow('review-live-recursive', {});`), args: {} });
          const view = await limited.execute();
          save('nested-limit', view);
          assert.equal(view.status, 'failed');
          assert.match(view.error ?? '', /Maximum nested workflow depth is one/);
          assert.doesNotMatch(view.error ?? '', /not supported by this build|not available/i);
          checks.push('nested-limit');
          const broken = await manager.start({ source: script('review-live-author',
            `return await workflow('review-live-broken', {});`), args: {} });
          const failure = await broken.execute();
          save('nested-author-error', failure);
          assert.equal(failure.status, 'failed');
          assert.match(failure.error ?? '', /REVIEW_LIVE_NESTED_AUTHOR_ERROR/);
          checks.push('nested-author-error');
        }
        await stallProbe(false);
        await stallProbe(true);
        writeFileSync(join(dir, 'report.json'), JSON.stringify({ ok: true, checks }, null, 2));
      } catch (error: any) {
        manager?.abortAll('review live failure');
        writeFileSync(join(dir, 'report.json'), JSON.stringify({ ok: false, checks, error: error?.stack ?? String(error) }, null, 2));
      }
    },
  });
}
