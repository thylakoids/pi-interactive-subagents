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
 * check. They are intentionally red until that check lands in the manager.
 *
 * The schema is a closed root object: `verdict` is a required string, `meta` is
 * a free-form nested object, and unknown root keys are not allowed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";

import { workflowResultSchema, type JsonSchema } from "../pi-extension/subagents/workflow/structured-output.ts";
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
  it("rejects a sidecar value of the wrong type", async (t) => {
    const { view, call, resultFile } = await runWithSidecar(t, { verdict: 42 });

    assert.equal(
      Value.Check(workflowResultSchema(SCHEMA), { verdict: 42 }),
      false,
      "the predicate the parent must apply rejects this value",
    );
    assert.equal(call.status, "failed", "an invalid sidecar must fail the call");
    assert.match(String(call.error), /structured|schema/i);
    assert.equal(view.status, "completed", "the run itself can still finish");
    assert.equal(view.result, null, "the script sees null, not the invalid value");
    assert.deepEqual(
      JSON.parse(readFileSync(resultFile, "utf8")),
      { ok: true, value: { verdict: 42 } },
      "the original sidecar is kept for inspection",
    );
  });

  it("rejects a sidecar value missing a required field", async (t) => {
    const { view, call, resultFile } = await runWithSidecar(t, { meta: {} });

    assert.equal(Value.Check(workflowResultSchema(SCHEMA), { meta: {} }), false);
    assert.equal(call.status, "failed");
    assert.match(String(call.error), /structured|schema/i);
    assert.equal(view.result, null);
    assert.deepEqual(JSON.parse(readFileSync(resultFile, "utf8")), { ok: true, value: { meta: {} } });
  });

  it("rejects a sidecar value with an unknown root key", async (t) => {
    const { view, call, resultFile } = await runWithSidecar(t, { verdict: "v", extra: true });

    assert.equal(Value.Check(workflowResultSchema(SCHEMA), { verdict: "v", extra: true }), false);
    assert.equal(call.status, "failed", "the root object stays closed");
    assert.match(String(call.error), /structured|schema/i);
    assert.equal(view.result, null);
    assert.deepEqual(
      JSON.parse(readFileSync(resultFile, "utf8")),
      { ok: true, value: { verdict: "v", extra: true } },
    );
  });

  it("accepts a sidecar value whose nested free-form object carries any keys", async (t) => {
    const value = { verdict: "ok", meta: { custom: { deep: [1, 2] }, note: "free" } };
    const { view, call } = await runWithSidecar(t, value);

    assert.equal(Value.Check(workflowResultSchema(SCHEMA), value), true);
    assert.equal(call.status, "completed", call.error);
    assert.deepEqual(view.result, value, "an allowed value reaches the script unchanged");
  });
});
