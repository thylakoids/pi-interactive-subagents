# Runtime performance and regression probes

The runtime keeps launch, resume, cancellation, sandboxing, and native CLI behavior while reducing repeated work on the parent event loop. The comparison baseline is commit `592fafa`. These probes measure host overhead, not model response time or total task duration.

| Probe | Baseline | Optimized | Scope |
| --- | ---: | ---: | --- |
| Status widget, 16 agents / 1,000 unchanged redraws | 147.84 ms | 0.059 ms | Median of seven samples; cached frames are reused until invalidation, resize, or a new second |
| Lock work, 20 acquire/release cycles: largest heartbeat gap | 1,475.92 ms | 6.44 ms | Same process, 5 ms heartbeat; total lock work stayed about 1,475 ms |
| Cleanup, 4,000 panes / 12,000 processes | 339.50 ms | 32.66 ms | Median of seven samples using deterministic subprocess fixtures; excludes tmux/process startup |
| 64 concurrent native exit pollers | 64 queries / 64 screen captures | 1 query / 0 screen captures | Only overlapping queries share a snapshot; later queries observe fresh pane state |

Results are illustrative single-machine measurements, not CI latency thresholds. The existing 50 MB session-summary and 500-run workflow-panel probes showed no material improvement; those paths were not changed. A repository-wide 50% speedup is not established.

Production source did not shrink by 25%. Compared with the baseline, this change adds 46 physical lines across `pi-extension` (about 0.36%). Workflow management itself removes four coordination maps and shrinks by 39 lines. The asynchronous cleanup, lock serialization, and bounded transcript handling require additional code elsewhere. Tests and documentation are excluded from these counts; formatting and comment removal are not optimization targets.

## Reproduce

Run from the repository root, with the same Node version and machine for both checkouts:

```sh
node --expose-gc test/benchmarks/runtime.mjs
node --expose-gc test/benchmarks/widget.mjs
node test/tmux-performance.bench.ts 592fafa
node test/benchmarks/workflow-cache.mjs
WORKFLOW_LOCK_BENCHMARK_BASELINE=/tmp/baseline-checkout \
  node --test test/workflow-lock-responsiveness.test.ts
```

The widget probe can be copied into an untouched baseline checkout and run there. The lock baseline directory must contain the baseline source and its dependencies. The tmux probe reads the specified Git revision directly and substitutes deterministic subprocess fixtures. No probe makes model calls.

The cache probe checks work rather than timing: construction visits each cached key once; replay performs no further cache-key traversal. The tests exercise legacy aliases, repeated calls, isolation, retries, and cold recovery through the real manager.

## Correctness boundaries

- Each workflow call owns its handle, cancellation signal, scheduling-slot release, and result waiter. Skip and Abort still settle pending launches immediately and stop handles that arrive later.
- Lock acquisition and release yield to the event loop. A per-path queue keeps ownership tokens and failed-release retries ordered. The kernel-lock helper and process identity checks are unchanged.
- Journal writes remain durable before successful results reach scripts. Recovery reads the journal before atomically replacing an edited script.
- Tree cleanup indexes ancestry once, keeps guardians alive, stops detached tools, and checks current window ownership before repairing layouts. The registry retains a child until cleanup completes; shutdown awaits pending cleanup.
- Claude flush verification, summary extraction, and input acknowledgement share one completed-turn snapshot. Unchanged transcript polls avoid rereading and reparsing history. If identical replies within one prompt span provide no distinct turn identity, the earliest matching answer is used conservatively; ambiguous later input remains pending.

## Remaining review findings

Synchronous journal flushes can still block settlement bursts. Making those asynchronous requires preserving the durable acknowledgement boundary, including cancellation and storage failures. Native prompt submission also spans terminal delivery and ledger persistence; a partial failure can leave delivery uncertain. Finally, an activity recorder that stops writing can leave a stale active snapshot; expiring ordinary long-running tools by age would be incorrect. These paths need separate behavioral contracts before further changes.

See [workflow regression tests](../test/WORKFLOWS.md) for fault injection and real terminal checks.
