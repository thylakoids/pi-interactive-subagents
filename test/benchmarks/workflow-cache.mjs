/** Real workflow cache replay probe: node test/benchmarks/workflow-cache.mjs */
import assert from 'node:assert/strict';
import { probeWorkflowCache } from '../helpers/workflow-cache-probe.ts';

for (const size of [1000, 5000, 10000]) {
  const result = await probeWorkflowCache(size);
  assert.equal(result.keyVisits, size, 'one index traversal; no per-call cache scans');
  console.log(JSON.stringify(result));
}
