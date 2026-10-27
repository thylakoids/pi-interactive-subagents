/**
 * Structured-output schema regression tests (issue #3).
 *
 * The bug: an object *without* a `properties` declaration was converted to a
 * closed empty object, so a nested free-form object like
 * `meta: { type: 'object' }` could only ever be `{}` - any key the author
 * allowed was rejected by the tool layer before the child could finish.
 *
 * The contract these tests keep:
 *  - a root object with declared properties stays closed unless the schema says
 *    otherwise (unchanged behaviour),
 *  - `required` and an *explicit* `additionalProperties` are honoured,
 *  - only an object that declares no properties at all becomes free-form,
 *  - unknown keys the schema allows are passed through, never rewritten.
 *
 * Everything goes through the extension's public surface: the schema file is
 * written, the extension registers its tool, and the registered parameters are
 * what the tool layer validates against.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";

import structuredOutputExtension, {
  workflowResultSchema,
  type JsonSchema,
} from "../pi-extension/subagents/workflow/structured-output.ts";

const rootWithMeta = {
  type: "object",
  properties: {
    verdict: { type: "string" },
    meta: { type: "object" },
  },
  required: ["verdict"],
};

/** Register the extension for one schema and hand its tool to the test. */
async function withExtension<T>(
  schema: unknown,
  run: (tool: any, resultFile: string) => T | Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "workflow-review-schema-"));
  const schemaFile = join(dir, "schema.json");
  const resultFile = join(dir, "result.json");
  writeFileSync(schemaFile, JSON.stringify(schema));
  const previousSchema = process.env.PI_SUBAGENT_SCHEMA_FILE;
  const previousResult = process.env.PI_SUBAGENT_RESULT_FILE;
  process.env.PI_SUBAGENT_SCHEMA_FILE = schemaFile;
  process.env.PI_SUBAGENT_RESULT_FILE = resultFile;
  try {
    const tools: any[] = [];
    structuredOutputExtension({ registerTool: (tool: any) => tools.push(tool) } as any);
    assert.equal(tools.length, 1, "the extension must register exactly one tool");
    return await run(tools[0], resultFile);
  } finally {
    if (previousSchema === undefined) delete process.env.PI_SUBAGENT_SCHEMA_FILE;
    else process.env.PI_SUBAGENT_SCHEMA_FILE = previousSchema;
    if (previousResult === undefined) delete process.env.PI_SUBAGENT_RESULT_FILE;
    else process.env.PI_SUBAGENT_RESULT_FILE = previousResult;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("structured output schemas", () => {
  it("keeps a nested object without properties free-form", async () => {
    // The regression: this used to be { type: 'object', properties: {},
    // additionalProperties: false }, so { meta: { any: 1 } } failed validation.
    await withExtension(rootWithMeta, async (tool, resultFile) => {
      assert.equal(existsSync(resultFile), false, "registration does not write a result");
      assert.equal(Value.Check(tool.parameters, { verdict: "v", meta: { any: 1, nested: { x: 2 } } }), true);
      assert.equal(Value.Check(tool.parameters, { verdict: "v", meta: {} }), true);
      assert.equal(Value.Check(tool.parameters, { verdict: "v" }), true, "meta stays optional");
      assert.equal(Value.Check(tool.parameters, { meta: {} }), false, "the root required field still applies");
      assert.equal(Value.Check(tool.parameters, { verdict: "v", unexpected: 1 }), false, "the declared root stays closed");

      const parentView = workflowResultSchema(rootWithMeta as JsonSchema);
      assert.deepEqual(
        JSON.parse(JSON.stringify(parentView)),
        JSON.parse(JSON.stringify(tool.parameters)),
        "the exported builder must match the schema the child tool registered",
      );
      assert.equal(Value.Check(parentView, { verdict: "v", meta: { any: 1 } }), true);
      assert.equal(Value.Check(parentView, { verdict: 1 }), false);
      assert.equal(
        Value.Check(tool.parameters, { verdict: "v", meta: { anything: { nested: [1, 2] } } }),
        true,
        "the registered tool must accept the free-form nested object",
      );

      const payload = { verdict: "v", meta: { custom: { keep: "me" }, list: [1, 2] } };
      await tool.execute("call-1", payload);
      const recorded = readFileSync(resultFile, "utf8");
      assert.deepEqual(JSON.parse(recorded), { ok: true, value: payload }, "the recorded value is exactly what the child sent");
      const rejected = await tool.execute("call-root-extra", { verdict: "v", unexpected: 1 });
      assert.equal(rejected.isError, true, "an unknown root key stays rejected after a valid result");
      assert.equal(rejected.details.recorded, false);
      assert.equal(readFileSync(resultFile, "utf8"), recorded, "rejection must preserve the recorded valid result");
    });
  });

  it("keeps declared objects closed and required-aware, including empty properties", async () => {
    const cases = [
      {
        name: "declared nested object",
        schema: {
          type: "object",
          properties: {
            finding: {
              type: "object", properties: { file: { type: "string" } }, required: ["file"],
            },
          },
          required: ["finding"],
        },
        values: [
          { value: { finding: { file: "a.ts" } }, valid: true, why: "declared field" },
          { value: { finding: {} }, valid: false, why: "required nested field" },
          { value: { finding: { file: "a.ts", extra: 1 } }, valid: false, why: "declared object stays closed" },
        ],
      },
      {
        // Only absent properties are free-form; an explicit empty set stays closed.
        name: "explicitly empty properties", schema: { type: "object", properties: {} },
        values: [
          { value: {}, valid: true, why: "empty object" },
          { value: { anything: 1 }, valid: false, why: "undeclared field" },
        ],
      },
    ];
    for (const { name, schema, values } of cases) {
      await withExtension(schema, (tool) => {
        for (const { value, valid, why } of values) {
          assert.equal(Value.Check(tool.parameters, value), valid, `${name}: ${why}`);
        }
      });
    }
  });

  it("honours explicit additionalProperties policies", async () => {
    const policies = [
      {
        name: "additionalProperties: true", additionalProperties: true,
        values: [
          { value: { verdict: "v", extra: { deep: true } }, valid: true },
          { value: { verdict: "v" }, valid: true },
        ],
      },
      {
        name: "additionalProperties: false", additionalProperties: false,
        values: [{ value: { verdict: "v", extra: 1 }, valid: false }],
      },
      {
        name: "additionalProperties: string schema", additionalProperties: { type: "string" },
        values: [
          { value: { verdict: "v", extra: "ok" }, valid: true },
          { value: { verdict: "v", extra: 1 }, valid: false },
        ],
      },
    ];
    for (const { name, additionalProperties, values } of policies) {
      await withExtension({ type: "object", properties: { verdict: { type: "string" } }, additionalProperties }, (tool) => {
        for (const { value, valid } of values) {
          assert.equal(Value.Check(tool.parameters, value), valid, `${name}: ${JSON.stringify(value)}`);
        }
      });
    }
  });

});

describe("parent-side and direct-call validation", () => {
  it('honours an empty additionalProperties schema as any JSON value', () => {
    const schema = workflowResultSchema({ type: 'object', properties: { meta: { type: 'object', additionalProperties: {} } }, required: ['meta'] });
    for (const value of [1, true, null, ['list'], { nested: 1 }]) {
      assert.equal(Value.Check(schema, { meta: { key: value } }), true);
    }
  });
  it("rejects a direct execute that does not satisfy the schema", async () => {
    await withExtension(rootWithMeta, async (tool, resultFile) => {
      const missing = await tool.execute("call-1", { meta: {} });
      assert.equal(missing.isError, true);
      assert.equal(missing.details.recorded, false);
      assert.match(String(missing.content[0].text), /does not match the schema/);
      assert.equal(existsSync(resultFile), false, "nothing may be recorded for an invalid value");

      const wrongType = await tool.execute("call-2", { verdict: 42 });
      assert.equal(wrongType.isError, true);
      assert.match(String(wrongType.content[0].text), /schema at \/verdict:.*must be string/);
      assert.equal(existsSync(resultFile), false);

      const extraRootKey = await tool.execute("call-3", { verdict: "v", extra: true });
      assert.equal(extraRootKey.isError, true, "an unknown root key stays rejected");
      assert.equal(existsSync(resultFile), false);

      const valid = await tool.execute("call-4", { verdict: "v", meta: { free: { form: true } } });
      assert.equal(valid.isError, undefined);
      assert.equal(valid.details.recorded, true);
      assert.deepEqual(
        JSON.parse(readFileSync(resultFile, "utf8")),
        { ok: true, value: { verdict: "v", meta: { free: { form: true } } } },
      );
    });
  });
});
