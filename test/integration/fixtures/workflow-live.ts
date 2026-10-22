/** Live-provider probes: production service, real child sessions, unmodified templates. */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import subagentsExtension from '../../../pi-extension/subagents/index.ts';
import { WorkflowManager } from '../../../pi-extension/subagents/workflow/manager.ts';
import { RUN_LOCK_HELPER } from '../../../pi-extension/subagents/workflow/run-lock.ts';
import { BUNDLED_WORKFLOWS_DIR } from '../../../pi-extension/subagents/workflow/script.ts';
import { readSubagentLoadout } from '../../../pi-extension/subagents/session.ts';
import type { WorkflowRunView } from '../../../pi-extension/subagents/workflow/types.ts';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(200); }
  throw new Error('Timed out: ' + label);
}
const script = (name: string, body: string) =>
  'export const meta = ' + JSON.stringify({ name, description: 'Live provider regression', phases: ['Recon', 'Verify'] }) + '\n' + body;

// Keep prose punctuation outside executable commands, including file names.
const bashPrompt = (command: string, reply: string) =>
  'Use bash to execute exactly the command inside this fenced block (timeout 240 seconds):\n```sh\n' +
  command + '\n```\nAfter the command succeeds, reply ' + reply + '.';

export default function liveFixture(pi: any) {
  subagentsExtension(pi);
  const dir = process.env.PI_WORKFLOW_LIVE_DIR!;
  const record = (event: string, details: unknown = {}) => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ at: Date.now(), event, details }) + '\n');
  let manager: WorkflowManager;
  pi.on('session_start', () => writeFileSync(join(dir, 'ready'), 'ready'));
  pi.on('session_shutdown', () => manager?.abortAll('live test shutdown'));
  pi.registerCommand('live-workflows', {
    description: 'Run explicitly requested real-model workflow regression probes',
    handler: async (_args: string, ctx: any) => {
      const options = {
        baseDir: join(dir, 'artifacts'), cwd: dir,
        sessionFile: ctx.sessionManager.getSessionFile(),
        sessionId: ctx.sessionManager.getSessionId(),
        agentDir: process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME!, '.pi', 'agent'),
        service: (globalThis as any).__pi_interactive_subagents.workflow,
      };
      manager = new WorkflowManager(options);
      const saved: Record<string, unknown> = {};
      const save = (name: string, value: unknown) => {
        saved[name] = value;
        writeFileSync(join(dir, name + '.json'), JSON.stringify(value, null, 2));
      };
      const verifySessions = (view: WorkflowRunView) => {
        assert.equal(view.status, 'completed', view.error);
        assert.ok(view.calls.length > 0);
        for (const call of view.calls) {
          assert.equal(call.status, 'completed', call.label + ': ' + call.error);
          assert.ok(call.sessionFile && existsSync(call.sessionFile), 'Real child session must exist');
          const loadout = readSubagentLoadout(call.sessionFile!)!;
          assert.ok(loadout, 'Real workflow loadout must be persisted');
          assert.ok(loadout.toolAllowlist!.split(',').includes('ask_question'));
          if (loadout.readOnly) {
            assert.equal(loadout.spawnable, null);
            for (const writer of ['write', 'edit', 'bash', 'subagent']) assert.ok(!loadout.toolAllowlist!.split(',').includes(writer));
            assert.ok(loadout.toolAllowlist!.split(',').includes('verify_command'));
          } else if (call.agentType === 'worker') assert.deepEqual(loadout.spawnable, ['scout', 'researcher']);
          assert.equal(loadout.autoExit, true);
          assert.match(loadout.identity!, /Workflow execution contract/);
          assert.equal(loadout.model, process.env.PI_TEST_MODEL, 'Unpinned worker inherits the parent model');
          const tools = loadout.toolAllowlist!.split(',');
          for (const denied of ['workflow']) assert.ok(!tools.includes(denied), denied + ' must be unavailable');
          const rows = readFileSync(call.sessionFile!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
          const responses = rows.filter(row => row.type === 'message' && row.message?.role === 'assistant');
          assert.ok(responses.some(row => row.message.usage?.input > 0 || row.message.usage?.output > 0), 'Must contain billed provider response, not a scripted reply');
          assert.ok(responses.some(row => row.message.content?.some((part: any) => part.type === 'toolCall')), 'Child must actually use tools');
        }
      };
      try {
        assert.equal(options.service.isAvailable().ok, true, 'Production subagent service must be available');
        record('start', { model: process.env.PI_TEST_MODEL });
        const review = await manager.start({
          source: readFileSync(join(BUNDLED_WORKFLOWS_DIR, 'review-changes.js'), 'utf8'), reuse: 'none',
          args: { target: 'Only the uncommitted change to eligibility.cjs. Read CONTRACT.md: age 18 must be eligible. Inspect the diff and actual source, not this description alone.',
            dimensions: [{ name: 'boundary', focus: 'Check exactly the inclusive adult-age boundary against CONTRACT.md; report at most one independently reproducible correctness issue.' }] },
        });
        record('review-start', { runId: review.runId });
        const reviewExecution = review.execute();
        assert.equal(review.execute(), reviewExecution, 'Concurrent callers must share one real-model execution');
        const reviewed = await reviewExecution;
        assert.equal(await review.execute(), reviewed, 'Repeated execution must not relaunch completed children');
        save('review', reviewed);
        verifySessions(reviewed);
        const findings = (reviewed.result as any).confirmed;
        assert.ok(findings.length >= 1, 'The independently verified age-18 regression must be reported');
        assert.match(JSON.stringify(findings), /18|十八/);
        assert.match(JSON.stringify(findings), /eligibility/);
        assert.deepEqual((reviewed.result as any).failedDimensions, []);
        assert.deepEqual((reviewed.result as any).unverified, []);
        record('review-passed', { runId: review.runId, calls: reviewed.calls.length });

        const migration = await manager.start({
          source: readFileSync(join(BUNDLED_WORKFLOWS_DIR, 'migrate-files.js'), 'utf8'), reuse: 'none',
          args: { task: 'Make only these two changes: safe.cjs: rename the private local variable oldValue to newValue without changing outputs (non-risky). risky.cjs: make isAdult inclusive at age 18 by using >= 18 instead of > 18 (risky: exported behavior changes). Do not edit test.cjs. Do not stage or commit changes. Acceptance is the requested target-file edit and the named per-file test, not Git cleanliness, a commit, or reproducing historical baseline claims from another agent. Per-file verification is independent: for safe.cjs run node --test --test-name-pattern="stable double" test.cjs; for risky.cjs run node --test --test-name-pattern="inclusive boundary" test.cjs. Pipeline branches overlap, so the other file may not be migrated yet: do not classify a pending sibling change as failure of your target file. The caller independently runs the full node --test test.cjs suite after both branches finish; it must pass. Never modify eligibility.cjs or CONTRACT.md, and do not attribute their pre-existing problems to this migration.',
            files: ['safe.cjs', 'risky.cjs'] },
        });
        record('migration-start', { runId: migration.runId });
        const migrated = await migration.execute();
        save('migration', migrated);
        verifySessions(migrated);
        assert.deepEqual((migrated.result as any).unfinished, []);
        assert.deepEqual((migrated.result as any).needsAttention, []);
        assert.deepEqual((migrated.result as any).verified.map((entry: any) => entry.file), ['safe.cjs', 'risky.cjs']);
        const testOutput = execFileSync(process.execPath, ['--test', 'test.cjs'], { cwd: dir, encoding: 'utf8' });
        writeFileSync(join(dir, 'migration-node-test.log'), testOutput);
        assert.doesNotMatch(readFileSync(join(dir, 'safe.cjs'), 'utf8'), /\boldValue\b/);
        assert.match(readFileSync(join(dir, 'safe.cjs'), 'utf8'), /\bnewValue\b/);
        record('migration-passed', { runId: migration.runId, calls: migrated.calls.length });

        // Only agents create these markers. The host releases the slow branch
        // only after observing a genuine next-stage model response on fast.
        const gated = await manager.start({
          source: script('live-pipeline', `
            return await pipeline(args.items,
              item => agent(item === 'slow'
                ? ${JSON.stringify(bashPrompt("printf started > slow-start; while ! test -f release-slow; do sleep 0.2; done; printf ended > slow-end", "SLOW_RECON_DONE"))}
                : ${JSON.stringify(bashPrompt("while ! test -f slow-start; do sleep 0.2; done", "FAST_RECON_DONE"))},
                {label: 'recon-' + item, phase:'Recon'}),
              async (recon, item) => {
                if (!recon) throw new Error('Recon failed: ' + item);
                const checked = await agent(item === 'slow' ? ${JSON.stringify(bashPrompt("printf slow > slow-verify", "VERIFIED_slow"))} : ${JSON.stringify(bashPrompt("printf fast > fast-verify", "VERIFIED_fast"))}, {label:'verify-' + item, phase:'Verify'});
                return {item, recon, checked};
              });
          `), args: { items: ['slow', 'fast'] }, reuse: 'none',
        });
        record('pipeline-start', { runId: gated.runId });
        const pipelineExecution = gated.execute();
        try {
          await until(() => existsSync(join(dir, 'slow-start')), 'real slow agent enters its blocking tool');
          await until(() => existsSync(join(dir, 'fast-verify')), 'fast Verify while slow Recon remains blocked');
          const view = gated.view();
          assert.equal(view.calls.find(call => call.label === 'recon-slow')?.status, 'running');
          assert.equal(existsSync(join(dir, 'slow-end')), false);
          save('pipeline-overlap', view);
          record('pipeline-overlap-proven', { slow: 'running', fast: 'Verify tool executed' });
        } finally { writeFileSync(join(dir, 'release-slow'), 'release'); }
        const pipelined = await pipelineExecution;
        save('pipeline', pipelined);
        verifySessions(pipelined);
        assert.deepEqual((pipelined.result as any[]).map(row => row.item), ['slow', 'fast']);
        assert.match((pipelined.result as any[])[0].recon, /SLOW_RECON_DONE/);
        assert.ok((pipelined.result as any[]).every(row => row.checked));
        assert.equal(readFileSync(join(dir, 'slow-end'), 'utf8'), 'ended');
        for (const item of ['slow', 'fast']) assert.equal(readFileSync(join(dir, item + '-verify'), 'utf8'), item);
        record('pipeline-passed', { runId: gated.runId });

        const recovery = await manager.start({
          source: script('live-recovery', `
            const first = await agent(${JSON.stringify(bashPrompt("echo done >> completed-side-effect", "COMPLETED_ONCE"))}, {agent:'workflow-subagent', label:'completed', phase:'Recon'});
            if (!first) throw new Error('First child failed');
            const second = await agent(${JSON.stringify(bashPrompt("echo started >> resume-attempts; while ! test -f allow-resume; do sleep 0.2; done; echo resumed >> resumed-side-effect", "RESUMED_OK"))}, {label:'interrupted', phase:'Verify'});
            return {first, second, epoch: Date.now()};
          `), args: {}, reuse: 'none',
        });
        record('abort-start', { runId: recovery.runId });
        const execution = recovery.execute();
        await until(() => existsSync(join(dir, 'resume-attempts')), 'real second child blocks in bash before Abort');
        const originalCompleted = recovery.view().calls.find(call => call.label === 'completed')!;
        assert.equal(originalCompleted.status, 'completed');
        assert.equal(originalCompleted.agentType, 'worker', 'Legacy script alias must actually launch worker');
        const oldPane = recovery.view().calls.find(call => call.label === 'interrupted')!.name!;
        recovery.abort('live regression: explicit user abort');
        const aborted = await execution;
        save('aborted', aborted);
        assert.equal(aborted.status, 'aborted');
        assert.equal(aborted.progress, 1);
        assert.deepEqual(aborted.calls.map(call => call.status), ['completed', 'aborted']);
        assert.equal(existsSync(join(dir, 'resumed-side-effect')), false);
        const diskManager = new WorkflowManager(options);
        const disk = diskManager.inspect(recovery.runId)!;
        assert.equal(disk.progress, 1);
        assert.deepEqual(disk.calls.map(call => call.status), ['completed', 'aborted']);
        save('aborted-disk', disk);
        record('abort-passed', { runId: recovery.runId, stoppedChild: oldPane });

        const journal = join(aborted.runDir, 'journal.jsonl');
        renameSync(journal, journal + '.saved');
        mkdirSync(journal);
        await assert.rejects(new WorkflowManager(options).resume(recovery.runId), /EISDIR|directory/);
        rmdirSync(journal);
        renameSync(journal + '.saved', journal);
        const lock = join(aborted.runDir, 'lock');
        writeFileSync(lock, '{');
        utimesSync(lock, new Date(0), new Date(0));
        await assert.rejects(new WorkflowManager(options).resume(recovery.runId), /manual inspection/);
        unlinkSync(lock); // Repair only the deliberately corrupted legacy record above.
        const lockModule = new URL('../../../pi-extension/subagents/workflow/journal.ts', import.meta.url).href;
        const crashedOwner = spawnSync(process.execPath, ['--input-type=module', '-e', `
          const {acquireLock} = await import(${JSON.stringify(lockModule)});
          if (!acquireLock(${JSON.stringify(aborted.runDir)}).ok) throw new Error('live crash probe could not own the run');
          process.kill(process.pid, 'SIGKILL');
        `], {encoding:'utf8', timeout:10000});
        assert.equal(crashedOwner.signal, 'SIGKILL', crashedOwner.stderr);
        assert.equal(JSON.parse(readFileSync(lock,'utf8')).pid,crashedOwner.pid);
        const crashedHelper = spawnSync('python3', ['-c', RUN_LOCK_HELPER.replace(
          'os.fsync(stream.fileno())', 'os.fsync(stream.fileno()); os.kill(os.getpid(), 9)'),
          aborted.runDir, 'acquire', String(process.pid), 'crashed-live-probe'], {encoding:'utf8',timeout:10000});
        assert.equal(crashedHelper.signal,'SIGKILL',crashedHelper.stderr);
        assert.equal(existsSync(lock),false,'the crashed helper must leave an unpublished record, not an empty public lock');
        record('lock-crashes-injected', {ownerSignal:crashedOwner.signal,helperSignal:crashedHelper.signal});
        // No lock/gate deletion follows either crash: disk resume must recover it.

        writeFileSync(join(dir, 'allow-resume'), 'release');
        appendFileSync(join(aborted.runDir, 'journal.jsonl'), '{"type":"call","callKey":"interrupted-write');
        manager = diskManager; // Reload state rather than relying on in-memory cache.
        const resumed = await manager.resume(recovery.runId);
        await assert.rejects(new WorkflowManager(options).resume(recovery.runId), /locked/);
        const restored = await resumed.execute();
        save('resumed', restored);
        verifySessions(restored);
        assert.equal(restored.calls.find(call => call.label === 'completed')?.cached, true);
        assert.equal(restored.calls.find(call => call.label === 'completed')?.sessionFile, originalCompleted.sessionFile);
        assert.notEqual(restored.calls.find(call => call.label === 'interrupted')?.name, oldPane);
        assert.equal(restored.calls.find(call => call.label === 'interrupted')?.cached, undefined);
        assert.equal(readFileSync(join(dir, 'completed-side-effect'), 'utf8').trim(), 'done', 'Completed child must not execute its tool twice');
        assert.deepEqual(readFileSync(join(dir, 'resume-attempts'), 'utf8').trim().split('\n'), ['started', 'started']);
        assert.equal(readFileSync(join(dir, 'resumed-side-effect'), 'utf8').trim(), 'resumed');
        assert.match((restored.result as any).first, /COMPLETED_ONCE/);
        assert.match((restored.result as any).second, /RESUMED_OK/);
        const replayed = await (await new WorkflowManager(options).resume(recovery.runId)).execute();
        assert.equal(replayed.status, 'completed', replayed.error);
        assert.ok(replayed.calls.every(call => call.cached), 'Settlements after a torn journal tail survive another disk reload');
        assert.deepEqual(replayed.result, restored.result);
        assert.equal(readFileSync(join(dir, 'completed-side-effect'), 'utf8').trim(), 'done');
        assert.equal(readFileSync(join(dir, 'resumed-side-effect'), 'utf8').trim(), 'resumed');
        assert.deepEqual(readFileSync(join(dir, 'resume-attempts'), 'utf8').trim().split('\n'), ['started', 'started']);
        record('resume-passed', { runId: recovery.runId });
        writeFileSync(join(dir, 'report.json'), JSON.stringify({ ok: true, model: process.env.PI_TEST_MODEL, checks: Object.keys(saved) }, null, 2));
      } catch (error: any) {
        record('failed', { message: error?.message, stack: error?.stack });
        manager.abortAll('live regression failure');
        writeFileSync(join(dir, 'report.json'), JSON.stringify({ ok: false, error: error?.stack ?? String(error), checks: Object.keys(saved) }, null, 2));
      }
    },
  });
}
