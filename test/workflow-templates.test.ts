/** Execute shipped scripts through the real VM, scheduler and journal. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANONICAL_WORKFLOW } from '../pi-extension/subagents/workflow/authoring.ts';
import { BUNDLED_WORKFLOWS_DIR } from '../pi-extension/subagents/workflow/script.ts';
import { fixture } from './helpers/workflow.ts';

const source = (name: string) => readFileSync(join(BUNDLED_WORKFLOWS_DIR, name + '.js'), 'utf8');
const finding = (title: string, severity = 'high') => ({ title, severity, detail: title + ': src/a.ts:7' });

it('review-changes preserves failed dimensions, missing verdicts, rejections and severity order', async t => {
  const f = fixture(t, request => {
    if (request.name.includes('audit-broken')) return { error: 'review failed' };
    if (request.task.startsWith('独立审查')) return { value: { findings: request.task.includes('empty') ? [] : [
      finding('low', 'low'), finding('high'), finding('rejected'), finding('missing'),
    ] } };
    assert.match(request.task, /review-scope/);
    if (request.task.includes('missing: src')) return { error: 'verification failed' };
    return { value: { isReal: !request.task.includes('rejected: src'), reason: 'checked source' } };
  });
  const run = await f.manager.start({ source: source('review-changes'), args: {
    target: 'review-scope', dimensions: [{ name: 'main', agent: 'scout' }, 'empty', { name: 'broken' }],
  } });
  const view = await run.execute();
  assert.equal(view.status, 'completed', view.error);
  const result = view.result as any;
  assert.deepEqual(result.failedDimensions, ['broken']);
  assert.deepEqual(result.confirmed.map((entry: any) => entry.title), ['high', 'low']);
  assert.deepEqual(result.unverified, [finding('missing')]);
  assert.equal(result.rejected, 1);
  assert.equal(f.calls.length, 7, 'Empty or failed dimensions must not launch verifiers');
  assert.equal(f.calls.find(call => call.task.includes('审查维度——main'))!.agentType, 'scout');
});

it('migrate-files never verifies failed plans/applies, routes risky files and preserves verifier failures', async t => {
  const f = fixture(t, request => {
    const file = /目标文件：([^\n]+)/.exec(request.task)![1];
    if (request.task.startsWith('为一个文件')) {
      if (file === 'plan-fail') return { error: 'no plan' };
      if (file === 'empty-plan') return { value: { steps: [], risky: false } };
      return { value: { steps: ['step-for-' + file], risky: file === 'risky' } };
    }
    assert.match(request.task, new RegExp('step-for-' + file));
    if (request.task.startsWith('按给定')) return file === 'apply-fail' ? { error: 'apply failed' } : { text: 'applied' };
    assert.ok(!['plan-fail', 'empty-plan', 'apply-fail'].includes(file), 'Never verify an unapplied file');
    assert.equal(request.agentType, file === 'risky' ? 'worker' : 'scout');
    if (file === 'verify-fail') return { error: 'verification unavailable' };
    return { value: { ok: file !== 'issues', issues: file === 'issues' ? ['missed step'] : [] } };
  });
  const files = ['safe', 'risky', 'issues', 'plan-fail', 'empty-plan', 'apply-fail', 'verify-fail'];
  const view = await (await f.manager.start({ source: source('migrate-files'), args: { task: 'migration-task', files } })).execute();
  assert.equal(view.status, 'completed', view.error);
  const result = view.result as any;
  assert.deepEqual(result.verified.map((entry: any) => entry.file), ['safe', 'risky']);
  assert.deepEqual(result.unfinished, ['plan-fail', 'empty-plan', 'apply-fail']);
  assert.deepEqual(result.needsAttention.map((entry: any) => entry.file), ['issues', 'verify-fail']);
  assert.deepEqual(result.needsAttention[0].issues, ['missed step']);
  assert.match(result.needsAttention[1].issues[0], /验证没有完成/);
  assert.equal(f.calls.length, 16);
});

it('compare-options forwards only usable evidence and reports failed/omitted options', async t => {
  const f = fixture(t, request => {
    if (request.task.startsWith('Investigate')) {
      if (request.task.includes('Option: b')) return { error: 'failed b' };
      return { value: { option: 'a', summary: 'evidence-A', strengths: ['fast'], weaknesses: [], evidenceGaps: [] } };
    }
    assert.match(request.task, /evidence-A/);
    assert.match(request.task, /Failed investigations: \["b"\]/);
    assert.match(request.task, /Omitted because of maxCalls: \["c"\]/);
    return { text: 'a with caveats' };
  });
  const view = await (await f.manager.start({ source: source('compare-options'), args: { question: 'Choose', options: ['a', 'b', 'c'], maxCalls: 3 } })).execute();
  assert.equal(view.status, 'completed', view.error);
  const result = view.result as any;
  assert.deepEqual(result.failed, ['b']);
  assert.deepEqual(result.omitted, ['c']);
  assert.equal(result.findings[0].result.summary, 'evidence-A');
  assert.equal(result.comparison, 'a with caveats');
  assert.equal(result.complete, false);
  assert.equal(f.calls.length, 3);
});

it('verify-claims does not turn two agreeing votes and a failed voter into support', async t => {
  const f = fixture(t, request => {
    if (request.name.includes('verify-1-3')) return { error: 'missing voter' };
    const verdict = request.task.includes('Claim: disputed') && request.name.includes('-3') ? 'refuted' : 'supported';
    return { value: { verdict, evidence: 'independent source' } };
  });
  const view = await (await f.manager.start({ source: source('verify-claims'), args: { claims: ['missing', 'disputed', 'omitted'], maxCalls: 6 } })).execute();
  assert.equal(view.status, 'completed', view.error);
  const result = view.result as any;
  assert.deepEqual(result.results.map((entry: any) => entry.status), ['incomplete', 'disputed']);
  assert.deepEqual(result.results[0].counts, { supported: 2, refuted: 0, uncertain: 0 });
  assert.equal(result.results[0].votes[2], null);
  assert.deepEqual(result.omitted, ['omitted']);
  assert.equal(result.complete, false);
  assert.equal(f.calls.length, 6);
});

it('iterative-refinement passes the revised artifact to the next critic and stops on acceptance', async t => {
  let critiques = 0;
  const f = fixture(t, request => {
    if (request.task.startsWith('Critique')) {
      critiques++;
      assert.match(request.task, critiques === 1 ? /original-draft/ : /revised-artifact/);
      return { value: { accepted: critiques === 2, issues: critiques === 1 ? ['missing proof'] : [], feedback: 'add proof' } };
    }
    assert.match(request.task, /original-draft/);
    assert.match(request.task, /missing proof/);
    return { text: 'revised-artifact' };
  });
  const view = await (await f.manager.start({ source: source('iterative-refinement'), args: { task: 'Improve', initial: 'original-draft', maxCalls: 10 } })).execute();
  assert.equal(view.status, 'completed', view.error);
  const result = view.result as any;
  assert.equal(result.draft, 'revised-artifact');
  assert.equal(result.accepted, true);
  assert.equal(result.rounds, 2);
  assert.equal(result.reason, 'accepted');
  assert.equal(f.calls.length, 3);
});

for (const failure of ['critic', 'editor']) {
  it('iterative-refinement keeps the original draft on ' + failure + ' failure', async t => {
    const f = fixture(t, request => request.task.startsWith('Critique')
      ? failure === 'critic' ? { error: 'failed' } : { value: { accepted: false, issues: ['issue'], feedback: 'fix' } }
      : { error: 'failed' });
    const view = await (await f.manager.start({ source: source('iterative-refinement'), args: { task: 'Improve', initial: 'original' } })).execute();
    assert.equal(view.status, 'completed', view.error);
    assert.equal((view.result as any).draft, 'original');
    assert.equal((view.result as any).accepted, false);
    assert.equal((view.result as any).reason, failure + ' failed');
    assert.equal(f.calls.length, failure === 'critic' ? 1 : 2);
  });
}

for (const failedFetch of [false, true]) {
  it('deep-research counts actual calls, prioritizes claims and reports evidence gaps (failed fetch=' + failedFetch + ')', async t => {
    const f = fixture(t, request => {
      if (request.task.startsWith('Define')) return { value: { queries: [{ query: 'q1', reason: 'r1' }, { query: 'q2', reason: 'r2' }], scopeNotes: [] } };
      if (request.task.startsWith('Find candidate')) return { value: { sources: [{ url: 'https://example.org/source', title: 'primary', relevance: 'direct' }] } };
      if (request.task.startsWith('Fetch')) {
        if (failedFetch && request.task.includes('Search query: q2')) return { error: 'fetch failed' };
        return { value: { findings: ['read evidence'], claims: [
          { claim: 'low-priority', source: 'source-low', priority: 'low' },
          { claim: 'high-priority', source: 'source-high', priority: 'high' },
        ], gaps: [] } };
      }
      if (request.task.startsWith('Adversarially')) {
        assert.match(request.task, /Claim: high-priority/);
        return request.name.includes('-3') ? { error: 'voter failed' } : { value: { verdict: 'supported', evidence: 'source-high' } };
      }
      assert.match(request.task, new RegExp('Failed or empty research branches: ' + (failedFetch ? 1 : 0)));
      assert.match(request.task, /"status": "incomplete"/);
      return { text: 'answer with explicit gaps' };
    });
    const view = await (await f.manager.start({ source: source('deep-research'), args: { question: 'Research', maxCalls: 10 } })).execute();
    assert.equal(view.status, 'completed', view.error);
    const result = view.result as any;
    assert.equal(result.status, 'incomplete');
    assert.equal(result.evidence.length, failedFetch ? 1 : 2);
    assert.equal(result.verdicts.length, 1, 'Only admit complete three-voter groups with synthesis reserved');
    assert.equal(result.verdicts[0].status, 'incomplete');
    assert.equal(result.verdicts[0].claim.claim, 'high-priority');
    assert.equal(result.answer, 'answer with explicit gaps');
    assert.equal(f.calls.length, 9);
  });
}

it('deep-research does not synthesize when every fetch fails', async t => {
  const f = fixture(t, request => {
    if (request.task.startsWith('Define')) return { value: { queries: [{ query: 'q', reason: 'r' }], scopeNotes: [] } };
    if (request.task.startsWith('Find candidate')) return { value: { sources: [{ url: 'https://example.org', title: 'primary', relevance: 'direct' }] } };
    assert.ok(request.task.startsWith('Fetch'), 'No verifier or synthesis may run without evidence');
    return { error: 'fetch failed' };
  });
  const view = await (await f.manager.start({ source: source('deep-research'), args: { question: 'Research' } })).execute();
  assert.equal(view.status, 'completed', view.error);
  assert.equal((view.result as any).answer, null);
  assert.deepEqual((view.result as any).evidence, []);
  assert.equal((view.result as any).status, 'incomplete');
  assert.equal(f.calls.length, 3);
});

for (const verdict of ['supported', 'refuted', 'missing', 'uncertain']) {
  it('deep-research reports fully covered claim truthfully: ' + verdict, async t => {
    const f = fixture(t, request => {
      if (request.task.startsWith('Define')) return { value: { queries: [{ query: 'q', reason: 'r' }], scopeNotes: [] } };
      if (request.task.startsWith('Find candidate')) return { value: { sources: [{ url: 'https://example.org', title: 'primary', relevance: 'direct' }] } };
      if (request.task.startsWith('Fetch')) return { value: { findings: ['evidence'], claims: [{ claim: 'one', source: 'source', priority: 'high' }], gaps: [] } };
      if (request.task.startsWith('Adversarially')) return verdict === 'missing' && request.name.includes('-3')
        ? { error: 'missing vote' } : { value: { verdict: verdict === 'missing' ? 'supported' : verdict, evidence: 'source' } };
      assert.match(request.task, /Claims omitted because of maxCalls: \[\]/);
      return { text: 'synthesis' };
    });
    const view = await (await f.manager.start({ source: source('deep-research'), args: { question: 'Research', maxCalls: 8 } })).execute();
    assert.equal(view.status, 'completed', view.error);
    const result = view.result as any;
    assert.equal(result.status, verdict === 'missing' || verdict === 'uncertain' ? 'incomplete' : 'complete');
    assert.equal(result.verdicts[0].status, verdict === 'missing' ? 'incomplete' : verdict === 'uncertain' ? 'unverified' : verdict);
    assert.deepEqual(result.omittedClaims, []);
    assert.equal(f.calls.length, 7);
  });
}

it('canonical tool example preserves failed inspection/checks and skips unnecessary verification', async t => {
  const f = fixture(t, request => {
    if (request.task.startsWith('Inspect')) {
      if (request.task.includes('failed-inspect')) return { error: 'inspection failed' };
      return { value: { needsCheck: !request.task.includes('clean'), evidence: 'evidence:' + request.task } };
    }
    assert.match(request.task, /Evidence: evidence:Inspect/);
    assert.doesNotMatch(request.task, /clean|failed-inspect/);
    return request.task.includes('failed-check') ? { error: 'check failed' } : { text: 'independently verified' };
  });
  const view = await (await f.manager.start({ source: CANONICAL_WORKFLOW, args: { items: ['clean', 'flagged', 'failed-inspect', 'failed-check'] } })).execute();
  assert.equal(view.status, 'completed', view.error);
  const rows = view.result as any[];
  assert.deepEqual(rows.map(row => row.item), ['clean', 'flagged', 'failed-inspect', 'failed-check']);
  assert.equal(rows[0].finding.needsCheck, false);
  assert.equal(rows[0].verdict, undefined);
  assert.equal(rows[1].verdict, 'independently verified');
  assert.deepEqual(rows[2], { item: 'failed-inspect', status: 'unverified' });
  assert.equal(rows[3].verdict, null);
  assert.equal(f.calls.length, 6);
});

it('compare-options never synthesizes an all-failed investigation', async t => {
  const f = fixture(t, request => {
    assert.ok(request.task.startsWith('Investigate'), 'No synthesis without usable evidence');
    return { error: 'unavailable' };
  });
  const view = await (await f.manager.start({ source: source('compare-options'), args: { question: 'Choose', options: ['a', 'b'] } })).execute();
  assert.equal(view.status, 'completed', view.error);
  assert.deepEqual((view.result as any).failed, ['a', 'b']);
  assert.deepEqual((view.result as any).findings, []);
  assert.equal((view.result as any).comparison, null);
  assert.equal((view.result as any).complete, false);
  assert.equal(f.calls.length, 2);
});

for (const stop of ['rounds', 'tokens']) {
  it('iterative-refinement respects ' + stop + ' even when every critique requests another revision', async t => {
    const f = fixture(t, request => request.task.startsWith('Critique')
      ? { value: { accepted: false, issues: ['still wrong'], feedback: 'revise' }, tokens: 60 }
      : { text: 'revised' }, stop === 'tokens' ? { budgetTotal: 100 } : {});
    const view = await (await f.manager.start({ source: source('iterative-refinement'), args: {
      task: 'Improve', initial: 'original', maxRounds: 2, maxCalls: 4, minRemainingTokens: 50,
    } })).execute();
    assert.equal(view.status, 'completed', view.error);
    const result = view.result as any;
    assert.equal(result.accepted, false);
    assert.equal(result.rounds, stop === 'tokens' ? 1 : 2);
    assert.equal(result.reason, stop === 'tokens' ? 'token budget guard reached' : 'call limit reached');
    assert.equal(result.draft, stop === 'tokens' ? 'original' : 'revised');
    assert.equal(f.calls.length, stop === 'tokens' ? 1 : 3);
  });
}


it('review-changes admits findings by severity and names what the caps dropped', async t => {
  const f = fixture(t, request => {
    if (request.task.startsWith('独立审查')) {
      return { value: { findings: [finding('low', 'low'), finding('high'), finding('medium', 'medium')] } };
    }
    assert.match(request.task, /review-scope/);
    assert.match(request.task, /high: src\/a\.ts:7/);
    return { value: { isReal: true, reason: 'confirmed' } };
  });
  const view = await (await f.manager.start({ source: source('review-changes'), args: {
    target: 'review-scope', dimensions: [{ name: 'main' }, { name: 'extra' }], maxDimensions: 1, maxFindings: 1,
  } })).execute();
  assert.equal(view.status, 'completed', view.error);
  const result = view.result as any;
  assert.deepEqual(result.droppedDimensions, ['extra'], 'a dimension past the cap is named, not silently skipped');
  assert.deepEqual(result.droppedFindings, [{ dimension: 'main', count: 2 }]);
  assert.deepEqual(result.confirmed.map((entry: any) => entry.title), ['high'], 'admission ranks by severity, not by the model list order');
  assert.equal(f.calls.length, 2, 'one audit plus one verifier for the single admitted finding');
});

it('deep-research reports planned queries the call budget dropped', async t => {
  const f = fixture(t, request => {
    if (request.task.startsWith('Define')) return { value: { queries: [{ query: 'q1', reason: 'r1' }, { query: 'q2', reason: 'r2' }], scopeNotes: [] } };
    if (request.task.startsWith('Find candidate')) return { value: { sources: [{ url: 'https://example.org/source', title: 'primary', relevance: 'direct' }] } };
    if (request.task.startsWith('Fetch')) return { value: { findings: ['evidence'], claims: [], gaps: [] } };
    assert.match(request.task, /Planned queries omitted because of maxCalls: \["q2"\]/);
    return { text: 'answer' };
  });
  const view = await (await f.manager.start({ source: source('deep-research'), args: { question: 'Research', maxCalls: 8 } })).execute();
  assert.equal(view.status, 'completed', view.error);
  const result = view.result as any;
  assert.deepEqual(result.queries, ['q1']);
  assert.deepEqual(result.omittedQueries, ['q2']);
  assert.equal(result.status, 'incomplete', 'a planned query that never ran must not read as complete');
  assert.equal(f.calls.length, 4);
});

it('migrate-files carries the apply report to the verifier and the caller', async t => {
  const f = fixture(t, request => {
    if (request.task.startsWith('为一个文件')) return { value: { steps: ['step-one'], risky: false } };
    if (request.task.startsWith('按给定')) return { text: '改了 step-one；step-two 要改别的文件，没做' };
    assert.match(request.task, /执行者自述（未经核验/);
    assert.match(request.task, /step-two 要改别的文件，没做/);
    return { value: { ok: true, issues: [] } };
  });
  const view = await (await f.manager.start({ source: source('migrate-files'), args: { task: 'migration-task', files: ['a.ts'] } })).execute();
  assert.equal(view.status, 'completed', view.error);
  const result = view.result as any;
  assert.equal(result.verified.length, 1);
  assert.equal(result.verified[0].applyReport, '改了 step-one；step-two 要改别的文件，没做', 'the applier claim reaches the caller as a claim, not as a verdict');
  assert.equal(f.calls.length, 3);
});


it('deep-research never reports complete while a fetch reported evidence gaps', async t => {
  const f = fixture(t, request => {
    if (request.task.startsWith('Define')) return { value: { queries: [{ query: 'q1', reason: 'r1' }], scopeNotes: [] } };
    if (request.task.startsWith('Find candidate')) return { value: { sources: [{ url: 'https://example.org/source', title: 'primary', relevance: 'direct' }] } };
    if (request.task.startsWith('Fetch')) return { value: { findings: ['partial'], claims: [], gaps: ['the second source was unreachable'] } };
    return { text: 'answer that must state the gap' };
  });
  const view = await (await f.manager.start({ source: source('deep-research'), args: { question: 'Research', maxCalls: 8 } })).execute();
  assert.equal(view.status, 'completed', view.error);
  const result = view.result as any;
  assert.deepEqual(result.evidenceGaps, ['the second source was unreachable']);
  assert.equal(result.status, 'incomplete', 'a reported evidence gap must keep the run out of complete');
  assert.equal(result.answer, 'answer that must state the gap');
});

it('review-changes keeps string dimensions as focus with a generated name', async t => {
  const f = fixture(t, request => {
    if (request.task.startsWith('独立审查')) {
      assert.match(request.task, /审查维度——dimension-1：first focus/);
      return { value: { findings: [finding('one')] } };
    }
    assert.match(request.task, /维度 dimension-1/);
    return { value: { isReal: true, reason: 'confirmed' } };
  });
  const view = await (await f.manager.start({ source: source('review-changes'), args: {
    target: 'review-scope', dimensions: ['first focus', 'second focus'], maxDimensions: 1, maxFindings: 1,
  } })).execute();
  assert.equal(view.status, 'completed', view.error);
  const result = view.result as any;
  assert.deepEqual(result.droppedDimensions, ['dimension-2'], 'a dropped string dimension keeps its generated name');
  assert.equal(f.calls.length, 2, 'only the admitted dimension is audited; the dropped one never reaches a verifier');
  assert.equal(f.calls.some(call => /dimension-2/.test(call.task)), false, 'the dropped dimension never reaches an agent');
});
