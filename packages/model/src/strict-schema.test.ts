import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { strictSchemaViolations } from "./strict-schema.js";
import { structuredTurnSchema } from "./structured.js";

const compliant = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "note"],
  properties: { ok: { type: "boolean" }, note: { type: ["string", "null"] } },
};

const golden = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./${name}.golden.json`, import.meta.url), "utf8"));

describe("strictSchemaViolations", () => {
  it("passes a schema that keeps the rule, nullable values included", () => {
    expect(strictSchemaViolations(compliant)).toEqual([]);
  });

  it("names a property left out of required, at that property", () => {
    expect(strictSchemaViolations({ ...compliant, required: ["ok"] })).toEqual([
      { path: "#/properties/note", clause: "required" },
    ]);
  });

  it("names an object that allows other properties, or does not say", () => {
    const silent = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    expect(strictSchemaViolations(silent)).toEqual([{ path: "#", clause: "additionalProperties" }]);
    expect(strictSchemaViolations({ ...compliant, additionalProperties: true })).toEqual([
      { path: "#", clause: "additionalProperties" },
    ]);
  });

  it("walks into items, anyOf, nested properties and definitions", () => {
    const nested = {
      type: "object",
      additionalProperties: false,
      required: ["list", "either"],
      properties: {
        list: { type: "array", items: { type: "object", properties: { a: { type: "string" } } } },
        either: { anyOf: [{ type: "object", additionalProperties: false, properties: { b: {} } }, { type: "null" }] },
      },
      $defs: { thing: { type: "object", additionalProperties: false, required: [], properties: { c: {} } } },
    };
    expect(strictSchemaViolations(nested)).toEqual([
      { path: "#/properties/list/items", clause: "additionalProperties" },
      { path: "#/properties/list/items/properties/a", clause: "required" },
      { path: "#/properties/either/anyOf/0/properties/b", clause: "required" },
      { path: "#/$defs/thing/properties/c", clause: "required" },
    ]);
  });
});

/**
 * The schemas this package itself puts on the wire, read from the goldens that
 * hold the bytes each transport sends: the API's two tools, Claude Code's
 * `--json-schema`, and the turn schema Codex sends as `outputSchema`, which is
 * the same function's. OpenCode's ACP carries no schema. The callers' submit
 * schemas are checked where they can all be imported, in
 * `apps/cli/src/provider-schemas.test.ts`.
 */
describe("every schema this package sends", () => {
  it("keeps the rule in the API's tools", () => {
    const captures = golden("anthropic") as Record<string, { body: { tools: Array<{ name: string; input_schema: unknown }> } }>;
    const tools = Object.values(captures).flatMap((capture) => capture.body.tools);
    expect(tools.map((tool) => tool.name)).toContain("read_file");
    for (const tool of tools) expect([tool.name, strictSchemaViolations(tool.input_schema)]).toEqual([tool.name, []]);
  });

  it("keeps the rule in Claude Code's --json-schema", () => {
    const invocations = golden("claude-cli") as Array<{ argv: string[] }>;
    const schemas = invocations.map(({ argv }) => JSON.parse(argv[argv.indexOf("--json-schema") + 1]!) as unknown);
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) expect(strictSchemaViolations(schema)).toEqual([]);
  });

  it("keeps the rule in the turn schema the CLI transports wrap a submit schema in", () => {
    expect(strictSchemaViolations(structuredTurnSchema(compliant))).toEqual([]);
    // The wrapper hands a broken submit schema on as it is, and the walk finds it there.
    expect(strictSchemaViolations(structuredTurnSchema({ ...compliant, required: ["ok"] }))).toEqual([
      { path: "#/properties/review/anyOf/0/properties/note", clause: "required" },
    ]);
  });
});
