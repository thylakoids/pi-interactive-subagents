/**
 * Terminal structured-output tool, loaded into workflow subagents that were
 * started with a `schema`.
 *
 * A subagent's final text is free-form, so a workflow that asks for structured
 * data cannot parse the summary and hope. Instead the child is given a tool
 * whose parameters *are* the schema: the model must call it to finish, the
 * arguments are validated by pi's tool layer, and the result is written to a
 * sidecar file the workflow reads. `agent()` then returns a validated object
 * rather than prose.
 *
 * Loaded via `-e <this file>` with `PI_SUBAGENT_SCHEMA_FILE` and
 * `PI_SUBAGENT_RESULT_FILE` set by the parent; it is inert without them.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync } from "node:fs";

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
};

/** Minimal JSON Schema → TypeBox conversion for the subset workflows use. */
function toTypeBox(schema: JsonSchema): any {
  const withDesc = (value: any) =>
    typeof schema.description === "string" ? { ...value, description: schema.description } : value;

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return Type.Union(schema.enum.map((value) => Type.Literal(value as any)));
  }

  switch (schema.type) {
    case "object": {
      const properties: Record<string, any> = {};
      const required = new Set(schema.required ?? []);
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        const converted = toTypeBox(child);
        properties[key] = required.has(key) ? converted : Type.Optional(converted);
      }
      return Type.Object(properties, { additionalProperties: false });
    }
    case "array":
      return Type.Array(schema.items ? toTypeBox(schema.items) : Type.Unknown());
    case "number":
      return withDesc(Type.Number());
    case "integer":
      return withDesc(Type.Integer());
    case "boolean":
      return withDesc(Type.Boolean());
    case "null":
      return Type.Null();
    default:
      return withDesc(Type.String());
  }
}

export default function structuredOutputExtension(pi: ExtensionAPI): void {
  const schemaFile = process.env.PI_SUBAGENT_SCHEMA_FILE;
  const resultFile = process.env.PI_SUBAGENT_RESULT_FILE;
  if (!schemaFile || !resultFile) return;

  let schema: JsonSchema;
  try {
    schema = JSON.parse(readFileSync(schemaFile, "utf8")) as JsonSchema;
  } catch {
    return;
  }

  let parameters: any;
  try {
    parameters = toTypeBox(schema);
  } catch {
    // A schema we cannot express is still recorded, so the workflow reports a
    // clear contract error instead of silently returning free text.
    parameters = Type.Unknown();
  }

  pi.registerTool({
    name: "structured_output",
    label: "Structured Output",
    description:
      "Return the final result of this task as structured data. This is the ONLY way to finish: " +
      "call it exactly once with the complete, final answer. Do not also restate the answer in prose.",
    promptSnippet:
      "Finish by calling structured_output exactly once with the complete final result as structured data.",
    promptGuidelines: [
      "Call structured_output exactly once, as your last action.",
      "Give the complete final answer in the tool arguments; do not summarize in prose afterwards.",
      "Fill every required field with real content from your work — never placeholders.",
    ],
    parameters,
    async execute(_toolCallId, params) {
      try {
        writeFileSync(resultFile, JSON.stringify({ ok: true, value: params }));
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: `Could not record structured output: ${error?.message ?? error}` }],
          details: { recorded: false },
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: "Structured result recorded. You are done — stop now." }],
        details: { recorded: true },
      };
    },
  });
}
