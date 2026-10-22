/**
 * Parent-side sidecar validation.
 *
 * A child tool layer validates `structured_output` arguments, but the sidecar
 * file is just a file: a stub (or a bypassing child) can write any JSON shape
 * into `result.json`. The parent must therefore re-validate the recorded value
 * against the same schema before handing it to the script.
 *
 * These tests drive the real VM and manager with a service stub that writes the
 * invalid value itself, so the only thing that can reject it is the parent-side
 * check, independently of child-side tool validation.
 *
 * The schema is a closed root object: `verdict` is a required string, `meta` is
 * a free-form nested object, and unknown root keys are not allowed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { type JsonSchema } from "../pi-extension/subagents/workflow/structured-output.ts";
import { fixture, script } from "./helpers/workflow.ts";

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string" },
    meta: { type: "object" },
  },
  required: ["verdict"],
};

const SOURCE = script(
  'return await agent("review", { label: "review", schema: ' + JSON.stringify(SCHEMA) + " });",
  "sidecar-validation",
);

/** Run one call whose stub writes `value` straight into the sidecar. */
async function runWithSidecar(t: any, value: unknown) {
  const f = fixture(t, () => ({ value }));
  const run = await f.manager.start({ source: SOURCE, args: {} });
  const view = await run.execute();
  const call = view.calls[0];
  const resultFile = f.calls[0].resultFile;
  assert.ok(resultFile, "a schema call must get a sidecar path");
  return { view, call, resultFile: resultFile! };
}

describe("parent-side sidecar validation", () => {
  for (const [reason, value] of [
    ['wrong type', { verdict: 42 }],
    ['missing required field', { meta: {} }],
    ['unknown root key', { verdict: 'v', extra: true }],
  ] as const) {
    it('rejects a sidecar value with ' + reason, async t => {
      const { view, call, resultFile } = await runWithSidecar(t, value);
      assert.equal(call.status, 'failed');
      assert.match(String(call.error), /structured|schema/i);
      assert.equal(view.status, 'completed');
      assert.equal(view.result, null, 'the script must not receive invalid output');
      assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), { ok: true, value },
        'keep the original sidecar for inspection');
    });
  }

  it("accepts a sidecar value whose nested free-form object carries any keys", async (t) => {
    const value = { verdict: "ok", meta: { custom: { deep: [1, 2] }, note: "free" } };
    const { view, call } = await runWithSidecar(t, value);

    assert.equal(call.status, "completed", call.error);
    assert.deepEqual(view.result, value, "an allowed value reaches the script unchanged");
  });
});
